import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,type TestContext} from 'node:test';
import {LocalInferenceRuntime,type CuratedModel,type HardwareInfo,type RuntimeOptions} from '../index.ts';
import {GIB} from '../hardware.ts';
import {validateSSDStreamingStatus} from '../memory.ts';

const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str=(s:string)=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const kv=(key:string,value:string)=>Buffer.concat([str(key),u32(8),str(value)]);
const descriptor=(name:string,dims:number[],offset:number)=>Buffer.concat([str(name),u32(dims.length),...dims.map(u64),u32(0),u64(offset)]);
const descriptors=[descriptor('token_embd.weight',[8,1],0),...['gate','up','down'].map((kind,i)=>descriptor(`blk.0.ffn_${kind}_exps.weight`,[8,1,128],32+i*4096))];
const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(4),u64(3),kv('general.architecture','gemma4'),kv('general.name','Tiny MoE fixture'),kv('tokenizer.chat_template','{{ messages | tojson }}'),...descriptors]);
const bytes=Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32+3*4096)]);
const spec:CuratedModel={id:'fixture:moe',title:'Fixture MoE',description:'Test fixture',estimatedDownloadBytes:bytes.length,minimumMemoryGB:8,workingMemoryGB:40,license:'Apache-2.0',sourceUrl:'',quantization:'F32 fixture',repository:'example/moe',revision:'a'.repeat(40),filename:'fixture-moe.gguf',sha256:createHash('sha256').update(bytes).digest('hex'),architecture:'gemma4',toolCapable:true,ssd:{minimumSlotsPerLayer:24,expertsPerLayer:128,activeExperts:8,expectedLayers:1}};
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',osRelease:'25.0.0',cpuModel:'Fixture',cpuCores:8,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,freeDiskBytes:100*GIB,gpus:[]};
const fake=fileURLToPath(new URL('./fake-engine.cjs',import.meta.url));
async function fixture(t:TestContext,env:NodeJS.ProcessEnv={},options:{available?:number;worker?:boolean;osRelease?:string;planner?:boolean;availableAfterPlan?:number;integrity?:boolean;parity?:boolean;qaBackend?:'cpu'|'metal';productionProof?:'valid'|'missing'|'malformed'|'mismatch'|'bad-profile'|'wrong-model'}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'local-agent-ssd-')),owned:LocalInferenceRuntime[]=[];t.after(async()=>{for(const runtime of owned)await runtime.stop();await rm(directory,{recursive:true,force:true});});await mkdir(path.join(directory,'models'));await writeFile(path.join(directory,'models',spec.filename),bytes);
  const launches:string[][]=[],calls:string[]=[],controls:object[]=[];let plannerStarted=false;const nativeFetch=fetch;
  const settings:RuntimeOptions={dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:{...hardware,osRelease:options.osRelease??hardware.osRelease,availableMemoryBytes:options.available??hardware.availableMemoryBytes},ssdTestEngine:options.worker===false?undefined:{executablePath:process.execPath,patchDigest:'d'.repeat(64),fixtureParityReportDigest:options.parity===false?undefined:'c'.repeat(64),plannerPath:options.planner?process.execPath:undefined,plannerSourceDigest:'f'.repeat(64),integrityPath:options.integrity?process.execPath:undefined,integritySourceDigest:'e'.repeat(64)},qaSSDBackend:options.qaBackend,startupTimeoutMs:1000,ssdLoadTimeoutMs:2000,ssdCalibrationTimeoutMs:2000,stopTimeoutMs:500,resourceIntervalMs:20,resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:90*1024**2,availableMemoryBytes:plannerStarted?(options.availableAfterPlan??options.available??20*GIB):(options.available??20*GIB),pressure:'normal'}),fetch:async(input,init)=>{if(String(input).endsWith('/v1/chat/completions'))calls.push(String(init?.body));if(String(input).endsWith('/ssd/control'))controls.push(JSON.parse(String(init?.body)));return nativeFetch(input,init);},spawn:(_command,args,options)=>{if(args.includes('--cache-slots'))plannerStarted=true;launches.push(args);return spawn(process.execPath,[fake,...args],{...options,env:{...options.env,...env}});}};
  if(options.productionProof){
    const bundle=path.join(directory,'bundle');await mkdir(path.join(bundle,'cpu'),{recursive:true});await mkdir(path.join(bundle,'validation'));await mkdir(path.join(bundle,'hash'));const worker=await readFile(fake);await writeFile(path.join(bundle,'cpu','fake-engine.cjs'),worker);await writeFile(path.join(bundle,'hash','fake-engine.cjs'),worker);
    const profile={contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,cacheSlotsPerLayer:24,cacheTypeK:'f16',cacheTypeV:'f16',swaFull:false,slots:1,ioWorkers:2,ioMode:'darwin-nocache',decodeThreads:4,batchThreads:4};
    const configuration={baseCommit:'d81235049384534c167caea52b85a694f6103d14',modelSha256:spec.sha256,templateSha256:createHash('sha256').update('{{ messages | tojson }}').digest('hex'),architecture:'gemma4',backend:'cpu',cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,workerPatchSha256:'d'.repeat(64),report:'validation/fixture-cpu.json',reportSha256:'',scope:'representative-experts-and-two-swa-layers',profile};
    let report=JSON.stringify({...configuration,schemaVersion:1,passed:true,baseCommit:'d81235049384534c167caea52b85a694f6103d14'});
    if(options.productionProof==='malformed')report='{';
    if(options.productionProof==='mismatch')report=JSON.stringify({...JSON.parse(report),modelSha256:'1'.repeat(64)});
    if(options.productionProof==='bad-profile')report=JSON.stringify({...JSON.parse(report),profile:{...profile,decodeThreads:8}});
    if(options.productionProof==='wrong-model')configuration.modelSha256='1'.repeat(64);
    configuration.reportSha256=createHash('sha256').update(report).digest('hex');await writeFile(path.join(bundle,configuration.report),report);
    const hash=createHash('sha256').update(worker).digest('hex');const files=[{path:'cpu/fake-engine.cjs',sha256:hash,size:worker.length},{path:'hash/fake-engine.cjs',sha256:hash,size:worker.length},{path:configuration.report,sha256:configuration.reportSha256,size:Buffer.byteLength(report)}];
    await writeFile(path.join(bundle,'manifest.json'),JSON.stringify({schemaVersion:1,engine:'llama.cpp-ssd-experts',version:'0.6.0',build:11429,baseCommit:'d81235049384534c167caea52b85a694f6103d14',upstreamCommits:[],patchSha256:'d'.repeat(64),target:'darwin-arm64',minimumMacOS:'14.0',backends:[{id:'cpu',executable:'cpu/fake-engine.cjs',libraryDirectory:'cpu',arguments:['--device','none','--n-gpu-layers','0','--no-op-offload']}],integrity:{id:'integrity',executable:'hash/fake-engine.cjs',schemaVersion:1,sourceSha256:'e'.repeat(64)},files,validatedConfigurations:options.productionProof==='missing'?[]:[configuration]}));
    settings.ssdTestEngine=undefined;settings.ssdResourcesDirectory=bundle;
  }
  const runtime=new LocalInferenceRuntime(settings);owned.push(runtime);await runtime.start();const reopen=async()=>{const next=new LocalInferenceRuntime(settings);owned.push(next);await next.start();return next;};return {runtime,directory,launches,calls,controls,reopen};
}

test('oversized acquisition is separate from normal use and actual integrity evidence',async t=>{
  const {runtime}=await fixture(t,{}, {worker:false});const row=(await runtime.listModels())[0];
  assert.equal(row.installed,true);assert.equal(row.digest,null);assert.equal(row.integrity,'unverified');
  assert.equal(row.useBlocker?.code,'INSUFFICIENT_MEMORY');assert.equal(row.acquisitionBlocker,null);assert.equal(row.trialBlocker?.code,'SSD_ENGINE_UNAVAILABLE');
  await runtime.inspectModel(spec.id);const verified=(await runtime.listModels())[0];assert.equal(verified.digest,spec.sha256);assert.match(verified.templateHash!,/^[a-f0-9]{64}$/);
});

test('curated SSD verification uses the bounded manifest-bound native reader and proves the full digest',async t=>{
  const {runtime,launches}=await fixture(t,{}, {integrity:true});const verified=await runtime.inspectModel(spec.id);assert.equal(verified.digest,spec.sha256);assert.equal(verified.verificationIO,'darwin-nocache');
  const hash=launches.find(a=>a.includes('--file'))!;assert(Number(hash[hash.indexOf('--resident-limit-bytes')+1])<=256*1024**2);assert.equal(hash[hash.indexOf('--deadline-ms')+1],'1800000');
  await runtime.startModelTrial(spec.id);assert.equal(launches.filter(a=>a.includes('--file')).length,1,'An unchanged native proof is reused instead of warming the model through Node.');
});

test('a missing SSD checksum helper preserves ordinary integrity without authorizing strict loading',async t=>{
  const {runtime}=await fixture(t,{}, {worker:false});const ordinary=await runtime.inspectModel(spec.id);assert.equal(ordinary.verificationIO,'node');await assert.rejects(runtime.inspectModel(spec.id,{requireSSDIntegrity:true}),{code:'SSD_INTEGRITY_HELPER_UNAVAILABLE'});assert.equal((await runtime.listModels())[0].integrity,'verified');
});

test('uncached integrity proof must cover every byte and match the pinned SHA before inference',async t=>{
  for(const [env,code] of [[{FAKE_HASH_BAD_PROOF:'1'},'SSD_HASH_INVALID'],[{FAKE_HASH_WRONG_SHA:'1'},'MODEL_DIGEST_MISMATCH']] as const){const {runtime,launches}=await fixture(t,env,{integrity:true});await assert.rejects(runtime.startModelTrial(spec.id),{code});assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);}
});

test('unsupported external filesystem permits ordinary verification but never SSD loading',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_HASH_FS_UNSUPPORTED:'1'},{integrity:true});const ordinary=await runtime.inspectModel(spec.id);assert.equal(ordinary.digest,spec.sha256);assert.equal(ordinary.verificationIO,'node');
  await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_HASH_FILESYSTEM_UNSUPPORTED'});assert.equal((await runtime.listModels())[0].integrity,'verified','A filesystem capability failure is not evidence that ordinarily verified weights are corrupt.');assert.equal(launches.filter(a=>a.includes('--file')).length,2,'Node verification cannot authorize strict SSD identity.');assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
});

test('cancellation stops native hashing and retains the complete source artifact',async t=>{
  const {runtime,directory,launches}=await fixture(t,{FAKE_HASH_DELAY:'1'},{integrity:true});const controller=new AbortController(),pending=runtime.inspectModel(spec.id,{signal:controller.signal}),rejected=assert.rejects(pending,{name:'AbortError'});while(!launches.some(a=>a.includes('--file')))await new Promise(r=>setTimeout(r,5));controller.abort();await rejected;assert.deepEqual(await readFile(path.join(directory,'models',spec.filename)),bytes);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
});

test("a queued checksum cancellation settles immediately without aborting another owner's checksum",async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_HASH_DELAY:'1'},{integrity:true});const background=runtime.inspectModel(spec.id);while(!launches.some(a=>a.includes('--file')))await new Promise(r=>setTimeout(r,5));
  const controller=new AbortController(),foreground=runtime.inspectModel(spec.id,{signal:controller.signal}),rejected=assert.rejects(foreground,{name:'AbortError'});controller.abort();
  await Promise.race([rejected,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('Queued cancellation waited for the unrelated checksum.')),100))]);assert.equal(launches.filter(a=>a.includes('--file')).length,1);
  assert.equal((await background).digest,spec.sha256);await new Promise(r=>setTimeout(r,10));assert.equal(launches.filter(a=>a.includes('--file')).length,1,'Cancelled queued work never opens or spawns a helper.');
});

test('older supported macOS keeps normal startup but exposes the SSD worker minimum version',async t=>{
  const {runtime,launches}=await fixture(t,{}, {osRelease:'22.6.0'});assert.equal(runtime.getStatus().state,'ready');assert.equal((await runtime.listModels())[0].ssdEligibility?.supported,false);assert.match((await runtime.listModels())[0].trialBlocker!.message,/macOS 14/);
  await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_PLATFORM_UNSUPPORTED'});assert.equal(runtime.getStatus().memoryMode,'automatic');assert.equal(launches.filter(a=>a.includes('--model')).length,0);
});

test('SSD trial proves expert streaming and profile identity with fixed bounded defaults',async t=>{
  const {runtime,directory,launches,calls,controls}=await fixture(t);const prepared=await runtime.startModelTrial(spec.id,'ssd-experts');
  assert.equal(prepared.executionRoute,'ssd-experts');assert.equal(prepared.memoryMode,'ssd-experts');assert.equal(prepared.probePassed,true);assert.equal(prepared.toolCapable,true);assert.match(prepared.engineIdentity!,/^[a-f0-9]{64}$/);
  const args=launches.find(a=>a.includes('--model'))!;assert.equal(args[args.indexOf('--load-mode')+1],'none');assert(!args.includes('--lazy-mode'));
  for(const [flag,value] of [['--batch-size','64'],['--ubatch-size','16'],['--ctx-size','4096'],['--predict','1024'],['--parallel','1'],['--moe-stream-io-threads','2']])assert.equal(args[args.indexOf(flag)+1],value);
  assert(Number(args[args.indexOf('--ssd-expert-cache-bytes')+1])>=24*32*3,'Cache budget includes backend alignment without reducing the slot floor.');
  assert(Number(args[args.indexOf('--ssd-budget-bytes')+1])<Number(args[args.indexOf('--ssd-resident-limit-bytes')+1]));
  const trial=runtime.getStatus().experimentalTrial!;assert.equal(trial.mode,'ssd-experts');assert.equal(trial.streaming?.expectedGroups,1);assert.equal(trial.streaming?.streamedGroups,1);assert.equal(trial.profileSignature,prepared.profileSignature);assert.equal(trial.measurements?.residentBytes,100*1024**2,'RSS and physical footprint overlap; do not add them.');
  assert.equal(calls.length,2);assert.equal((await runtime.prepareModel(spec.id)).baseUrl,prepared.baseUrl);
  const chatRequest=JSON.parse(calls[0]);assert.deepEqual(chatRequest.messages,[{role:'user',content:'Reply with exactly the two letters OK. Do not include punctuation, formatting, or any other text.'}]);assert.equal(chatRequest.max_tokens,16);assert.equal(chatRequest.temperature,0);assert.equal(chatRequest.chat_template_kwargs.enable_thinking,false);assert.equal(chatRequest.cache_prompt,false);
  const toolRequest=JSON.parse(calls[1]);assert.deepEqual(toolRequest.messages,[{role:'user',content:'Call local_probe with word OK.'}]);assert.equal(toolRequest.max_tokens,96,'Clarifying the Chat probe does not change the tool probe.');
  assert.deepEqual(controls,[{deadlineMs:2000},{idle:true},{deadlineMs:2000},{idle:true}],'Each probe arms its deadline and disarms before the next request or approval wait.');
  const record=JSON.parse(await readFile(path.join(directory,'ssd-trials.json'),'utf8'))[0];assert.equal(record.artifactSetDigest,prepared.digest);assert.equal(record.engineDigest,prepared.engineIdentity);
  const row=(await runtime.listModels())[0];assert.equal(row.fit,'insufficient');assert.equal(row.useBlocker,null,'Successful SSD use retains normal fit labels without blocking Send.');assert.equal(row.toolProbe?.status,'passed');assert.equal(row.toolProbe?.runtime,prepared.engineIdentity);assert.equal(row.chatProbe?.status,'passed');
});

test('trial progress retains actual verification bytes and publishes no previous active identity',async t=>{
  const env:NodeJS.ProcessEnv={};const {runtime}=await fixture(t,env,{integrity:true});const progress:{stage:string;completedBytes?:number;totalBytes?:number}[]=[];runtime.on('status',status=>{if(status.experimentalTrial?.progress)progress.push(status.experimentalTrial.progress);});
  const first=await runtime.startModelTrial(spec.id);assert.equal(first.probePassed,true);assert.deepEqual([...new Set(progress.map(p=>p.stage))],['verifying','planning','loading','probing']);assert(progress.some(p=>p.stage==='verifying'&&p.completedBytes===bytes.length&&p.totalBytes===bytes.length));
  env.FAKE_SSD_FALLBACK='1';const second=runtime.startModelTrial(spec.id),rejected=assert.rejects(second,{code:'SSD_STREAMING_NOT_CONFIRMED'});const during=runtime.getStatus();assert.equal(during.loadedModel,null);assert.equal(during.profile,null);assert.equal(during.engineIdentity,undefined);assert.equal(during.profileSignature,null);
  await rejected;assert.equal(runtime.getStatus().engineIdentity,undefined);assert.equal(runtime.getStatus().profileSignature,null);assert.equal((await runtime.listModels())[0].engineIdentity,undefined,'A terminated worker cannot publish active model identity.');
});

test('stale and already-settled trial cancellation cannot unload another usable configuration',async t=>{
  const {runtime}=await fixture(t);const prepared=await runtime.startModelTrial(spec.id),id=runtime.getStatus().experimentalTrial!.id;await runtime.cancelExperimentalTrial('00000000-0000-4000-8000-000000000000');assert.equal(runtime.getStatus().loadedModel,spec.id);
  await runtime.cancelExperimentalTrial(id);assert.equal(runtime.getStatus().experimentalTrial?.state,'passed');assert.equal((await runtime.prepareModel(spec.id)).baseUrl,prepared.baseUrl);
});

test('a stale cancel ID cannot abort the current loading trial while its matching ID can',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_HEALTH_DELAY:'1'});const pending=runtime.startModelTrial(spec.id),rejected=assert.rejects(pending,{name:'AbortError'}),id=runtime.getStatus().experimentalTrial!.id;
  while(!launches.some(a=>a.includes('--ssd-require-streaming')))await new Promise(r=>setTimeout(r,5));await runtime.cancelExperimentalTrial('00000000-0000-4000-8000-000000000000');assert.equal(runtime.getStatus().experimentalTrial!.state,'loading');assert.equal(runtime.getStatus().experimentalTrial!.id,id);
  await runtime.cancelExperimentalTrial(id);await rejected;assert.equal(runtime.getStatus().experimentalTrial!.state,'cancelled');assert.equal(runtime.getStatus().loadedModel,null);
});

test('late settlement of an old SSD response never cancels or disarms a newer worker',async t=>{
  const {runtime,controls}=await fixture(t);await runtime.startModelTrial(spec.id);const old=await runtime.requestStream('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]});
  await runtime.setMemoryMode('automatic');const current=await runtime.startModelTrial(spec.id),id=runtime.getStatus().experimentalTrial!.id,count=controls.length;let stopped=0;runtime.on('executionStopped',()=>stopped++);await old.body!.cancel();
  assert.equal(controls.length,count,'Old response cleanup must not send controls to the new worker.');assert.equal(stopped,0);assert.equal(runtime.getStatus().experimentalTrial!.id,id);assert.equal(runtime.getStatus().experimentalTrial!.state,'passed');assert.equal((await runtime.prepareModel(spec.id)).baseUrl,current.baseUrl);
});

test('background acquisition keeps its own verification deadline while task preparation obeys the task clock',async t=>{
  const {runtime,directory,launches}=await fixture(t,{}, {integrity:true});runtime.setExecutionRequestTimeout(3600000,()=>0);await runtime.setMemoryMode('ssd-experts');
  const downloaded=await runtime.pullModel(spec.id);assert.equal(downloaded.digest,spec.sha256);assert.equal(downloaded.verificationIO,'darwin-nocache');const hashes=launches.filter(a=>a.includes('--file'));assert(hashes.length>=1);assert(hashes.every(a=>a[a.indexOf('--deadline-ms')+1]==='1800000'));
  await writeFile(path.join(directory,'models',spec.filename),bytes);await assert.rejects(runtime.inspectModel(spec.id,{requireSSDIntegrity:true}),{code:'EXECUTION_TIMEOUT'});assert.equal(launches.filter(a=>a.includes('--file')).length,hashes.length,'Expired task preparation must not start another helper.');runtime.setExecutionRequestTimeout(3600000);
});

test('a failed fixed Chat probe retains exact identity and bounded actual response evidence after rollback',async t=>{
  const {runtime,calls,reopen}=await fixture(t,{FAKE_CHAT_LENGTH:'1'});await assert.rejects(runtime.startModelTrial(spec.id),{code:'EXPERIMENTAL_CHAT_PROBE_FAILED'});const trial=runtime.getStatus().experimentalTrial!,probe=trial.probes!.chat!;
  assert.equal(probe.passed,false);assert.equal(probe.finishReason,'length');assert.equal(probe.content,'');assert.equal(probe.outputTokens,16);assert.equal(probe.requestedOutputTokens,16);assert.equal(probe.reasoningTokens,16);assert.match(probe.reasoning!,/considered/);assert.equal(probe.binding.trialId,trial.id);assert.equal(probe.binding.digest,trial.digest);assert.equal(probe.binding.runtime,trial.engineDigest);assert.equal(probe.binding.profileSignature,trial.profileSignature);
  const row=(await runtime.listModels())[0];assert.equal(row.chatProbe?.status,'failed');assert.equal(row.chatProbe?.digest,trial.digest);assert.equal(row.chatProbe?.templateHash,trial.templateDigest);assert.equal(row.chatProbe?.runtime,trial.engineDigest);assert.equal(row.chatProbe?.profileSignature,trial.profileSignature);assert.equal(row.toolProbe?.status,'unverified');assert.equal(runtime.getStatus().loadedModel,null);
  const request=JSON.parse(calls[0]);assert.equal(request.max_tokens,16);assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.deepEqual(request.messages,[{role:'user',content:'Reply with exactly the two letters OK. Do not include punctuation, formatting, or any other text.'}]);assert.match(trial.error!.message,/finish=length, output tokens=16\/16/);
  await runtime.stop();const next=await reopen(),history=next.getStatus().trialHistory!;assert.equal(history[0].state,'failed');assert.equal(history[0].checks.chat,'failed');assert.equal(history[0].checks.tools,'unverified');assert.deepEqual(history[0].probes?.chat,probe);assert.equal(history[0].artifactSetDigest,trial.digest);assert.equal(history[0].patchDigest,trial.patchDigest);assert.equal(next.getStatus().loadedModel,null);assert.equal(next.getStatus().experimentalTrial,null);assert.equal(next.getStatus().memoryMode,'automatic');assert.equal((await next.listModels())[0].chatProbe?.status,'unverified','A historical failure remains inspectable without becoming current readiness evidence.');
});

test('historical successful probes never substitute for an explicit SSD activation record',async t=>{
  const {runtime,directory,reopen}=await fixture(t);await runtime.startModelTrial(spec.id);const successful=runtime.getStatus().experimentalTrial!;await runtime.stop();await rm(path.join(directory,'ssd-trials.json'));
  const next=await reopen();assert.equal(next.getStatus().trialHistory![0].checks.chat,'passed');assert.equal(next.getStatus().trialHistory![0].id,successful.id);assert.equal(next.getStatus().loadedModel,null);await next.inspectModel(spec.id);const row=(await next.listModels())[0];assert.equal(row.historicalBindingVerified,false);assert.equal(row.useBlocker?.code,'INSUFFICIENT_MEMORY');await next.setMemoryMode('ssd-experts');await assert.rejects(next.prepareModel(spec.id),{code:'SSD_TRIAL_REQUIRED'});
});

test('fixed Chat correctness is not relaxed when a response looks close to the expected answer',async t=>{
  const {runtime}=await fixture(t,{FAKE_CHAT_WRONG_REPLY:'1'});await assert.rejects(runtime.startModelTrial(spec.id),{code:'EXPERIMENTAL_CHAT_PROBE_FAILED'});const probe=runtime.getStatus().experimentalTrial!.probes!.chat!;assert.equal(probe.content,'OK.');assert.equal(probe.finishReason,'stop');assert.equal(probe.outputTokens,3);assert.equal(probe.requestedOutputTokens,16);assert.equal(probe.passed,false);assert.equal((await runtime.listModels())[0].chatProbe!.status,'failed');assert.equal(runtime.getStatus().loadedModel,null);
});

test('failed fixed tool calibration keeps actual diagnostic evidence while the model remains Chat-only',async t=>{
  const {runtime,calls}=await fixture(t,{FAKE_CALIBRATE_FAIL:'1'});const prepared=await runtime.startModelTrial(spec.id);assert.equal(prepared.toolCapable,false);const trial=runtime.getStatus().experimentalTrial!,probe=trial.probes!.tools!;
  assert.equal(probe.passed,false);assert.equal(probe.requestedOutputTokens,96);assert.equal(probe.outputTokens,null,'Missing output usage must remain unmeasured.');assert.equal(probe.toolCallCount,0);assert.equal((await runtime.listModels())[0].toolProbe!.status,'failed');assert.equal(JSON.parse(calls[1]).max_tokens,96);
});

test('remaining execution time bounds each native request and expired tasks make no new inference',async t=>{
  const {runtime,controls,calls}=await fixture(t);await runtime.startModelTrial(spec.id);let remaining=1200;runtime.setExecutionRequestTimeout(4*60*60*1000,()=>remaining);
  await runtime.requestJson('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]});assert.deepEqual(controls.at(-2),{deadlineMs:1200});assert.deepEqual(controls.at(-1),{idle:true});
  remaining=0;const count=calls.length;await assert.rejects(runtime.requestJson('/v1/chat/completions',{messages:[]}),{code:'EXECUTION_TIMEOUT'});assert.equal(calls.length,count);
  runtime.setExecutionRequestTimeout(4*60*60*1000);await runtime.requestJson('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]});assert.deepEqual(controls.at(-2),{deadlineMs:4*60*60*1000},'Clearing a finished task clock restores the next explicit request deadline.');
});

test('failed deadline settlement stops the worker and cancels pending actions before waiting',async t=>{
  const {runtime,controls,launches,calls}=await fixture(t,{FAKE_IDLE_FAIL_AFTER_PROBES:'1'});await runtime.startModelTrial(spec.id);let stopped=0;
  runtime.on('executionStopped',event=>{assert.equal(event.code,'SSD_INFERENCE_INTERRUPTED');stopped++;assert.notEqual((controls.at(-1) as {cancel?:boolean})?.cancel,true,'The stop event must precede the cancellation control request.');});
  await assert.rejects(runtime.requestJson('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]}),{code:'SSD_CONTROL_FAILED'});
  assert.equal(stopped,1);assert.equal(runtime.getStatus().loadedModel,null);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,1);assert.equal(calls.length,3);
});

test('an inference transport timeout before headers stops the owned SSD worker without replay',async t=>{
  const {runtime,controls,launches}=await fixture(t,{FAKE_HEADER_DELAY_AFTER_PROBES:'1'});await runtime.startModelTrial(spec.id);let stopped=0;runtime.on('executionStopped',()=>{stopped++;assert.notEqual((controls.at(-1) as {cancel?:boolean})?.cancel,true);});
  await assert.rejects(runtime.requestJson('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]},undefined,20),{name:'TimeoutError'});
  assert.equal(stopped,1);assert.equal(runtime.getStatus().loadedModel,null);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,1);
});

test('native full-load fallback, invalid I/O, and incomplete ledger never reach model probes',async t=>{
  for(const env of [{FAKE_SSD_FALLBACK:'1'},{FAKE_SSD_BAD_IO:'1'},{FAKE_SSD_LEDGER:'1'}]){
    const {runtime,calls,launches}=await fixture(t,env);await runtime.setMemoryMode('low-memory');
    await assert.rejects(runtime.startModelTrial(spec.id,'ssd-experts'));assert.equal(calls.length,0);assert.equal(runtime.getStatus().memoryMode,'low-memory');assert.equal(runtime.getStatus().state,'ready');assert.equal(runtime.getStatus().experimentalTrial?.state,'failed');assert.equal(launches.filter(a=>a.includes('--model')).length,1);
  }
});

test('insufficient expert-cache budget rejects before spawning weights and restores prior mode',async t=>{
  const {runtime,launches}=await fixture(t,{}, {available:2*GIB});await runtime.setMemoryMode('low-memory');
  await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_WORKSPACE_INSUFFICIENT'});assert.equal(runtime.getStatus().memoryMode,'low-memory');assert.equal(launches.filter(a=>a.includes('--model')).length,0);
});

test('a verified no-allocation native plan can admit a constrained profile without lowering its memory guard',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_SSD_SMALL_LEDGER:'1'}, {available:2*GIB,planner:true});const prepared=await runtime.startModelTrial(spec.id);assert.equal(prepared.probePassed,true);const trial=runtime.getStatus().experimentalTrial!;
  assert.equal(trial.resourceBudgetBytes,GIB);assert.equal(trial.allocationBudgetBytes,GIB/2);assert.equal(trial.memoryPlan?.noAlloc,true);assert.equal(trial.memoryPlan?.modelPayloadAllocatedBytes,0);assert.equal(trial.memoryPlan?.mappedColdBytes,0);assert(trial.memoryPlan!.ledger.totalBytes<GIB/2);
  assert.equal(launches.filter(a=>a.includes('--cache-slots')).length,1);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,1);
});

test('loading peak is admitted separately from the steady ledger before any weight allocation',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_PLAN_LOADING_PEAK:'1'}, {available:2*GIB,planner:true});await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_WORKSPACE_INSUFFICIENT'});
  const plan=runtime.getStatus().experimentalTrial!.memoryPlan!;assert(plan.ledger.totalBytes<GIB/2);assert.equal(plan.loadingPeakBytes,GIB);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
});

test('a planner that loads payloads cannot authorize model allocation even with spare memory',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_PLAN_PAYLOAD:'1'}, {planner:true});await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_PLAN_INVALID'});assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);assert.equal(runtime.getStatus().memoryMode,'automatic');
});

test('available memory is remeasured after planning and lower headroom blocks allocation',async t=>{
  const {runtime,launches}=await fixture(t,{}, {planner:true,available:20*GIB,availableAfterPlan:1.5*GIB});await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_WORKSPACE_INSUFFICIENT'});
  assert.equal(runtime.getStatus().experimentalTrial?.resourceBudgetBytes,GIB/2);assert.equal(runtime.getStatus().experimentalTrial?.allocationBudgetBytes,0);assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
});

test('native physical-footprint limit and stale sampling fail closed without replay',async t=>{
  for(const env of [{FAKE_SSD_OVER:'1'},{FAKE_SSD_STALE:'1'}]){
    const {runtime,launches}=await fixture(t,env);await assert.rejects(runtime.startModelTrial(spec.id));assert.equal(runtime.getStatus().experimentalTrial?.state,'failed');assert.equal(runtime.getStatus().loadedModel,null);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
  }
});

test('SSD cancellation settles once, preserves verified files, and rolls back settings',async t=>{
  const {runtime,directory,launches}=await fixture(t,{FAKE_HEALTH_DELAY:'1'});await runtime.setMemoryMode('low-memory');const controller=new AbortController();
  const trial=runtime.startModelTrial(spec.id,'ssd-experts',{signal:controller.signal});const rejected=assert.rejects(trial,{name:'AbortError'});await new Promise(r=>setTimeout(r,150));controller.abort();await rejected;
  assert.equal(runtime.getStatus().memoryMode,'low-memory');assert.equal(runtime.getStatus().experimentalTrial?.state,'cancelled');assert.deepEqual(await readFile(path.join(directory,'models',spec.filename)),bytes);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
});

test('reopening preserves matching SSD consent but performs no load until explicit preparation',async t=>{
  const {runtime,directory}=await fixture(t);const first=await runtime.startModelTrial(spec.id);await runtime.stop();const launches:string[][]=[];
  const reopened=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:{...hardware,availableMemoryBytes:12*GIB},ssdTestEngine:{executablePath:process.execPath,patchDigest:'d'.repeat(64),fixtureParityReportDigest:'c'.repeat(64)},ssdLoadTimeoutMs:2000,ssdCalibrationTimeoutMs:2000,stopTimeoutMs:500,resourceIntervalMs:20,resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:90*1024**2,availableMemoryBytes:12*GIB,pressure:'normal'}),spawn:(_command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],options);}});t.after(()=>reopened.stop());
  await reopened.start();await reopened.setMemoryMode('ssd-experts');assert.equal(reopened.getStatus().baseUrl,null);assert.equal(launches.filter(a=>a.includes('--model')).length,0);
  await reopened.inspectModel(spec.id);const row=(await reopened.listModels())[0];assert.equal(row.historicalBindingVerified,true);assert.equal(row.needsPreparation,true);assert.equal(row.useBlocker,null);
  const second=await reopened.prepareModel(spec.id);assert.equal(second.digest,first.digest);assert.notEqual(second.profileSignature,first.profileSignature,'Fresh available RAM must change the bounded profile identity.');assert.equal(reopened.getStatus().experimentalTrial?.resourceBudgetBytes,11*GIB);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
});

test('legacy mmap evidence never admits a cold SSD load',async t=>{
  const {runtime,directory}=await fixture(t);await runtime.startModelTrial(spec.id);await runtime.stop();const records=JSON.parse(await readFile(path.join(directory,'ssd-trials.json'),'utf8'));records[0].mode='experimental-disk';await writeFile(path.join(directory,'ssd-trials.json'),JSON.stringify(records));const launches:string[][]=[];
  const reopened=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware,ssdTestEngine:{executablePath:process.execPath,patchDigest:'d'.repeat(64),fixtureParityReportDigest:'c'.repeat(64)},spawn:(_command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],options);}});t.after(()=>reopened.stop());await reopened.start();await reopened.setMemoryMode('ssd-experts');
  await assert.rejects(reopened.prepareModel(spec.id),{code:'SSD_TRIAL_REQUIRED'});assert.equal(launches.filter(a=>a.includes('--model')).length,0);
});

test('a changed worker patch invalidates stored SSD consent before model loading',async t=>{
  const {runtime,directory}=await fixture(t);await runtime.startModelTrial(spec.id);await runtime.stop();const launches:string[][]=[];
  const reopened=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware,ssdTestEngine:{executablePath:process.execPath,patchDigest:'e'.repeat(64),fixtureParityReportDigest:'c'.repeat(64)},spawn:(_command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],options);}});t.after(()=>reopened.stop());await reopened.start();await reopened.setMemoryMode('ssd-experts');
  await assert.rejects(reopened.prepareModel(spec.id),{code:'SSD_TRIAL_REQUIRED'});assert.equal(launches.filter(a=>a.includes('--model')).length,0);
});

test('changing cold model bytes during a live SSD trial stops without repeating model preparation',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.startModelTrial(spec.id);const actions=new AbortController();let stopped=0,wasStillOwned=false;runtime.on('executionStopped',event=>{stopped++;assert.equal(event.model,spec.id);assert.equal(event.code,'MODEL_CHANGED');wasStillOwned=runtime.getStatus().loadedModel===spec.id;actions.abort(new DOMException('The model stopped.','AbortError'));});
  const pendingApproval=new Promise<void>((_resolve,reject)=>actions.signal.addEventListener('abort',()=>reject(actions.signal.reason),{once:true})),rejected=assert.rejects(pendingApproval,{name:'AbortError'});
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;await writeFile(path.join(directory,'models',spec.filename),changed);await rejected;
  const deadline=Date.now()+2000;while((runtime.getStatus().experimentalTrial?.state!=='failed'||runtime.getStatus().loadedModel!==null)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(runtime.getStatus().experimentalTrial?.state,'failed');assert.equal(runtime.getStatus().experimentalTrial?.error?.code,'MODEL_CHANGED');assert.equal(runtime.getStatus().loadedModel,null);assert.equal(launches.filter(a=>a.includes('--model')).length,1);assert.equal(stopped,1);assert(wasStillOwned,'Stop notification must abort pending actions before awaiting worker termination.');
});

test('SSD telemetry requires exact complete groups, slot floor, ledger, and fresh footprint',()=>{
  const ledger={denseBytes:1,expertCacheBytes:2,stagingBytes:3,contextBytes:4,recurrentBytes:5,scratchBytes:6,uploadBytes:7,reservedBytes:8,totalBytes:36};
  const status={workerIdentity:'free-local-agent-ssd-v1',baseCommit:'d81235049384534c167caea52b85a694f6103d14',patchSha256:'d'.repeat(64),expectedGroups:30,streamedGroups:30,ioMode:'darwin-nocache',cacheSlotsPerLayer:24,expertCacheBytes:2,allocationBudgetBytes:40,residentLimitBytes:45,ledger,sampledAt:new Date().toISOString(),physicalFootprintBytes:10,rssBytes:9};const expected={patchDigest:'d'.repeat(64),minimumSlotsPerLayer:24,expectedGroups:30,allocationBudgetBytes:40};
  assert.equal(validateSSDStreamingStatus(status,expected),status);
  for(const bad of [{...status,streamedGroups:29},{...status,cacheSlotsPerLayer:23},{...status,ioMode:'buffered'},{...status,ledger:{...ledger,totalBytes:35}},{...status,sampledAt:new Date(Date.now()-20000).toISOString()}])assert.throws(()=>validateSSDStreamingStatus(bad,expected));
});


test('missing numerical proof blocks SSD use without blocking oversized downloads or loading weights',async t=>{
  const {runtime,launches}=await fixture(t,{}, {parity:false});await runtime.inspectModel(spec.id);
  const row=(await runtime.listModels())[0];assert.equal(row.trialBlocker?.code,'SSD_PARITY_UNVERIFIED');assert.equal(row.acquisitionBlocker,null);
  await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_PARITY_UNVERIFIED'});assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
});

test('CPU SSD binds enforced kernel flags, thread counts and numerical certificate into live identity',async t=>{
  const {runtime,launches}=await fixture(t);const prepared=await runtime.startModelTrial(spec.id),trial=runtime.getStatus().experimentalTrial!,args=launches.find(a=>a.includes('--ssd-require-streaming'))!;
  assert.equal(args.includes('--no-repack'),true);assert.equal(args[args.indexOf('--threads')+1],'4');assert.equal(args[args.indexOf('--threads-batch')+1],'4');assert.equal(trial.backendValidation,'validated');assert.equal(trial.parityReportDigest,'c'.repeat(64));
  const profile=JSON.parse(prepared.profileSignature!);assert.equal(profile.cpuKernel,'standard');assert.equal(profile.useExtraBufts,false);assert.equal(profile.decodeThreads,4);assert.equal(profile.batchThreads,4);assert.equal(profile.parityReportDigest,trial.parityReportDigest);assert(profile.backendArguments.includes('--no-repack'));
});

test('worker and planner must freshly confirm standard CPU computation before probes',async t=>{
  for(const env of [{FAKE_SSD_BAD_KERNEL:'1'},{FAKE_SSD_REPACK:'1'},{FAKE_SSD_BAD_THREADS:'1'},{FAKE_SSD_SMALL_CONTEXT:'1'},{FAKE_PLAN_BAD_KERNEL:'1'}]){
    const {runtime,calls}=await fixture(t,env,{planner:true});await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_PARITY_UNVERIFIED'});assert.equal(calls.length,0);assert.equal(runtime.getStatus().loadedModel,null);
  }
});

test('isolated QA probes cannot write production consent even when their local Chat and tools pass',async t=>{
  const {runtime,directory}=await fixture(t,{}, {parity:false,qaBackend:'cpu'});await runtime.startModelTrial(spec.id);const trial=runtime.getStatus().experimentalTrial!;
  assert.equal(trial.backendValidation,'qa-unvalidated');assert.equal(trial.parityReportDigest,undefined);await assert.rejects(readFile(path.join(directory,'ssd-trials.json')),{code:'ENOENT'});assert.equal((await runtime.listModels())[0].historicalBindingVerified,false);
});

test('legacy CPU consent lacking its exact report and kernel binding stays unusable',async t=>{
  const {runtime,directory,reopen}=await fixture(t);await runtime.startModelTrial(spec.id);await runtime.stop();const records=JSON.parse(await readFile(path.join(directory,'ssd-trials.json'),'utf8'));records[0].backendValidation='cpu-baseline';delete records[0].parityReportDigest;await writeFile(path.join(directory,'ssd-trials.json'),JSON.stringify(records));
  const next=await reopen();await next.inspectModel(spec.id);assert.equal((await next.listModels())[0].historicalBindingVerified,false);await next.setMemoryMode('ssd-experts');await assert.rejects(next.prepareModel(spec.id),{code:'SSD_TRIAL_REQUIRED'});
});


test('production manifest requires a parsed integrity-covered exact-model/profile numerical report',async t=>{
  const good=await fixture(t,{}, {productionProof:'valid'});const prepared=await good.runtime.startModelTrial(spec.id);assert.equal(prepared.backendValidation,'validated');assert.match(good.runtime.getStatus().experimentalTrial!.parityReportDigest!,/^[a-f0-9]{64}$/);
  for(const productionProof of ['missing','malformed','mismatch','bad-profile','wrong-model'] as const){
    const {runtime,launches}=await fixture(t,{}, {productionProof});assert.equal(runtime.getStatus().ssdEngineReady,true);await runtime.inspectModel(spec.id);assert.equal((await runtime.listModels())[0].trialBlocker?.code,'SSD_PARITY_UNVERIFIED');await assert.rejects(runtime.startModelTrial(spec.id),{code:'SSD_PARITY_UNVERIFIED'});assert.equal(launches.filter(a=>a.includes('--ssd-require-streaming')).length,0);
  }
});

test('tampered saved profile kernel/thread/report bindings never reopen as valid consent',async t=>{
  for(const change of [{decodeThreads:8},{cpuKernel:'default'},{parityReportDigest:'1'.repeat(64)},{backendArguments:['--threads','8']}]){
    const {runtime,directory,reopen}=await fixture(t);await runtime.startModelTrial(spec.id);await runtime.stop();const records=JSON.parse(await readFile(path.join(directory,'ssd-trials.json'),'utf8'));records[0].profileSignature=JSON.stringify({...JSON.parse(records[0].profileSignature),...change});await writeFile(path.join(directory,'ssd-trials.json'),JSON.stringify(records));const next=await reopen();await next.inspectModel(spec.id);assert.equal((await next.listModels())[0].historicalBindingVerified,false);await next.setMemoryMode('ssd-experts');await assert.rejects(next.prepareModel(spec.id),{code:'SSD_TRIAL_REQUIRED'});
  }
});
