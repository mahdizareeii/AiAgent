import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { scoreEightGBCase, profileFromPortablePlan, hostDiagnosticProfile, hostDiagnosticStatusPlan, builtMainDigest, actualHostContextDiagnostic, actualEightGBHost } from '../../../scripts/8gb-validation/driver-support.ts';
import { PORTABLE_CPU_PROFILE, parsePortableCPUAllocationPlan } from '../portable-admission.ts';
import { inferenceProfileSignature } from '../memory.ts';
import { EIGHT_GB_FIXTURES, EIGHT_GB_PROTOCOL, EIGHT_GB_SUITE_DIGEST, inspectEightGBEvidence, evaluateEightGBComparison, rankEightGBCandidates } from '../../../scripts/8gb-validation/protocol.ts';
import { eightGBAssets } from '../../../scripts/8gb-validation/assets.ts';
import { MODEL_CATALOG } from '../catalog.ts';
const modes = createRequire(import.meta.url)('../../../scripts/8gb-validation/driver-mode.cjs');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const oracle={passed:true,syntheticExecutor:false,execution:{code:0,signal:null},checks:[{id:'immutable:check',passed:true}]};
// Authored records test joins only. They are explicitly not model evidence.
const base={fixtureId:'cli-inputs',repeat:1,startedAt:'2026-10-17T00:00:00Z',completedAt:'2026-10-17T00:00:01Z',request:'synthetic join fixture',loaded:{id:'owner',messages:[{role:'assistant',outcome:{status:'completed',verification:'passed',finishReason:'end_turn'}}]},events:[] as any[],permissions:[] as any[],oracle,commands:['node check.mjs'],timedOut:false};
test('actual ACP flat receipts join split call input and completion, including check-id verification command SHA',()=>{
 const events=[{type:'tool',id:'call',title:'reviewed actions: run verification',status:'pending',input:{check_id:'actual-frozen-check'}},{type:'tool',id:'call',title:'Tool',status:'completed',output:{ok:true,operation:'run_command',purpose:'verification',command_sha256:sha(base.commands[0]),command_cwd:'/workspace',network_access:'local-only',durable_id:'actual-shaped-id',exit_code:0,exit_signal:null}}];
 const good=scoreEightGBCase({...base,events});assert(good.independentChecks.every(row=>row.passed));assert.equal(good.actualOutcome.finishReason,'end_turn');assert.equal(good.replayCount,0);
 const altered=structuredClone(events);(altered[1].output as any).command_sha256='f'.repeat(64);assert.equal(scoreEightGBCase({...base,events:altered}).independentChecks.find(row=>row.id==='fresh-requested-command')?.passed,false);
 const blocked=structuredClone(base.loaded);blocked.messages[0].outcome.status='blocked';assert.equal(scoreEightGBCase({...base,events,loaded:blocked}).status,'blocked');
});
test('ordinary full postimage read requires successful complete exact bytes and final-file digest',()=>{
 const text='\uFEFFعنوان: سلام 🌍\r\nState: new.\r\n', file={path:'/workspace/greeting.txt',sha256:sha(text),bytes:Buffer.byteLength(text)};
 const events=[{type:'tool',id:'read',status:'completed',output:{ok:true,path:file.path,sha256:file.sha256,size:file.bytes,start_byte:0,end_byte:file.bytes,encoding:'utf-8',text,eof:true,truncated:false}}];
 const options={...base,fixtureId:'unicode-edit',events,commands:[],postimages:[file]};
 assert(scoreEightGBCase(options).independentChecks.every(row=>row.passed));
 for(const update of [{status:'failed'},{output:{...events[0].output,ok:false}},{output:{...events[0].output,text:text.replaceAll('\r','')}}]){const changed=[{...events[0],...update}];assert.equal(scoreEightGBCase({...options,events:changed}).independentChecks.find(row=>row.id==='full-postimage-read')?.passed,false);}
});
test('denial joins exact owned single write, including real create_files argument shape',()=>{
 const request={sessionId:'owner',turnId:'turn',requestId:'request',utility:'fileEditing',arguments:{files:[{path:'forbidden.txt',content:'Do not apply.\n'}]}};
 const loaded={id:'owner',messages:[{role:'assistant',outcome:{status:'blocked',verification:'unverified',finishReason:'PERMISSION_DENIED'}}]};
 const permission={request,decision:{approved:false},response:{status:'settled'}};
 const options={...base,fixtureId:'denied-write',loaded,commands:[],permissions:[permission]};assert(scoreEightGBCase(options).independentChecks.every(row=>row.passed));
 for(const change of [ {...request,sessionId:'other'}, {...request,arguments:{files:[{path:'other.txt',content:'Do not apply.\n'}]}}, {...request,arguments:{files:[{path:'forbidden.txt',content:'wrong'}]}}, {...request,arguments:{files:[...request.arguments.files,{path:'other.txt',content:'extra'}]}} ])assert.equal(scoreEightGBCase({...options,permissions:[{...permission,request:change}]}).independentChecks.find(row=>row.id==='genuine-denied-approval')?.passed,false);
});
test('OS networking proof cannot be replaced with a denied approval',()=>{
 const command='node frozen-network-probe',loaded={id:'owner',messages:[{role:'assistant',outcome:{status:'blocked',verification:'unverified',finishReason:'command denied'}}]};
 const events=[{type:'tool',id:'network',status:'pending',input:{command}},{type:'tool',id:'network',status:'failed',output:{ok:false,operation:'run_command',network_access:'local-only',durable_id:'network-id',exit_code:1,exit_signal:null}}];
 const options={...base,fixtureId:'network-denied',loaded,commands:[command],events,sandboxedCommands:[command]};assert(scoreEightGBCase(options).independentChecks.every(row=>row.passed));
 assert.equal(scoreEightGBCase({...options,sandboxedCommands:[]}).independentChecks.find(row=>row.id==='no-public-network')?.passed,false);
 assert.equal(scoreEightGBCase({...options,events:[{type:'tool',id:'denied',status:'failed',output:{error:'PERMISSION_DENIED'}}]}).independentChecks.find(row=>row.id==='no-public-network')?.passed,false);
});
test('actual planner profile extraction is lossless and rejects changed CPU arguments',()=>{
 const profileSignature=inferenceProfileSignature(PORTABLE_CPU_PROFILE,'low-memory');assert.deepEqual(profileFromPortablePlan({profileSignature}),PORTABLE_CPU_PROFILE);
 const altered=JSON.parse(profileSignature);altered.portableCPUArguments[altered.portableCPUArguments.indexOf('--threads')+1]='8';assert.throws(()=>profileFromPortablePlan({profileSignature:JSON.stringify(altered)}));
});
test('dependency-free bounded packed main reader agrees with a real ASAR producer and rejects malformed header',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'eightgb-asar-'));t.after(()=>rm(directory,{recursive:true,force:true}));const source=path.join(directory,'source');await mkdir(path.join(source,'dist'),{recursive:true});const main='// Authored reader fixture.\n';await writeFile(path.join(source,'dist/main.cjs'),main);
 const require=createRequire(import.meta.url),asar=require('@electron/asar'),archive=path.join(directory,'fixture.asar');await asar.createPackage(source,archive);assert.equal(await builtMainDigest(archive),sha(main));
 const malformed=path.join(directory,'bad.asar');await writeFile(malformed,Buffer.alloc(8));await assert.rejects(builtMainDigest(malformed),/Invalid ASAR/);
});
test('real host preflight reads actual OS memory and performs no app/model action; memory flags are rejected',()=>{
 const result=spawnSync(process.execPath,['scripts/8gb-validation/electron-runner.mjs','--preflight-only'],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.host.totalMemoryBytes,totalmem());assert.equal(value.appLoaded,false);assert.equal(value.modelLoaded,false);assert.equal(value.inferenceStarted,false);if(totalmem()>8*1024**3)assert.equal(value.available,false);
 const rejected=spawnSync(process.execPath,['scripts/8gb-validation/electron-runner.mjs','--preflight-only','--memory-bytes','8589934592'],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(rejected.status,1);assert.match(rejected.stderr,/Unknown driver argument/);
});

test('the actual shared scheduler preserves the complete default matrix and runs only the fixed diagnostic schedule', async () => {
 const assets=eightGBAssets(process.execPath,'/private/standalone-python').map(asset=>({...asset,request:EIGHT_GB_FIXTURES.find(row=>row.id===asset.id)!.request}));
 const before=JSON.stringify(assets),control={id:'live-browse-control'},stopControl={id:'live-stop-control'};
 assert.equal(modes.selectDriverFixtures(assets),assets);
 for(const runMode of [undefined,modes.CONTEXT_DIAGNOSTIC]){
  const fixtures=modes.selectDriverFixtures(assets,runMode),calls:string[]=[],plan={...(runMode?{runMode,model:{id:'qwen3.5:4b'}}:{}),fixtures,control,stopControl};let active=false;
  async function record(value:string){assert.equal(active,false,'Each actual driver callback must finish before the next begins.');active=true;calls.push(value);await new Promise(resolve=>setImmediate(resolve));active=false;}
  await modes.runDriverSequence(plan,{acceptance:(phase:string)=>record(phase),fixtureCase:(fixture:{id:string},repeat:number)=>record(`${fixture.id}-${repeat}`)});
  const expected=runMode?['cold','warm','exact-lf-1','python-repair-1']:['cold','warm','live-browse-control-1','live-stop-control-1',...EIGHT_GB_FIXTURES.flatMap(fixture=>[1,2,3].map(repeat=>`${fixture.id}-${repeat}`))];
  assert.deepEqual(calls,expected);assert.equal(calls.length,runMode?4:40);
  if(runMode){assert.equal(fixtures[0],assets[0]);assert.equal(fixtures[1],assets.find(row=>row.id==='python-repair'));}
 }
 assert.equal(JSON.stringify(assets),before,'Selection/scheduling must not amend fixture requests, source assets or oracles.');
 assert.deepEqual([...modes.DIAGNOSTIC_MODEL_IDS],['qwen3.5:4b',...MODEL_CATALOG.filter(model=>model.lowRamCandidate).map(model=>model.id)]);
 assert.equal(EIGHT_GB_PROTOCOL.caseBudgetMs,300_000);assert.equal(EIGHT_GB_PROTOCOL.maximumAcceptanceLatencyMs,300_000);
});

test('forged diagnostic modes, fixture order and repeat overrides fail before any driver callback', async () => {
 const all=eightGBAssets(process.execPath,'/private/standalone-python'),fixtures=modes.selectDriverFixtures(all,modes.CONTEXT_DIAGNOSTIC);
 let calls=0;const callbacks={acceptance:async()=>{calls++;},fixtureCase:async()=>{calls++;}};
 for(const runMode of [null,false,true,'context-diagnostic','complete-suite','unknown']){
  assert.throws(()=>modes.driverMode(runMode),/Unknown or forged/);
  await assert.rejects(modes.runDriverSequence({runMode,fixtures},callbacks),/Unknown or forged/);
 }
 for(const plan of [{runMode:modes.CONTEXT_DIAGNOSTIC,fixtures:[...fixtures].reverse()},
  {runMode:modes.CONTEXT_DIAGNOSTIC,fixtures:all},{fixtures},
  {runMode:modes.CONTEXT_DIAGNOSTIC,fixtures,model:{id:'qwen3.5:4b'},repeats:3},{runMode:modes.CONTEXT_DIAGNOSTIC,fixtures,model:{id:'qwen3.5:4b'},cases:['cli-inputs']},
  {runMode:modes.CONTEXT_DIAGNOSTIC,fixtures,model:{id:'qwen3.5:4b'},models:['qwen3.5:4b']}]){
  await assert.rejects(modes.runDriverSequence(plan,callbacks),/fixed fixture order|Arbitrary/);
 }
 for(const model of [undefined,{}, {id:'unknown'}, {id:'qwen3.8:27b'}, {id:'qwen3.5:4b '}]){
  await assert.rejects(modes.runDriverSequence({runMode:modes.CONTEXT_DIAGNOSTIC,fixtures,model},callbacks),/exact whitelisted model/);
 }
 for(const id of modes.DIAGNOSTIC_MODEL_IDS)assert.equal(modes.validateDriverPlan({runMode:modes.CONTEXT_DIAGNOSTIC,fixtures,model:{id}}).id,modes.CONTEXT_DIAGNOSTIC);
 assert.equal(modes.validateDriverPlan({fixtures:all,model:{id:'unmodified-default-model-handling'}}).id,undefined);
 assert.throws(()=>modes.selectDriverFixtures([...all].reverse(),modes.CONTEXT_DIAGNOSTIC),/complete frozen fixture order/);
 assert.equal(calls,0);
});

test('diagnostic report marking preserves failures while preventing completion, control proof, comparison or reference eligibility', () => {
 // These authored records exercise report policy only; they are not model evidence.
 const original={schemaVersion:1,protocolId:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,modelId:'qwen3.5:4b',
  classification:'attempted',complete:true,eligibleForIndependentSupportReview:true,qualified:true,supportClaimEstablished:true,
  driver:{controlsPassed:true},errors:['retained observed error'],cases:[{fixtureId:'exact-lf',repeat:1,status:'blocked'}],ownedProcessesStopped:true};
 assert.equal(modes.markDriverReport(original),original,'The complete-suite report path remains unchanged.');
 const diagnostic=modes.markDriverReport(original,modes.CONTEXT_DIAGNOSTIC);
 assert.equal(diagnostic.classification,'context-diagnostic');assert.equal(diagnostic.attemptClassification,'attempted');
 for(const key of ['complete','eligibleForIndependentSupportReview','qualified','supportClaimEstablished'])assert.equal(diagnostic[key],false);
 assert.equal(diagnostic.driver.controlsPassed,false);assert.equal(diagnostic.diagnostic.liveControls,'not-run-unvalidated');
 assert.equal(diagnostic.errors,original.errors);assert.equal(diagnostic.cases,original.cases);assert.equal(diagnostic.ownedProcessesStopped,true);
 assert.throws(()=>inspectEightGBEvidence(diagnostic),/A complete real driver run/);
 assert.throws(()=>evaluateEightGBComparison(diagnostic,diagnostic),/A complete real driver run/);
 assert.equal(rankEightGBCandidates(diagnostic,[diagnostic]).recommendedForIndependentReview,null);
 const comparison=modes.diagnosticComparison([diagnostic,{...diagnostic,modelId:'qwen3.5:9b-ud-iq2-m'}]);
 assert.equal(comparison.comparisons[0].eligibleForIndependentSupportReview,false);assert.deepEqual(comparison.selection.ranking,[]);
 assert.equal(comparison.selection.recommendedForIndependentReview,null);assert.equal(comparison.selection.qualified,false);assert.equal(comparison.selection.supportClaimEstablished,false);
 for(const classification of ['interrupted','not-admitted-before-app-start','not-admitted-before-model-spawn']){
  const value=modes.markDriverReport({...original,classification},modes.CONTEXT_DIAGNOSTIC);assert.equal(value.classification,'context-diagnostic');assert.equal(value.attemptClassification,classification);assert.equal(value.complete,false);
 }
});

test('actual CLI accepts only the fixed diagnostic flag without memory, fixture, model or deadline overrides', () => {
 const prefix=['scripts/8gb-validation/electron-runner.mjs','--preflight-only','--context-diagnostic'];
 const result=spawnSync(process.execPath,prefix,{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(result.status,0,result.stderr);
 const value=JSON.parse(result.stdout);assert.equal(value.runMode,modes.CONTEXT_DIAGNOSTIC);assert.equal(value.host.totalMemoryBytes,totalmem());
 for(const key of ['appLoaded','modelLoaded','inferenceStarted','qualified','supportClaimEstablished'])assert.equal(value[key],false);
 for(const extra of [['--model','qwen3.5:4b'],['--cases','exact-lf'],['--repeat','1'],['--timeout','600000'],['--run-mode','unknown'],['--context-diagnostic'],['false']]){
  const rejected=spawnSync(process.execPath,[...prefix,...extra],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(rejected.status,1,JSON.stringify(extra));assert.match(rejected.stderr,/Unknown driver argument|unique named driver arguments/);
 }
});

test('physical-host context mode has only the three pinned9B models and unchanged two-case scheduling', async () => {
 const all=eightGBAssets(process.execPath,'/private/standalone-python'),runMode=modes.HOST_CONTEXT_DIAGNOSTIC;
 const fixtures=modes.selectDriverFixtures(all,runMode),calls:string[]=[];
 assert.deepEqual([...modes.HOST_DIAGNOSTIC_MODEL_IDS],MODEL_CATALOG.filter(model=>model.lowRamCandidate).map(model=>model.id));
 for(const id of modes.HOST_DIAGNOSTIC_MODEL_IDS){
  await modes.runDriverSequence({runMode,environment:'physical',model:{id},fixtures},{acceptance:async(phase:string)=>{calls.push(`${id}:${phase}`);},fixtureCase:async(fixture:{id:string},repeat:number)=>{calls.push(`${id}:${fixture.id}-${repeat}`);}});
 }
 assert.deepEqual(calls,modes.HOST_DIAGNOSTIC_MODEL_IDS.flatMap((id:string)=>['cold','warm','exact-lf-1','python-repair-1'].map(key=>`${id}:${key}`)));
 assert.equal(fixtures[0],all[0]);assert.equal(fixtures[1],all.find(row=>row.id==='python-repair'));
 for(const id of ['qwen3.5:4b','qwen3.8:27b','unknown',undefined])assert.throws(()=>modes.validateDriverPlan({runMode,environment:'physical',model:{id},fixtures}),/exact whitelisted/);
 for(const environment of ['whole-os-vm','process-limited',undefined])assert.throws(()=>modes.validateDriverPlan({runMode,environment,model:{id:modes.HOST_DIAGNOSTIC_MODEL_IDS[0]},fixtures}),/declared physical hardware/);
});

test('host hardware declarations cannot replace actual OS/sysctl capacity or physical-host probes', () => {
 // Authored hardware records test policy only and never admit a real app/model.
 const probe={platform:'darwin',architecture:'arm64',totalMemoryBytes:24*1024**3,sysctlMemory:String(24*1024**3)+'\n',hypervisor:'0\n'};
 const actual=modes.hostContextHardware(probe),evidence={environment:'physical',memoryScope:'whole-os',actual};
 assert.equal(actual.available,true);assert.equal(actual.actual8GBModelEvidence,false);assert.equal(actual.supported,false);
 assert.doesNotThrow(()=>modes.validateHostHardwareEvidence(evidence,actual));
 for(const update of [{totalMemoryBytes:8*1024**3},{totalMemoryBytes:32*1024**3},{sysctlMemory:String(8*1024**3)},
  {sysctlMemory:'25769803776 invented'},{sysctlMemory:''},{hypervisor:'1\n'},{hypervisor:''},{hypervisor:'0 invented'},
  {platform:'linux'},{architecture:'x64'}]){
  const rejected=modes.hostContextHardware({...probe,...update});assert.equal(rejected.available,false);
  assert.throws(()=>modes.validateHostHardwareEvidence(evidence,rejected),/cannot override a failed actual gate/);
 }
 for(const changed of [{...evidence,environment:'whole-os-vm'},{...evidence,actual:{...actual,totalMemoryBytes:8*1024**3}},
  {...evidence,actual:{...actual,sysctlMemoryBytes:8*1024**3}},{...evidence,actual:{...actual,hypervisorPresent:1}},
  {...evidence,actual:{...actual,platform:'linux'}}])assert.throws(()=>modes.validateHostHardwareEvidence(changed,actual),/must match/);
});

test('actual host preflight records real24GiB probes separately while default8GB gate and flag whitelist remain intact', async () => {
 const actual=await actualHostContextDiagnostic();assert.equal(actual.totalMemoryBytes,totalmem());assert.equal(actual.actual8GBModelEvidence,false);
 assert.equal(actualEightGBHost().totalMemoryBytes,totalmem());if(totalmem()>8*1024**3)assert.equal(actualEightGBHost().available,false);
 const prefix=['scripts/8gb-validation/electron-runner.mjs','--preflight-only','--host-context-diagnostic'];
 const result=spawnSync(process.execPath,prefix,{encoding:'utf8',timeout:15000,maxBuffer:65536});assert.equal(result.status,0,result.stderr);
 const value=JSON.parse(result.stdout);assert.equal(value.protocolId,modes.HOST_CONTEXT_DIAGNOSTIC);assert.equal(value.runMode,modes.HOST_CONTEXT_DIAGNOSTIC);
 assert.equal(value.host.totalMemoryBytes,totalmem());assert.equal(value.host.sysctlMemoryBytes,actual.sysctlMemoryBytes);assert.equal(value.host.hypervisorPresent,actual.hypervisorPresent);
 for(const key of ['appLoaded','modelLoaded','inferenceStarted','qualified','supportClaimEstablished'])assert.equal(value[key],false);
 const both=spawnSync(process.execPath,[...prefix,'--context-diagnostic'],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(both.status,1);assert.match(both.stderr,/mutually exclusive/);
 for(const extra of [['--model','qwen3.5:9b-q3-k-s'],['--cases','exact-lf'],['--timeout','900000'],['--memory-bytes','8589934592']]){
  const bad=spawnSync(process.execPath,[...prefix,...extra],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(bad.status,1);assert.match(bad.stderr,/Unknown driver argument/);
 }
});

test('host context reports can never be8GB references or quality/support comparisons even with passing synthetic input', () => {
 const ids=modes.HOST_DIAGNOSTIC_MODEL_IDS,reports=ids.map((modelId:string)=>modes.markDriverReport({schemaVersion:1,protocolId:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,
  modelId,classification:'attempted',complete:true,qualified:true,supportClaimEstablished:true,driver:{controlsPassed:true},cases:[],errors:[]},modes.HOST_CONTEXT_DIAGNOSTIC));
 for(const report of reports){
  assert.equal(report.protocolId,modes.HOST_CONTEXT_DIAGNOSTIC);assert.equal(report.originProtocolId,EIGHT_GB_PROTOCOL.id);assert.equal(report.classification,'host-context-diagnostic');
  for(const key of ['complete','eligibleForIndependentSupportReview','qualified','supportClaimEstablished','actual8GBModelEvidence','qualityClaimEstablished'])assert.equal(report[key],false);
  assert.equal(report.driver.controlsPassed,false);assert.throws(()=>inspectEightGBEvidence({...report,complete:true}),/exact frozen 8 GB protocol/);
  assert.throws(()=>evaluateEightGBComparison(report,report),/exact frozen/);
 }
 const comparison=modes.diagnosticComparison(reports,modes.HOST_CONTEXT_DIAGNOSTIC);
 assert.deepEqual(comparison.comparisons.map((row:any)=>row.modelId),[...ids]);assert.equal(comparison.comparisons.length,3);
 assert(comparison.comparisons.every((row:any)=>row.eligibleForIndependentSupportReview===false));assert.deepEqual(comparison.selection.ranking,[]);assert.equal(comparison.selection.recommendedForIndependentReview,null);
 assert.equal(comparison.selection.qualified,false);assert.equal(comparison.selection.supportClaimEstablished,false);
});

test('host diagnostic profile proof remains exact and native snapshot summaries exclude foreign owners and reveal duplicate timestamps', () => {
 const model='qwen3.5:9b-ud-iq2-m',spec=MODEL_CATALOG.find(row=>row.id===model)!;
 // Real parser shape from a metadata-only authored planner row; this is not
 // native allocation or model evidence and never loads an app/model.
 const plan=parsePortableCPUAllocationPlan('Host 3600 178 33\n',{model,modelDigest:spec.sha256,templateDigest:'a'.repeat(64),engineDigest:'b'.repeat(64),plannerDigest:'c'.repeat(64),
  profileSignature:inferenceProfileSignature(PORTABLE_CPU_PROFILE,'low-memory'),artifactBytes:spec.estimatedDownloadBytes});
 assert.deepEqual(hostDiagnosticProfile(plan,model),PORTABLE_CPU_PROFILE);
 const portableMemoryPlanDigest=sha(JSON.stringify(plan));
 const first=hostDiagnosticStatusPlan({loadedModel:model,portableMemoryPlan:plan,portableMemoryPlanDigest},model);
 assert.equal(first,plan);assert.equal(hostDiagnosticStatusPlan({loadedModel:model,portableMemoryPlanDigest},model,first),plan);
 for(const runtime of [{loadedModel:model,portableMemoryPlanDigest},{loadedModel:model},
  {loadedModel:'qwen3.5:4b',portableMemoryPlanDigest},{loadedModel:model,portableMemoryPlanDigest:'f'.repeat(64)},
  {loadedModel:model,portableMemoryPlan:{...plan,noAlloc:false},portableMemoryPlanDigest}]){
  assert.throws(()=>hostDiagnosticStatusPlan(runtime,model),/exact prepared/);
 }
 assert.throws(()=>hostDiagnosticStatusPlan({loadedModel:model,portableMemoryPlanDigest:'f'.repeat(64)},model,first),/exact prepared/);
 assert.throws(()=>hostDiagnosticStatusPlan({loadedModel:'qwen3.5:4b',portableMemoryPlanDigest},model,first),/exact prepared/);
 for(const update of [{schemaVersion:undefined},{kind:'unknown'},{noAlloc:false},{model:'qwen3.5:4b'},
  {engineCommit:'unbound'},{modelDigest:'f'.repeat(64)},{templateDigest:undefined},{engineDigest:'bad'},{plannerDigest:undefined},
  {artifactBytes:plan.artifactBytes-1},{modelBytes:plan.artifactBytes-1},{contextBytes:undefined},{computeBytes:0},
  {processHeadroomBytes:512*1024**2,workingBytes:plan.workingBytes-512*1024**2},{workingBytes:plan.workingBytes-1},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),outputTokens:2048})},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),contextTokens:8192})},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),microBatchTokens:16})},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),slots:2})},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),memoryMode:'auto'})},
  {profileSignature:JSON.stringify({...JSON.parse(plan.profileSignature),inventedSetting:true})}])assert.throws(()=>hostDiagnosticProfile({...plan,...update},model),/exact prepared/);
 const samples=[{pid:10,parentPid:9,sampledAt:'2026-10-17T00:00:00Z',rssBytes:100,physicalFootprintBytes:120,residentBytes:120},
  {pid:10,parentPid:9,sampledAt:'2026-10-17T00:00:00Z',rssBytes:110,physicalFootprintBytes:125,residentBytes:125},
  {pid:10,parentPid:9,sampledAt:'2026-10-17T00:00:02Z',rssBytes:90,physicalFootprintBytes:115,residentBytes:115},
  {pid:11,parentPid:9,sampledAt:'2026-10-17T00:00:01Z',rssBytes:99999,physicalFootprintBytes:99999,residentBytes:99999},
  {pid:10,parentPid:8,sampledAt:'2026-10-17T00:00:01Z',rssBytes:99999,physicalFootprintBytes:99999,residentBytes:99999}];
 const observed=modes.observedNativeSamples(samples,10,9);assert.equal(observed.requestedIntervalMs,1000);assert.equal(observed.observedSamples,3);
 assert.equal(observed.uniqueSampleTimestamps,2);assert.equal(observed.maximumObservedGapMs,2000);assert.equal(observed.observedMaximumResidentBytes,125);
 assert.equal(observed.observedMaximumRSSBytes,110);assert.match(observed.scope,/not allocation high-water/);
 assert.equal(modes.observedNativeSamples(samples,undefined,9).observedSamples,0);
});

test('parent OS signals stop one actual detached stub controller and retain drain/evidence before nonzero exit',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'eightgb-signals-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const helper=pathToFileURL(path.resolve('scripts/8gb-validation/driver-signals.ts')).href;
 const latch=path.resolve('scripts/8gb-validation/driver-bootstrap-stop.cjs');
 // This is process-control coverage only: no Electron, model, provider, 8GB
 // override, suite result or synthetic inference evidence is constructed.
 const controller=path.join(root,'controller.cjs');await writeFile(controller,`const fs=require('node:fs');const{createBootstrapStopLatch}=require(${JSON.stringify(latch)});const latch=createBootstrapStopLatch();let planReady=false,stops=0;function stop(){if(stops++)return;setTimeout(()=>{fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,parentPid:process.ppid,stops,productionImported:planReady,emptyDrain:!planReady}));process.exit(0);},30);}process.on('message',message=>{if(latch.receive(message))stop();});process.send({type:'listening'});setTimeout(()=>{if(latch.bind(process.argv[3])){stop();return;}planReady=true;process.send({type:'ready'});},Number(process.argv[4]));`);
 const parent=path.join(root,'parent.mjs');await writeFile(parent,`import{spawn}from'node:child_process';import{writeFile}from'node:fs/promises';import{installDriverInterruption}from ${JSON.stringify(helper)};const signals=installDriverInterruption(),nonce='11111111-1111-4111-8111-111111111111';let requests=0,secondStarted=false;const child=spawn(process.execPath,[${JSON.stringify(controller)},process.argv[2]+'/child.json',nonce,process.argv[3]],{stdio:['ignore','ignore','pipe','ipc'],detached:true});const release=signals.bindStop(()=>{requests++;child.send({type:'stop',nonce});});child.on('message',message=>{if(message.type==='listening'&&process.argv[3]!=='0'||message.type==='ready')process.send({type:'ready-for-signal',controllerPid:child.pid});});const exit=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));release();try{signals.throwIfInterrupted();secondStarted=true;}catch{}await writeFile(process.argv[2]+'/parent.json',JSON.stringify({first:signals.first,exit,requests,secondStarted}));process.exitCode=signals.first?.exitCode??1;signals.dispose();`);
 for(const[signal,code,early]of [['SIGINT',130,false],['SIGTERM',143,false],['SIGHUP',129,false],['SIGTERM',143,true]] as const){
   const directory=path.join(root,signal+(early?'-early':''));await mkdir(directory);const child=spawn(process.execPath,[parent,directory,early?'150':'0'],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
   const timer=setTimeout(()=>{child.kill('SIGKILL');},5000);let controllerPid:number|undefined;
   child.once('message',(message:any)=>{assert.equal(message.type,'ready-for-signal');controllerPid=message.controllerPid;child.kill(signal);setTimeout(()=>child.kill(signal==='SIGINT'?'SIGTERM':'SIGINT'),5);});
   const exit=await new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);assert.equal(exit.code,code,stderr);assert.equal(exit.signal,null);
   const actual=JSON.parse(await readFile(path.join(directory,'parent.json'),'utf8')),owned=JSON.parse(await readFile(path.join(directory,'child.json'),'utf8'));assert.equal(actual.first.signal,signal);assert.equal(actual.exit.code,0);assert.equal(actual.exit.signal,null);assert.equal(actual.requests,1);assert.equal(actual.secondStarted,false);assert.equal(owned.pid,controllerPid);assert.equal(owned.stops,1);assert.equal(owned.emptyDrain,early);if(early)assert.equal(owned.productionImported,false);assert.throws(()=>process.kill(owned.pid,0),{code:'ESRCH'});
 }
});

test('early bootstrap latch authenticates the pending stop before production import',()=>{
 const require=createRequire(import.meta.url),{createBootstrapStopLatch}=require('../../../scripts/8gb-validation/driver-bootstrap-stop.cjs');const owned='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const mismatch=createBootstrapStopLatch();mismatch.receive({type:'stop',nonce:other});assert.equal(mismatch.bind(owned),false);assert.equal(mismatch.stopped,false);
 const early=createBootstrapStopLatch();assert.equal(early.receive({type:'stop',nonce:owned}),false);assert.equal(early.bind(owned),true);assert.equal(early.stopped,true);assert.equal(early.receive({type:'stop',nonce:owned}),true);
});
