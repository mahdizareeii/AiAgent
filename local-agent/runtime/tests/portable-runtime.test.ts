import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test,type TestContext } from 'node:test';
import { LocalInferenceRuntime,isPortableModel,type CuratedModel,type RuntimeOptions,type HardwareInfo } from '../index.ts';
import { GIB } from '../hardware.ts';
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str=(v:string)=>Buffer.concat([u64(Buffer.byteLength(v)),Buffer.from(v)]);
const entry=(k:string,v:string)=>Buffer.concat([str(k),u32(8),str(v)]);
const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(3),entry('general.architecture','qwen35'),entry('general.name','Synthetic CPU candidate'),entry('tokenizer.chat_template','{{messages|tojson}}'),str('token_embd.weight'),u32(2),u64(8),u64(1),u32(0),u64(0)]);
const bytes=Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32)]);
const spec:CuratedModel={id:'fixture:portable-cpu',title:'Synthetic portable candidate',description:'Fixture, no hardware qualification',estimatedDownloadBytes:bytes.length,minimumMemoryGB:8,workingMemoryGB:2,profileMemoryGB:{4096:2},license:'fixture',sourceUrl:'',quantization:'F32',repository:'fixture/portable',revision:'a'.repeat(40),filename:'portable.gguf',sha256:createHash('sha256').update(bytes).digest('hex'),architecture:'qwen35',toolCapable:true,lowRamCandidate:{profile:'portable-cpu-4k-v1',evidence:'unverified',metadataUrl:'https://example.invalid/fixture'}};
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'Synthetic 8GiB',cpuCores:4,totalMemoryBytes:8*GIB,availableMemoryBytes:7*GIB,freeDiskBytes:30*GIB,gpus:[]};
const fake=fileURLToPath(new URL('./fake-engine.cjs',import.meta.url));
async function fixture(t:TestContext,env:NodeJS.ProcessEnv={},settings:Partial<RuntimeOptions>={}){const root=await mkdtemp(path.join(tmpdir(),'portable-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'models'));await writeFile(path.join(root,'models',spec.filename),bytes);const launches:string[][]=[];const runtime=new LocalInferenceRuntime({dataDirectory:root,catalog:[spec],hardware,executablePath:process.execPath,nativePlannerTestOutput:()=> 'Host 16 64 16\n',resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:64*1024**2,rssBytes:64*1024**2,physicalFootprintBytes:64*1024**2,availableMemoryBytes:7*GIB,pressure:'normal'}),resourceIntervalMs:60000,stopTimeoutMs:500,...settings,spawn:(_command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],{...options,env:{...options.env,FAKE_PORTABLE_PROFILE:'1',...env}});}});t.after(()=>runtime.stop());return {runtime,launches};}

test('the CPU candidate uses one exact planned4K profile and actual startup/chat/tool-result checks',async t=>{
  const {runtime,launches}=await fixture(t);await runtime.refreshHardware();const before=(await runtime.listModels())[0];assert.equal(before.fit,'slow');assert.equal(before.useBlocker,null);assert.equal(before.preparationProfile,'portable-cpu-4k-v1');assert.match(before.fitReason,/selected automatically/);const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.contextTokens,4096);assert.equal(prepared.outputTokens,1024);assert.equal(prepared.memoryMode,'low-memory');assert.equal(prepared.toolCapable,true);assert.equal(prepared.portableMemoryPlan?.kind,'portable-cpu-4k-v1');assert.match(prepared.profileSignature!,/portableMemoryPlanDigest/);assert.equal(prepared.nativeMemoryPlan,undefined);
  const args=launches.find(a=>a.includes('--model'))!;assert.equal(args[args.indexOf('--n-gpu-layers')+1],'0');assert.equal(args[args.indexOf('--flash-attn')+1],'off');assert(args.includes('--no-repack'));assert(args.includes('--no-op-offload'));assert.equal(args[args.indexOf('--threads')+1],'4');assert.equal(args[args.indexOf('--cache-type-k')+1],'f16');assert.equal(args[args.indexOf('--batch-size')+1],'64');assert.equal(args[args.indexOf('--ubatch-size')+1],'32');
  const row=(await runtime.listModels())[0];assert.equal(row.needsPreparation,false);assert.equal(row.fit,'recommended');assert.equal(row.chatProbe?.status,'passed');assert.equal(row.toolProbe?.status,'passed');assert.equal(launches.filter(a=>a.includes('--model')).length,1);
});

test('the 4B reference shares the portable CPU profile only on an actual at-most8GiB hardware observation',async t=>{
  const reference={...spec,id:'qwen3.5:4b',lowRamCandidate:undefined};
  assert.equal(isPortableModel(reference,hardware),true);assert.equal(isPortableModel(reference,{totalMemoryBytes:8*GIB+1}),false);assert.equal(isPortableModel(reference,{totalMemoryBytes:24*GIB}),false);assert.equal(isPortableModel(reference,null),false);assert.equal(isPortableModel(spec,{totalMemoryBytes:24*GIB}),true);
  const {runtime,launches}=await fixture(t,{}, {catalog:[reference]});const prepared=await runtime.prepareModel(reference.id);assert.equal(prepared.contextTokens,4096);assert.equal(prepared.outputTokens,1024);assert.equal(prepared.portableMemoryPlan?.kind,'portable-cpu-4k-v1');assert.equal(prepared.toolCapable,true);const args=launches.find(a=>a.includes('--model'))!;assert.equal(args[args.indexOf('--n-gpu-layers')+1],'0');assert.equal(args[args.indexOf('--threads')+1],'4');assert.equal((await runtime.listModels())[0].needsPreparation,false);
  assert.equal((await runtime.listModels())[0].preparationProfile,'portable-cpu-4k-v1');const legacy=await fixture(t,{}, {catalog:[reference],hardware:{...hardware,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB}});await legacy.runtime.refreshHardware();assert.equal((await legacy.runtime.listModels())[0].preparationProfile,undefined,'The24GiB reference remains a separate legacy route.');
});

test('legacy27B/30B profiles expose the unsupported backend before preparation on other platforms',async t=>{
  for(const platform of ['linux','win32'] as const)for(const id of ['qwen3.8:27b-q3-k-m','muse-glimmer:30b-q3-k-m']){
    const large={...spec,id,lowRamCandidate:undefined};const detected:HardwareInfo={...hardware,platform,architecture:'x64',totalMemoryBytes:64*GIB,availableMemoryBytes:60*GIB,gpus:[{name:'Synthetic GPU with ample memory',backend:'vulkan',totalMemoryBytes:48*GIB,freeMemoryBytes:48*GIB,unifiedMemory:false}]};
    const {runtime,launches}=await fixture(t,{}, {catalog:[large],hardware:detected});await runtime.refreshHardware();assert.equal(runtime.getStatus().recommendation.feasibleModels?.includes(id),false);const row=(await runtime.listModels())[0];assert.equal(row.installed,true);assert.equal(row.fit,'insufficient');assert.equal(row.useBlocker?.code,'MODEL_BACKEND_UNSUPPORTED');assert.match(row.useBlocker!.message,/requires Apple Silicon Metal/);assert.match(row.useBlocker!.message,/Choose a portable 4K CPU candidate/);assert.equal(row.fitReason,row.useBlocker!.message);await assert.rejects(runtime.prepareModel(id),{code:'MODEL_BACKEND_UNSUPPORTED',message:row.useBlocker!.message});assert.equal(launches.filter(a=>a.includes('--model')).length,0);
  }
});

test('a package without a verified CPU planner blocks the candidate before any model starts',async t=>{const {runtime,launches}=await fixture(t,{}, {nativePlannerTestOutput:undefined});await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_MEMORY_PLANNER_UNAVAILABLE'});assert.equal(launches.filter(a=>a.includes('--model')).length,0);assert.equal((await runtime.listModels())[0].useBlocker?.code,'MODEL_MEMORY_PLANNER_UNAVAILABLE');});

test('CPU allocation capacity or nonnormal host pressure rejects before model payload loading',async t=>{
  for(const settings of [{nativePlannerTestOutput:()=> 'Host 6000 64 16\n'},{resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:0,availableMemoryBytes:7*GIB,pressure:'warning' as const})}]){const {runtime,launches}=await fixture(t,{},settings);await assert.rejects(runtime.prepareModel(spec.id),{code:'INSUFFICIENT_MEMORY'});assert.equal(launches.filter(a=>a.includes('--model')).length,0);}
});

test('a rejected portable plan and exact host sample survive preparation teardown without becoming readiness evidence',async t=>{
  const at = new Date().toISOString(), measured = {sampledAt:at,residentBytes:0,availableMemoryBytes:4*GIB,pressure:'warning' as const};
  const {runtime,launches}=await fixture(t,{}, {nativePlannerTestOutput:()=> 'Host 6000 64 16\n',resourceProbe:async()=>measured});
  const observations:ReturnType<typeof runtime.getStatus>[]=[];runtime.on('status',status=>{if(status.portableAdmissionDiagnostic)observations.push(status);});
  await assert.rejects(runtime.prepareModel(spec.id),{code:'INSUFFICIENT_MEMORY'});
  const final=JSON.parse(JSON.stringify(runtime.getStatus())) as ReturnType<typeof runtime.getStatus>, diagnostic=final.portableAdmissionDiagnostic!;
  assert.equal(diagnostic.decision,'rejected');assert.equal(diagnostic.code,'INSUFFICIENT_MEMORY');assert.deepEqual(diagnostic.reasons,['capacity','pressure','available-headroom']);
  assert.equal(diagnostic.plan!.model,spec.id);assert.equal(diagnostic.plan!.modelDigest,spec.sha256);assert.equal(diagnostic.plan!.artifactBytes,bytes.length);
  assert.equal(diagnostic.plan!.modelBytes,6001*1024**2);assert.equal(diagnostic.plan!.contextBytes,65*1024**2);assert.equal(diagnostic.plan!.computeBytes,17*1024**2);assert.equal(diagnostic.plan!.processHeadroomBytes,GIB);
  assert.equal(diagnostic.sample.sampledAt,at);assert.equal(diagnostic.sample.availableMemoryBytes,4*GIB);assert.equal(diagnostic.sample.pressure,'warning');
  assert.equal(diagnostic.hardware.totalMemoryBytes,8*GIB);assert.equal(diagnostic.limits.capacityBytes,5*GIB);assert.equal(diagnostic.deficits.capacityBytes,diagnostic.plan!.workingBytes-5*GIB);assert.equal(diagnostic.deficits.availableHeadroomBytes,diagnostic.plan!.workingBytes+GIB-4*GIB);
  assert(observations.some(status=>status.state==='loading'&&status.portableAdmissionDiagnostic?.decision==='rejected'),'The rejection must be emitted before teardown.');
  assert.equal(final.loadedModel,null);assert.equal(final.baseUrl,null);assert.equal(final.portableMemoryPlan,undefined);assert.equal(final.profile,null);assert.equal(final.error!.code,'INSUFFICIENT_MEMORY');assert.equal(launches.filter(a=>a.includes('--model')).length,0);
  final.portableAdmissionDiagnostic!.plan!.modelDigest='e'.repeat(64);assert.equal(runtime.getStatus().portableAdmissionDiagnostic!.plan!.modelDigest,spec.sha256);
  await runtime.stop();assert.equal(runtime.getStatus().portableAdmissionDiagnostic?.decision,'rejected','Stopping an already rejected attempt retains its diagnostic.');
});

test('a fresh portable attempt clears an old rejection before malformed planning and then records only its own successful admission',async t=>{
  let output='Host 6000 64 16\n';const {runtime,launches}=await fixture(t,{}, {nativePlannerTestOutput:()=>output});
  await assert.rejects(runtime.prepareModel(spec.id),{code:'INSUFFICIENT_MEMORY'});assert.equal(runtime.getStatus().portableAdmissionDiagnostic?.decision,'rejected');
  output='Host malformed 64 16\n';await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_MEMORY_PLAN_INVALID'});assert.equal(runtime.getStatus().portableAdmissionDiagnostic,undefined,'Unparsed native output is not relabeled the previous exact allocation.');assert.equal(launches.filter(a=>a.includes('--model')).length,0);
  output='Host 16 64 16\n';await runtime.prepareModel(spec.id);const status=runtime.getStatus();assert.equal(status.portableAdmissionDiagnostic?.decision,'admitted');assert.deepEqual(status.portableAdmissionDiagnostic!.reasons,[]);assert.equal(status.portableAdmissionDiagnostic!.plan!.modelBytes,17*1024**2);assert.equal(status.portableMemoryPlan!.workingBytes,status.portableAdmissionDiagnostic!.plan!.workingBytes);assert.equal(status.loadedModel,spec.id);
});

test('a parsed portable plan survives unavailable startup telemetry with unobserved sample fields and no admitted-plan claim',async t=>{
  const {runtime,launches}=await fixture(t,{}, {resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:-1,availableMemoryBytes:7*GIB,pressure:'normal'})});
  await assert.rejects(runtime.prepareModel(spec.id),{code:'RESOURCE_MONITOR_UNAVAILABLE'});const status=runtime.getStatus(), diagnostic=status.portableAdmissionDiagnostic!;
  assert.equal(diagnostic.decision,'not-evaluated');assert.equal(diagnostic.code,null);assert.equal(diagnostic.plan!.modelDigest,spec.sha256);assert.equal(diagnostic.plan!.modelBytes,17*1024**2);
  assert.equal(diagnostic.sample.sampledAt,null);assert.equal(diagnostic.sample.availableMemoryBytes,null);assert.equal(diagnostic.deficits.availableHeadroomBytes,null);assert.equal(diagnostic.sample.rssBytes,null);
  assert.equal(status.portableMemoryPlan,undefined);assert.equal(status.loadedModel,null);assert.equal(launches.filter(a=>a.includes('--model')).length,0);
});

test('CPU native startup rejects a conflicting output property,F16 precision or four-thread profile',async t=>{
  for(const env of [{FAKE_PORTABLE_WRONG_OUTPUT:'1'},{FAKE_PROFILE_WRONG_KV:'1'},{FAKE_PROFILE_WRONG_THREADS:'1'},{FAKE_PORTABLE_MAPPED_MIB:'32.00'}]){const {runtime}=await fixture(t,env);await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(runtime.getStatus().loadedModel,null);}
});

test('the planned CPU coding profile never becomes ready when the real tool continuation check fails',async t=>{const {runtime}=await fixture(t,{FAKE_CALIBRATE_FAIL:'1'});await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_CALIBRATION_FAILED'});assert.equal(runtime.getStatus().loadedModel,null);assert.equal(runtime.getStatus().baseUrl,null);assert.notEqual((await runtime.listModels())[0].toolProbe?.status,'passed');});

test('the CPU candidate stops its owned process before a request after host pressure becomes unsafe',async t=>{
  let warning=false,sent=false;const fetcher=fetch;const {runtime}=await fixture(t,{}, {resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:64*1024**2,rssBytes:64*1024**2,physicalFootprintBytes:64*1024**2,availableMemoryBytes:7*GIB,pressure:warning?'warning':'normal'}),fetch:async(input,init)=>{if(String(input).endsWith('/v1/chat/completions')&&JSON.parse(String(init?.body)).messages?.[0]?.content==='unsafe request')sent=true;return fetcher(input,init);}});const prepared=await runtime.prepareModel(spec.id);warning=true;await assert.rejects(runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'unsafe request'}],max_tokens:16}),{code:'MODEL_MEMORY_CALIBRATION_FAILED'});assert.equal(sent,false);assert.equal(runtime.getStatus().loadedModel,null);assert.equal(runtime.getStatus().baseUrl,null);
});
