import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test,type TestContext} from 'node:test';
import {SSDTrialHistory,trialHistoryEntry} from '../history.ts';
import {fixedProbeDiagnostic} from '../probes.ts';
import type {ExperimentalTrial} from '../memory.ts';

async function fixture(t:TestContext,limits?:{maxEntries:number;maxBytes:number}){
  const directory=await mkdtemp(path.join(tmpdir(),'ssd-trial-history-'));t.after(()=>rm(directory,{recursive:true,force:true}));const history=new SSDTrialHistory(directory,limits);await history.load();return {directory,history};
}
function trial(state:ExperimentalTrial['state']='failed',withProbe=true):ExperimentalTrial{
  const id=randomUUID(),digest='a'.repeat(64),templateDigest='b'.repeat(64),engineDigest='c'.repeat(64),profileSignature='exact-profile';
  return {id,mode:'ssd-experts',model:'fixture:moe',state,startedAt:new Date().toISOString(),profileSignature,digest,artifactSetDigest:digest,templateDigest,engineDigest,patchDigest:'d'.repeat(64),probePassed:false,toolProbePassed:false,error:state==='failed'?{code:'EXPERIMENTAL_CHAT_PROBE_FAILED',message:'The fixed probe ended without its required response.'}:null,resourceBudgetBytes:6*1024**3,mappedBytes:null,lazyEligibleBytes:null,measurements:{sampledAt:new Date().toISOString(),residentBytes:4*1024**3,rssBytes:3*1024**3,physicalFootprintBytes:4*1024**3,availableMemoryBytes:5*1024**3,pressure:'warning'},progress:{stage:state==='loading'?'verifying':'probing',message:'Actual retained preparation stage.'},...(withProbe?{probes:{chat:fixedProbeDiagnostic('chat',{choices:[{finish_reason:'length',message:{content:'',reasoning_content:'Actual fixed-probe output.'}}],usage:{completion_tokens:16}},16,false,{model:'fixture:moe',digest,templateHash:templateDigest,runtime:engineDigest,profileSignature,trialId:id})}}:{})};
}

test('failed fixed-probe evidence survives reopen with its exact binding and unobserved checks',async t=>{
  const {directory,history}=await fixture(t),failed=trial();await history.record(failed);const next=new SSDTrialHistory(directory);await next.load();
  assert.equal(next.error,null);const result=next.snapshot()[0];assert.equal(result.state,'failed');assert.equal(result.checks.chat,'failed');assert.equal(result.checks.tools,'unverified');assert.deepEqual(result.probes,failed.probes);assert.equal(result.resources?.measurements?.physicalFootprintBytes,4*1024**3);assert.equal(result.engineDigest,failed.engineDigest);assert.equal(result.profileSignature,failed.profileSignature);
  result.probes!.chat!.content='Caller mutation';assert.equal(next.snapshot()[0].probes!.chat!.content,'','Status snapshots cannot mutate retained history.');assert.equal((await lstat(next.file)).mode&0o077,0);
});

test('interrupted preparation is durably recovered as incomplete without inventing checks',async t=>{
  const {directory,history}=await fixture(t);await history.record(trial('loading',false));const next=new SSDTrialHistory(directory);await next.load();const recovered=next.snapshot()[0];
  assert.equal(recovered.state,'incomplete');assert.equal(recovered.checks.chat,'unverified');assert.equal(recovered.checks.tools,'unverified');assert.equal(recovered.error?.code,'SSD_TRIAL_INTERRUPTED');assert.equal(recovered.progress?.stage,'verifying');assert(recovered.finishedAt);assert.equal(JSON.parse(await readFile(next.file,'utf8')).entries[0].state,'incomplete');
  const again=new SSDTrialHistory(directory);await again.load();assert.deepEqual(again.snapshot(),next.snapshot(),'Reopening again preserves the first interrupted outcome and its timestamp.');
});

test('cancelled attempts remain separate from failed and unverified attempts',async t=>{
  const {directory,history}=await fixture(t);const cancelled=trial('cancelled',false);cancelled.finishedAt=new Date().toISOString();await history.record(cancelled);await history.record(trial());const next=new SSDTrialHistory(directory);await next.load();assert.deepEqual(next.snapshot().map(e=>e.state),['failed','cancelled']);assert.equal(next.snapshot()[1].error,null);assert.equal(next.snapshot()[1].checks.chat,'unverified');
});

test('mismatched fixed-probe identities are rejected without corrupting existing history',async t=>{
  const {history}=await fixture(t);await history.record(trial());const original=await readFile(history.file,'utf8'),invalid=trial();invalid.probes!.chat!.binding.runtime='e'.repeat(64);await history.record(invalid);assert.equal(history.error?.code,'SSD_HISTORY_INVALID');assert.equal(history.snapshot().length,1);assert.equal(await readFile(history.file,'utf8'),original);
});

test('history is count and byte bounded, newest-first, with atomic private writes',async t=>{
  const {directory,history}=await fixture(t,{maxEntries:3,maxBytes:4500}),attempts=Array.from({length:10},()=>trial());await Promise.all(attempts.map(a=>history.record(a)));await history.drain();const entries=history.snapshot();assert(entries.length>=1&&entries.length<=3);assert.equal(entries[0].id,attempts.at(-1)!.id);assert((await lstat(history.file)).size<=4500);assert.deepEqual(await readdir(directory),['ssd-trial-history.json']);const next=new SSDTrialHistory(directory,{maxEntries:3,maxBytes:4500});await next.load();assert.deepEqual(next.snapshot(),entries);
});

test('unsafe or malformed history is left unchanged and cannot grant new evidence',async t=>{
  for(const kind of ['malformed','unknown-fields','wrong-binding','oversize','public','symlink'] as const){const {directory,history}=await fixture(t),file=history.file;let raw:string;
    if(kind==='malformed')raw='{bad-json';else if(kind==='oversize')raw=' '.repeat(1024**2+1);else{const entry=trialHistoryEntry(trial())!;if(kind==='unknown-fields')(entry as unknown as Record<string,unknown>).ready=true;if(kind==='wrong-binding')entry.probes!.chat!.binding.digest='f'.repeat(64);raw=JSON.stringify({schemaVersion:1,entries:[entry]});}
    const target=kind==='symlink'?path.join(directory,'outside.json'):file;await writeFile(target,raw,{mode:0o600});if(kind==='public')await chmod(file,0o644);if(kind==='symlink')await symlink(target,file);
    const next=new SSDTrialHistory(directory);await next.load();assert.equal(next.error?.code,'SSD_HISTORY_UNAVAILABLE',kind);assert.deepEqual(next.snapshot(),[]);await next.record(trial());assert.equal(await readFile(target,'utf8'),raw,'Rejected history and symlink targets are never replaced.');assert.equal(next.error?.code,'SSD_HISTORY_UNAVAILABLE');
  }
});

test('legacy mmap trial history is not accepted as SSD evidence',async t=>{
  const {history}=await fixture(t),legacy={...trial(),mode:'experimental-disk' as const};await history.record(legacy);assert.deepEqual(history.snapshot(),[]);assert.equal(history.error,null);assert.deepEqual(await readdir(path.dirname(history.file)),[]);
});

test('a success flag without an observed fixed probe cannot establish a passed historical check',async t=>{
  const {history}=await fixture(t),unobserved=trial('passed',false);unobserved.probePassed=true;unobserved.toolProbePassed=true;await history.record(unobserved);assert.deepEqual(history.snapshot()[0].checks,{chat:'unverified',tools:'unverified'});
});

test('observed CPU kernel, zero repack count and parity identity survive reopen without granting readiness',async t=>{
  const {directory,history}=await fixture(t),attempt=trial();
  attempt.parityReportDigest='e'.repeat(64);attempt.backendValidation='validated';
  attempt.streaming={expectedGroups:30,streamedGroups:30,cacheSlotsPerLayer:24,expertCacheBytes:1024,
    cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,decodeThreads:4,batchThreads:4} as ExperimentalTrial['streaming'];
  await history.record(attempt);const next=new SSDTrialHistory(directory);await next.load();assert.equal(next.error,null);
  const saved=next.snapshot()[0];assert.equal(saved.parityReportDigest,attempt.parityReportDigest);assert.equal(saved.backendValidation,'validated');
  assert.equal(saved.resources?.streaming?.cpuKernel,'standard');assert.equal(saved.resources?.streaming?.useExtraBufts,false);
  assert.equal(saved.resources?.streaming?.cpuRepackTensorCount,0);assert.equal(saved.resources?.streaming?.decodeThreads,4);assert.equal(saved.resources?.streaming?.batchThreads,4);
  assert.deepEqual(saved.checks,{chat:'failed',tools:'unverified'});assert.equal(saved.state,'failed');
});

test('unreported native kernel measurements remain null and malformed CPU diagnostics are rejected',async t=>{
  const {directory,history}=await fixture(t),attempt=trial();
  attempt.streaming={expectedGroups:30,streamedGroups:0,cacheSlotsPerLayer:24,expertCacheBytes:0,
    cpuKernel:'unknown',useExtraBufts:null,cpuRepackTensorCount:null,decodeThreads:null,batchThreads:null} as ExperimentalTrial['streaming'];
  await history.record(attempt);const next=new SSDTrialHistory(directory);await next.load();assert.equal(next.error,null);
  assert.equal(next.snapshot()[0].resources?.streaming?.cpuRepackTensorCount,null);assert.equal(next.snapshot()[0].resources?.streaming?.useExtraBufts,null);
  const original=await readFile(history.file,'utf8');
  for(const [key,value] of [['cpuKernel','invented'],['cpuRepackTensorCount',-1],['decodeThreads',Infinity],['useExtraBufts','false']] as const){
    const invalid=trial();invalid.streaming={...attempt.streaming,[key]:value} as ExperimentalTrial['streaming'];
    await history.record(invalid);assert.equal(history.error?.code,'SSD_HISTORY_INVALID');assert.equal(await readFile(history.file,'utf8'),original);
  }
  const invalid=trial();invalid.parityReportDigest='not-a-checksum';await history.record(invalid);assert.equal(history.error?.code,'SSD_HISTORY_INVALID');assert.equal(await readFile(history.file,'utf8'),original);
});
