import {generationPolicyForModel} from '../generation.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {LocalInferenceRuntime,MODEL_CATALOG,RuntimeError,plannerExitedAfterSamplerFailure,isAllocationFailure,EXPERIMENTAL_PROFILE_SIGNATURE,ENGINE_COMMIT,inferenceProfileSignature,type CuratedModel,type HardwareInfo,type RuntimeOptions,type ResourceMeasurements} from '../index.ts';
import {classifyModel,GIB,parseDevices,parseMacAvailableMemory} from '../hardware.ts';
import {readGGUFMetadata} from '../gguf.ts';
import {nativeMappedPlacement,museQ3CPUPlacement,museQ3PhysicalCPUBlocks,nativePlacementArguments,type NativeMemoryProfile} from '../memory.ts';
import {QWEN_Q3_CHECKPOINT_POLICY} from '../memory.ts';

const u32=(v:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;};
const u64=(v:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
const str=(v:string)=>{const b=Buffer.from(v);return Buffer.concat([u64(b.length),b]);};
const entry=(k:string,v:string)=>Buffer.concat([str(k),u32(8),str(v)]);
function ggufFixture(architecture='llama',name='Local fixture'){
  const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(3),entry('general.architecture',architecture),entry('general.name',name),entry('tokenizer.chat_template','{{messages|tojson}}'),str('token_embd.weight'),u32(2),u64(8),u64(1),u32(0),u64(0)]);
  return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(8*4)]);
}
const bytes=ggufFixture();
function mixedPlacementFixture(architecture:'qwen35'|'muse-glimmer',numericMuse=false,outputFirst=false,missingLastBlock=false,embeddingLast=false){
  const count=architecture==='qwen35'?65:52,firstGPU=architecture==='qwen35'?(numericMuse?24:2):numericMuse?20:14;
  const names=architecture==='qwen35'?['output.weight','output_norm.weight','token_embd.weight']:['token_embd.weight'];
  const blocks=Array.from({length:count},(_,i)=>`blk.${i}.attn_norm.weight`);if(architecture==='muse-glimmer'&&!numericMuse)blocks.sort();
  for(const name of blocks){names.push(name);if(architecture==='muse-glimmer'&&name==='blk.49.attn_norm.weight')names.push('output.weight');}
  if(architecture==='muse-glimmer')names.push('output_norm.weight');if(outputFirst){names.splice(names.indexOf('output.weight'),1);names.unshift('output.weight');}if(missingLastBlock)names.splice(names.indexOf('blk.51.attn_norm.weight'),1);if(embeddingLast){names.splice(names.indexOf('token_embd.weight'),1);names.push('token_embd.weight');}let offset=0;
  const descriptors=names.map(name=>{const elements=name===`blk.${firstGPU}.attn_norm.weight`?524288:8;const descriptor=Buffer.concat([str(name),u32(1),u64(elements),u32(0),u64(offset)]);offset+=elements*4;return descriptor;});
  const blockCount=Buffer.concat([str(`${architecture}.block_count`),u32(4),u32(count)]);
  const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(names.length),u64(4),entry('general.architecture',architecture),entry('general.name','Mixed fixture'),entry('tokenizer.chat_template','{{messages|tojson}}'),blockCount,...descriptors]);
  return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(offset)]);
}
const spec:CuratedModel={id:'fixture:4b',title:'Fixture',description:'Test model',estimatedDownloadBytes:bytes.length,minimumMemoryGB:8,workingMemoryGB:4,license:'Apache-2.0',sourceUrl:'https://huggingface.co/example/model',quantization:'Q4',repository:'example/model',revision:'a'.repeat(40),filename:'fixture.gguf',sha256:createHash('sha256').update(bytes).digest('hex'),architecture:'llama',toolCapable:true};
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'Fixture',cpuCores:8,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,freeDiskBytes:100*GIB,gpus:[{name:'Metal fixture',backend:'metal',totalMemoryBytes:20*GIB,freeMemoryBytes:20*GIB,unifiedMemory:true}]};
const fake=fileURLToPath(new URL('./fake-engine.cjs',import.meta.url));
async function fixture(t:TestContext,extraEnv:NodeJS.ProcessEnv={},detectedHardware:HardwareInfo=hardware,fetchImplementation?:typeof fetch,options:{installedModel?:boolean;installedBytes?:Buffer;runtimeSettings?:Partial<RuntimeOptions>}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'local-agent-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));if(options.installedModel!==false){await mkdir(path.join(directory,'models'));await writeFile(path.join(directory,'models',spec.filename),options.installedBytes??bytes);}
  const launches:string[][]=[];
  const runtime=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:detectedHardware,startupTimeoutMs:3000,stopTimeoutMs:500,fetch:fetchImplementation,
    env:{...process.env,OPENAI_API_KEY:'secret',LLAMA_ARG_TOOLS:'all',LLAMA_ARG_RPC:'remote:5000',GGML_METAL_NO_RESIDENCY:'ambient-do-not-forward',GGML_METAL_RESIDENCY_KEEP_ALIVE_S:'999'},...options.runtimeSettings,
    spawn:(command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],{...options,env:{...options.env,...extraEnv}});}});
  t.after(()=>runtime.stop());return {runtime,directory,launches};
}

test('a genuinely empty first-run cache initializes the engine without launching inference or reporting a model error',async t=>{
  const {runtime,directory,launches}=await fixture(t,{},hardware,undefined,{installedModel:false});
  assert.deepEqual(await readdir(directory),[]);
  const status=await runtime.start();
  assert.equal(status.state,'ready');assert.equal(status.version,'0.6.0');assert.equal(status.error,null);
  assert.equal(status.baseUrl,null);assert.equal(status.loadedModel,null);assert.equal(status.profile,null);assert.equal(status.downloadingModel,null);
  const models=await runtime.listModels();assert.equal(models.length,1);assert(models.every(model=>!model.installed&&model.digest===null&&model.sizeBytes===0));
  assert.deepEqual(launches,[['--version']]);assert.deepEqual(await readdir(path.join(directory,'models')),[]);
  await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_NOT_FOUND'});
  await assert.rejects(runtime.requestJson('/props'),{code:'RUNTIME_NOT_READY'});
  assert.equal(runtime.getStatus().error,null);assert.equal(runtime.getStatus().state,'ready');
});

test('qualified coding models use exact long Metal profiles and real tool-result continuation',async t=>{
  for(const id of ['qwen3.8:27b','muse-glimmer:30b']){
    const selected={...spec,id};const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[selected]}});
    const prepared=await runtime.prepareModel(id);assert.equal(prepared.contextTokens,32768);assert.equal(prepared.outputTokens,8192);assert.equal(prepared.toolCapable,true);assert.equal(prepared.generationPolicy?.preserveThinking,true);
    const args=launches.find(a=>a.includes('--model'))!;assert.equal(args[args.indexOf('--batch-size')+1],'128');assert.equal(args[args.indexOf('--ubatch-size')+1],'32');assert.equal(args[args.indexOf('--log-verbosity')+1],'4');assert.equal(args.includes('--reasoning-budget'),false);assert.equal(args[args.indexOf('--fit')+1],'off');assert.equal(args[args.indexOf('--n-gpu-layers')+1],'999');assert.equal(args.includes('--fit-target'),false);
    const env=await runtime.requestJson<{metalNoResidency?:string;metalKeepAlive?:string}>('/env');assert.equal(env.metalNoResidency,undefined);assert.equal(env.metalKeepAlive,undefined);
    const rows=await runtime.listModels();assert.equal(rows[0].chatProbe?.diagnostic?.requestedOutputTokens,8192);assert.equal(rows[0].toolProbe?.diagnostic?.requestedOutputTokens,8192);assert.equal(rows[0].toolProbe?.diagnostic?.thinkingDisabled,id!=='muse-glimmer:30b');
    await runtime.stop();
  }
});

test('qualified profiles use 16K fallback for allocation or engine context reduction and never CPU/4K',async t=>{
  for(const env of [{FAKE_QUALIFIED_PRIMARY_ALLOCATION:'1'},{FAKE_QUALIFIED_PRIMARY_SMALL_CONTEXT:'1'}]){
    const id='qwen3.8:27b';const {runtime,launches}=await fixture(t,env,hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}]}});
    const prepared=await runtime.prepareModel(id);assert.equal(prepared.contextTokens,16384);assert.equal(prepared.outputTokens,4096);
    assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--ctx-size')+1]),['32768','16384']);
    assert.equal(runtime.getStatus().profile?.backend,'metal');await assert.rejects(runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});await runtime.stop();
  }
});

test('qualified tool checks reject failed continuation and admission keeps inadequate memory blocked',async t=>{
  const id='muse-glimmer:30b';const {runtime}=await fixture(t,{FAKE_CONTINUATION_FAIL:'1'},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}]}});
  const prepared=await runtime.prepareModel(id);assert.equal(prepared.toolCapable,false);assert.equal((await runtime.listModels())[0].toolProbe?.status,'failed');await runtime.stop();
  const low={...hardware,availableMemoryBytes:7.5*GIB};const blocked=await fixture(t,{},low,undefined,{runtimeSettings:{catalog:[{...spec,id,workingMemoryGB:18.3,profileMemoryGB:{32768:18.3,16384:17.5}}]}});
  await assert.rejects(blocked.runtime.prepareModel(id),{code:'INSUFFICIENT_MEMORY'});assert.equal(blocked.launches.filter(a=>a.includes('--model')).length,0);
  const mismatch=await fixture(t,{FAKE_QUALIFIED_SMALL_CONTEXT:'1'},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}]}});
  await assert.rejects(mismatch.runtime.prepareModel(id),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(mismatch.launches.filter(a=>a.includes('--model')).length,2);
});

test('qualified preparation rejects critical sampled memory and cannot silently use a CPU profile',async t=>{
  const id='qwen3.8:27b',sample:ResourceMeasurements={sampledAt:new Date().toISOString(),residentBytes:GIB,availableMemoryBytes:5*GIB,pressure:'critical'};
  const badMemory=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],resourceProbe:async()=>({...sample,sampledAt:new Date().toISOString()})}});
  await assert.rejects(badMemory.runtime.prepareModel(id),{code:'MODEL_MEMORY_CALIBRATION_FAILED'});assert.equal(badMemory.launches.filter(a=>a.includes('--model')).length,2);assert.equal(badMemory.runtime.getStatus().loadedModel,null);
  const cpu=await fixture(t,{}, {...hardware,gpus:[]},undefined,{runtimeSettings:{catalog:[{...spec,id}]}});
  await assert.rejects(cpu.runtime.prepareModel(id),{code:'MODEL_BACKEND_UNSUPPORTED'});assert.equal(cpu.launches.filter(a=>a.includes('--model')).length,0);
  await assert.rejects(cpu.runtime.startExperimentalTrial(id),{code:'MODEL_MEMORY_MODE_UNSUPPORTED'});
});

test('fresh hardware admission and safe warm reuse do not double-count loaded qualified weights',async t=>{
  const id='qwen3.8:27b',selected={...spec,id,workingMemoryGB:18.9,profileMemoryGB:{32768:18.9,16384:17.9}};let current=hardware;
  const {runtime,launches}=await fixture(t,{}, {...hardware,availableMemoryBytes:7.5*GIB},undefined,{runtimeSettings:{catalog:[selected],refreshHardware:async()=>structuredClone(current),resourceIntervalMs:60000,resourceProbe:async()=>resource(18*GIB,3*GIB)}});
  await runtime.start();assert.equal((await runtime.listModels())[0].needsPreparation,true);
  const prepared=await runtime.prepareModel(id);assert.equal(prepared.contextTokens,32768);
  current={...hardware,availableMemoryBytes:3*GIB,gpus:[{...hardware.gpus[0],freeMemoryBytes:2*GIB}]};await runtime.refreshHardware();
  assert.equal(runtime.getStatus().hardware?.gpus[0].freeMemoryBytes,2*GIB);
  const row=(await runtime.listModels())[0];assert.equal(row.fit,'recommended');assert.equal(row.needsPreparation,false);
  assert.equal((await runtime.prepareModel(id)).contextTokens,32768);assert.equal(launches.filter(args=>args.includes('--model')).length,1);
  await runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'warm request'}],max_tokens:16});
});

test('qualified pre-request memory failure stops owned inference before sending a request',async t=>{
  const id='muse-glimmer:30b';let unsafe=false,sent=false;const nativeFetch=fetch;
  const {runtime,launches}=await fixture(t,{},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions')&&JSON.parse(String(init?.body)).messages?.[0]?.content==='guarded request')sent=true;return nativeFetch(input,init);},{runtimeSettings:{catalog:[{...spec,id}],resourceIntervalMs:60000,resourceProbe:async()=>resource(GIB,3*GIB,unsafe?'critical':'normal')}});
  const stopped:{model:string;code:string;trialId?:string}[]=[];runtime.on('executionStopped',event=>stopped.push(event));const prepared=await runtime.prepareModel(id);unsafe=true;
  await assert.rejects(runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'guarded request'}]}),{code:'MODEL_MEMORY_CALIBRATION_FAILED'});
  assert.equal(sent,false);assert.equal(stopped.length,1);assert.equal(stopped[0].model,id);assert.equal(stopped[0].trialId,undefined);assert.equal(runtime.getStatus().loadedModel,null);assert.equal(runtime.getStatus().baseUrl,null);assert.equal(launches.filter(args=>args.includes('--model')).length,1);
});

test('qualified periodic memory monitoring is serialized and stops only its owned process',async t=>{
  const id='qwen3.8:27b';let unsafe=false,monitoring=false,active=0,peak=0;
  const server=createServer((_request,response)=>response.end('unrelated'));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const {runtime}=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],resourceIntervalMs:10,resourceProbe:async()=>{if(monitoring){active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,35));active--;}return resource(GIB,3*GIB,unsafe?'critical':'normal');}}});
  const stopped:string[]=[];runtime.on('executionStopped',event=>stopped.push(event.code));await runtime.prepareModel(id);monitoring=true;await waitFor(()=>active>0);unsafe=true;
  await waitFor(()=>runtime.getStatus().loadedModel===null);assert.equal(peak,1);assert.deepEqual(stopped,['MODEL_MEMORY_CALIBRATION_FAILED']);assert.equal(server.listening,true);assert.equal(runtime.getStatus().baseUrl,null);
});

test('a delayed qualified memory observation cannot stop a subsequently prepared profile',async t=>{
  const id='qwen3.8:27b';let oldPid:number|undefined,hold=false,blocked=false,release:((sample:ResourceMeasurements)=>void)|undefined;
  const {runtime}=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],resourceIntervalMs:60000,resourceProbe:async pid=>{if(hold&&pid===oldPid){blocked=true;return new Promise(resolve=>{release=resolve;});}return resource(GIB,3*GIB);}}});
  const prepared=await runtime.prepareModel(id);oldPid=(await runtime.requestJson<{pid:number}>('/env')).pid;hold=true;
  const stopped:string[]=[];runtime.on('executionStopped',event=>stopped.push(event.code));
  const oldRequest=assert.rejects(runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'old request'}]}),{name:'AbortError'});await waitFor(()=>blocked);
  await runtime.setMemoryMode('low-memory');const replacement=await runtime.prepareModel(id);assert.equal(replacement.contextTokens,16384);release!(resource(GIB,3*GIB,'critical'));await oldRequest;
  assert.equal(runtime.getStatus().loadedModel,id);assert.equal(runtime.getStatus().profile?.contextTokens,16384);assert.deepEqual(stopped,[]);assert.notEqual((await runtime.requestJson<{pid:number}>('/env')).pid,oldPid);
});

test('hardware refresh probes the current native Metal budget without loading a model',async t=>{
  const {runtime,launches}=await fixture(t,{},hardware,undefined,{installedModel:false,runtimeSettings:{hardware:undefined,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB}});
  await runtime.start();const initial=launches.filter(args=>args.includes('--list-devices')).length;
  const refreshed=await runtime.refreshHardware();assert.equal(refreshed.gpus[0].name,'Apple Test');assert.equal(refreshed.gpus[0].freeMemoryBytes,24000*1024**2);
  assert.equal(launches.filter(args=>args.includes('--list-devices')).length,initial+1);assert.equal(launches.filter(args=>args.includes('--model')).length,0);
});

const nativePlanRows=(profile:{cacheTypeK?:string})=>`MTL0 15088 ${profile.cacheTypeK==='q8_0'?693:1173} 80\nHost 682 0 3\n`;
const nativeMemorySample=(available=9.5*GIB,pressure:'normal'|'warning'|'critical'='normal'):ResourceMeasurements=>({...resource(GIB,available,pressure),physicalFootprintBytes:Math.ceil(1.1*GIB),rssBytes:GIB});

test('mapped calibration uses a pinned allocation plan and16K F16 even when whole working memory exceeds current cache headroom',async t=>{
  const id='qwen3.8:27b',detected={...hardware,availableMemoryBytes:9.5*GIB,gpus:[{...hardware.gpus[0],freeMemoryBytes:17.758789*GIB}]};
  const {runtime,launches}=await fixture(t,{},detected,undefined,{runtimeSettings:{catalog:[{...spec,id,workingMemoryGB:18.9,profileMemoryGB:{32768:18.9,16384:17.9}}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});
  const stages:string[]=[];runtime.on('status',status=>{if(status.preparationStage)stages.push(status.preparationStage);});
  const prepared=await runtime.prepareModel(id);assert.equal(prepared.contextTokens,16384);assert.equal(prepared.outputTokens,4096);assert(prepared.nativeMemoryPlan!.workingBytes>detected.availableMemoryBytes);assert(prepared.nativeMemoryPlan!.gpuAllocationUpperBoundBytes<detected.gpus[0].freeMemoryBytes);
  assert(stages.includes('planning'));assert(stages.includes('loading'));assert(stages.includes('probing'));assert.equal(runtime.getStatus().preparationStage,undefined);
  const identity=JSON.parse(prepared.profileSignature!);assert.equal(identity.cacheTypeK,'f16');assert.equal(identity.cacheTypeV,'f16');assert.equal(identity.flashAttention,'on');assert.match(identity.memoryPlanDigest,/^[a-f0-9]{64}$/);
  assert.equal(launches.filter(args=>args.includes('--model')).length,1);assert.equal((await runtime.listModels())[0].needsPreparation,false);
  await runtime.stop();
});

test('mapped admission can recover with planned16K Q8 but never retries memory pressure',async t=>{
  const id='muse-glimmer:30b';const fixtureOptions={catalog:[{...spec,id}],nativePlannerTestOutput:(profile:{cacheTypeK?:string})=>profile.cacheTypeK==='f16'?'MTL0 20000 1173 80\nHost 682 0 3\n':nativePlanRows(profile),resourceProbe:async()=>nativeMemorySample()};
  const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:fixtureOptions});const prepared=await runtime.prepareModel(id);assert.equal(prepared.contextTokens,16384);assert.equal(JSON.parse(prepared.profileSignature!).cacheTypeK,'q8_0');assert.equal(launches.filter(args=>args.includes('--model')).length,1);await runtime.stop();
  let pressure:'normal'|'warning'='normal';const failure=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample(9.5*GIB,pressure)}});failure.runtime.on('status',status=>{if(status.preparationStage==='probing')pressure='warning';});
  await assert.rejects(failure.runtime.prepareModel(id),{code:'MODEL_MEMORY_CALIBRATION_FAILED'});assert.equal(failure.launches.filter(args=>args.includes('--model')).length,1);assert.equal(failure.runtime.getStatus().loadedModel,null);
});

test('explicit qualified Low memory starts only16K Q8 without a higher-memory allocation fallback',async t=>{
  for(const id of ['qwen3.8:27b','muse-glimmer:30b']){
    const run=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});
    await run.runtime.setMemoryMode('low-memory');const prepared=await run.runtime.prepareModel(id);assert.equal(prepared.contextTokens,16384);assert.equal(prepared.outputTokens,4096);const profile=run.runtime.getStatus().profile!;assert.equal(profile.cacheTypeK,'q8_0');assert.equal(profile.cacheTypeV,'q8_0');assert.equal(profile.flashAttention,'on');assert.equal(profile.batchTokens,64);assert.equal(profile.microBatchTokens,16);assert.equal(JSON.parse(prepared.profileSignature!).memoryMode,'low-memory');
    await assert.rejects(run.runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});assert.equal(run.launches.filter(args=>args.includes('--model')).length,1);await run.runtime.stop();
    const blocked=await fixture(t,{FAKE_ALLOCATE:'all'},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});await blocked.runtime.setMemoryMode('low-memory');await assert.rejects(blocked.runtime.prepareModel(id),{code:'ALLOCATION_FAILED'});const attempts=blocked.launches.filter(args=>args.includes('--model'));assert.equal(attempts.length,1);assert.equal(attempts[0][attempts[0].indexOf('--cache-type-k')+1],'q8_0');assert.equal(attempts[0][attempts[0].indexOf('--ctx-size')+1],'16384');
  }
});

test('explicit mixed coding placement binds verified header spans, shared native arguments and startup evidence',async t=>{
  for(const architecture of ['qwen35','muse-glimmer'] as const){
    const payload=mixedPlacementFixture(architecture),id=architecture==='qwen35'?'qwen3.8:27b':'muse-glimmer:30b';
    const selected={...spec,id,architecture,estimatedDownloadBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};
    const directory=await mkdtemp(path.join(tmpdir(),'agent-mixed-header-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'fixture.gguf');await writeFile(file,payload);const metadata=await readGGUFMetadata(file);
    const profile:NativeMemoryProfile={backend:'metal',contextTokens:16384,outputTokens:4096,batchTokens:64,microBatchTokens:16,cacheTypeK:'q8_0',cacheTypeV:'q8_0',flashAttention:'on',metalResidency:'disabled',nativePlacement:architecture==='qwen35'?{gpuLayers:64,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true}:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:false,cpuBlockIndices:[0,1,10,11,12,13]}};
    const placement=nativeMappedPlacement(metadata,profile)!;const env={FAKE_MAPPED_TOTAL_LAYERS:String(placement.totalLayers),FAKE_MAPPED_METAL_MIB:(placement.metalMappedBytes/1024**2).toFixed(2),FAKE_MAPPED_CPU_MIB:(placement.hostMappedBytes/1024**2).toFixed(2)};
    let planned:NativeMemoryProfile|undefined;const settings={catalog:[selected],nativePlannerTestOutput:(p:NativeMemoryProfile)=>{planned=p;return 'MTL0 2 1 1\nHost 0 0 0';},resourceProbe:async()=>({...nativeMemorySample(),residentBytes:20*1024**2,rssBytes:20*1024**2,physicalFootprintBytes:18*1024**2})};
    const run=await fixture(t,env,hardware,undefined,{installedBytes:payload,runtimeSettings:settings});await run.runtime.setMemoryMode('low-memory');const prepared=await run.runtime.prepareModel(id);
    assert.equal(prepared.toolCapable,true);assert.deepEqual(prepared.nativeMemoryPlan!.mappedPlacement,placement);assert.deepEqual(JSON.parse(prepared.profileSignature!).nativePlacement,profile.nativePlacement);assert.deepEqual(planned!.nativePlacement,profile.nativePlacement);assert.equal(planned!.metalResidency,'disabled');assert.equal(prepared.nativeMemoryPlan!.metalResidency,'disabled');assert.equal(JSON.parse(prepared.profileSignature!).metalResidency,'disabled');const runtimeEnv=await run.runtime.requestJson<{metalNoResidency?:string;metalKeepAlive?:string}>('/env');assert.equal(runtimeEnv.metalNoResidency,'1');assert.equal(runtimeEnv.metalKeepAlive,undefined);
    const args=run.launches.find(a=>a.includes('--model'))!;for(const argument of nativePlacementArguments(profile))assert(args.includes(argument));assert.equal(args.includes('--override-tensor'),true);assert.equal(args[args.indexOf('--log-verbosity')+1],'4');await assert.rejects(run.runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});await run.runtime.stop();
    for(const bad of [{FAKE_PROFILE_WRONG_GPU_SPAN:'1'},{FAKE_PROFILE_WRONG_THREADS:'1'},{FAKE_PROFILE_REPACK:'1'},{FAKE_PROFILE_RESIDENCY:'missing'},{FAKE_PROFILE_RESIDENCY:'true'},{FAKE_PROFILE_RESIDENCY:'broken'},{FAKE_PROFILE_RESIDENCY:'conflicting'}]){
      let probes=0;const badRun=await fixture(t,{...env,...bad},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions'))probes++;return fetch(input,init);},{installedBytes:payload,runtimeSettings:settings});await badRun.runtime.setMemoryMode('low-memory');await assert.rejects(badRun.runtime.prepareModel(id),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(probes,0);assert.equal(badRun.runtime.getStatus().loadedModel,null);assert.equal(badRun.launches.filter(a=>a.includes('--model')).length,1);
    }
  }
});

test('Q3 Automatic uses a fresh verified 16K no-residency profile and Muse derives its own physical prefix',async t=>{
  for(const entry of [{architecture:'qwen35',outputFirst:false,embeddingLast:false},{architecture:'muse-glimmer',outputFirst:false,embeddingLast:false},{architecture:'muse-glimmer',outputFirst:true,embeddingLast:false},{architecture:'muse-glimmer',outputFirst:false,embeddingLast:true}] as const){
    const {architecture,outputFirst,embeddingLast}=entry,id=architecture==='qwen35'?'qwen3.8:27b-q3-k-m':'muse-glimmer:30b-q3-k-m',payload=mixedPlacementFixture(architecture,true,outputFirst,false,embeddingLast),selected={...spec,id,architecture,estimatedDownloadBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};
    const directory=await mkdtemp(path.join(tmpdir(),'agent-q3-header-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'fixture.gguf');await writeFile(file,payload);const metadata=await readGGUFMetadata(file);
    const expectedCPU=architecture==='muse-glimmer'?museQ3PhysicalCPUBlocks(metadata):undefined;
    if(expectedCPU){assert.deepEqual(expectedCPU,Array.from({length:20},(_,i)=>i));const head=museQ3CPUPlacement(metadata);assert.equal(head.outputOnCPU,outputFirst);assert.equal(head.outputNormOnCPU,false);}
    const profile:NativeMemoryProfile={backend:'metal',contextTokens:16384,outputTokens:4096,batchTokens:128,microBatchTokens:32,generationPolicy:generationPolicyForModel(id),cacheTypeK:'q8_0',cacheTypeV:'q8_0',flashAttention:'on',metalResidency:'disabled',nativePlacement:architecture==='qwen35'?{gpuLayers:42,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true,outputNormOnCPU:true}:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,...museQ3CPUPlacement(metadata)}};
    const placement=nativeMappedPlacement(metadata,profile,id)!;if(embeddingLast)assert(placement.hostMappedBytes+placement.metalMappedBytes>payload.length);let planned=0;const env={FAKE_MAPPED_TOTAL_LAYERS:String(placement.totalLayers),FAKE_MAPPED_METAL_MIB:(placement.metalMappedBytes/1024**2).toFixed(2),FAKE_MAPPED_CPU_MIB:(placement.hostMappedBytes/1024**2).toFixed(2)};
    const run=await fixture(t,env,hardware,undefined,{installedBytes:payload,runtimeSettings:{catalog:[selected],nativePlannerTestOutput:()=>{planned++;return 'MTL0 2 1 1\nHost 0 0 0';},resourceProbe:async()=>({...nativeMemorySample(),residentBytes:20*1024**2,rssBytes:20*1024**2,physicalFootprintBytes:18*1024**2})}});
    await run.runtime.start();const before=(await run.runtime.listModels())[0];assert.notEqual(before.chatProbe?.status,'passed');assert.notEqual(before.toolProbe?.status,'passed');
    const prepared=await run.runtime.prepareModel(id);assert.equal(prepared.sourceModel,id);assert.equal(prepared.contextTokens,16384);assert.equal(prepared.outputTokens,4096);assert.equal(prepared.memoryMode,'automatic');assert.equal(run.runtime.getStatus().profile!.batchTokens,128);assert.equal(run.runtime.getStatus().profile!.microBatchTokens,32);assert.equal(prepared.generationPolicy?.kind,architecture==='qwen35'?'qwen38':'muse-glimmer');assert.equal(prepared.nativeMemoryPlan!.model,id);assert.deepEqual(prepared.nativeMemoryPlan!.mappedPlacement,placement);assert.equal(JSON.parse(prepared.profileSignature!).metalResidency,'disabled');assert.deepEqual(JSON.parse(prepared.profileSignature!).nativePlacement,profile.nativePlacement);const args=run.launches.find(a=>a.includes('--model'))!;assert.equal(args[args.indexOf('--batch-size')+1],'128');assert.equal(args[args.indexOf('--ubatch-size')+1],'32');assert.equal(args[args.indexOf('--n-gpu-layers')+1],architecture==='qwen35'?'42':'999');assert.equal(planned,1);await assert.rejects(run.runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});await run.runtime.stop();
    if(!outputFirst&&!embeddingLast){
      for(const corrupt of ['missing','n_batch','n_ubatch','conflicting']){
        let probes=0;const rejected=await fixture(t,{...env,FAKE_PROFILE_CONTEXT_SETTINGS:corrupt},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions'))probes++;return fetch(input,init);},{installedBytes:payload,runtimeSettings:{catalog:[selected],nativePlannerTestOutput:()=> 'MTL0 2 1 1\nHost 0 0 0',resourceProbe:async()=>({...nativeMemorySample(),residentBytes:20*1024**2,rssBytes:20*1024**2,physicalFootprintBytes:18*1024**2})}});
        await assert.rejects(rejected.runtime.prepareModel(id),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(probes,0);assert.equal(rejected.launches.filter(args=>args.includes('--model')).length,1);assert.equal(rejected.runtime.getStatus().loadedModel,null);
      }
    }
  }
  const payload=mixedPlacementFixture('muse-glimmer',true,false,true),selected={...spec,id:'muse-glimmer:30b-q3-k-m',architecture:'muse-glimmer',estimatedDownloadBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};let planned=0;
  const invalid=await fixture(t,{},hardware,undefined,{installedBytes:payload,runtimeSettings:{catalog:[selected],nativePlannerTestOutput:()=>{planned++;return 'MTL0 2 1 1\nHost 0 0 0';}}});await assert.rejects(invalid.runtime.prepareModel(selected.id),{code:'MODEL_MEMORY_PLAN_INVALID'});assert.equal(planned,0);assert.equal(invalid.launches.filter(args=>args.includes('--model')).length,0);
});

test('Qwen Q3 checkpoint allocation is newly attested, host-budgeted and cannot change other profile limits',async t=>{
  const id='qwen3.8:27b-q3-k-m',payload=mixedPlacementFixture('qwen35',true),selected={...spec,id,architecture:'qwen35',estimatedDownloadBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};
  const directory=await mkdtemp(path.join(tmpdir(),'agent-checkpoint-header-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'fixture.gguf');await writeFile(file,payload);const metadata=await readGGUFMetadata(file);
  const profile:NativeMemoryProfile={backend:'metal',contextTokens:16384,outputTokens:4096,batchTokens:128,microBatchTokens:32,cacheTypeK:'q8_0',cacheTypeV:'q8_0',flashAttention:'on',metalResidency:'disabled',generationPolicy:generationPolicyForModel(id),nativePlacement:{gpuLayers:42,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true,outputNormOnCPU:true},recurrentCheckpoint:{...QWEN_Q3_CHECKPOINT_POLICY}};
  const placement=nativeMappedPlacement(metadata,profile,id)!;const env={FAKE_MAPPED_TOTAL_LAYERS:String(placement.totalLayers),FAKE_MAPPED_METAL_MIB:(placement.metalMappedBytes/1024**2).toFixed(2),FAKE_MAPPED_CPU_MIB:(placement.hostMappedBytes/1024**2).toFixed(2)};
  const settings={catalog:[selected],nativePlannerTestOutput:()=> 'MTL0 2 1 1\nHost 0 0 0',resourceProbe:async()=>({...nativeMemorySample(),residentBytes:20*1024**2,rssBytes:20*1024**2,physicalFootprintBytes:18*1024**2})};
  const good=await fixture(t,{...env,FAKE_CHECKPOINT_CREATED:'two-decimal'},hardware,undefined,{installedBytes:payload,runtimeSettings:settings});const prepared=await good.runtime.prepareModel(id);
  assert.deepEqual(JSON.parse(prepared.profileSignature!).recurrentCheckpoint,QWEN_Q3_CHECKPOINT_POLICY);assert.deepEqual(prepared.nativeMemoryPlan!.recurrentCheckpoint,QWEN_Q3_CHECKPOINT_POLICY);assert.equal(prepared.nativeMemoryPlan!.checkpointHostReserveBytes,320*1024**2);assert.equal(prepared.contextTokens,16384);assert.equal(prepared.outputTokens,4096);
  const args=good.launches.find(a=>a.includes('--model'))!;for(const [flag,value] of [['--ctx-checkpoints','1'],['--checkpoint-min-step','8192'],['--cache-ram','0'],['--parallel','1'],['--batch-size','128'],['--ubatch-size','32'],['--cache-type-k','q8_0'],['--cache-type-v','q8_0']])assert.equal(args[args.indexOf(flag)+1],value);assert(args.includes('--no-cache-idle-slots'));assert(args.includes('--no-context-shift'));assert(args.includes('--no-repack'));assert.equal(args.includes('--draft-model'),false);
  const stopped:string[]=[];good.runtime.on('executionStopped',event=>stopped.push(event.code));await good.runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'checkpoint corruption'}]}).catch(()=>{});await waitFor(()=>good.runtime.getStatus().loadedModel===null);assert.deepEqual(stopped,['MODEL_PROFILE_MISMATCH']);assert.equal(good.launches.filter(a=>a.includes('--model')).length,1);await good.runtime.stop();
  for(const bad of [{FAKE_CHECKPOINT_POLICY:'missing'},{FAKE_CHECKPOINT_POLICY:'count'},{FAKE_CHECKPOINT_POLICY:'spacing'},{FAKE_CHECKPOINT_POLICY:'conflicting'},{FAKE_CHECKPOINT_LAYOUT:'missing'},{FAKE_CHECKPOINT_LAYOUT:'rollback'},{FAKE_CHECKPOINT_LAYOUT:'precision'},{FAKE_CHECKPOINT_CREATED:'missing'},{FAKE_CHECKPOINT_CREATED:'oversized'}]){
    let probes=0;const run=await fixture(t,{...env,...bad},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions'))probes++;return fetch(input,init);},{installedBytes:payload,runtimeSettings:settings});await assert.rejects(run.runtime.prepareModel(id),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(run.runtime.getStatus().loadedModel,null);assert.equal(run.launches.filter(a=>a.includes('--model')).length,1);if('FAKE_CHECKPOINT_POLICY' in bad||'FAKE_CHECKPOINT_LAYOUT' in bad)assert.equal(probes,0);await run.runtime.stop();
  }
});

test('mapped memory failures report exact sampled guard metrics once and preserve terminal pressure behavior',async t=>{
  for(const guard of ['normal-pressure','available-headroom','owned-residency']){
    let unsafe=false;const sampledAt=new Date().toISOString(),safe=nativeMemorySample();
    const failing={...safe,sampledAt,...(guard==='normal-pressure'?{pressure:'warning' as const}:guard==='available-headroom'?{availableMemoryBytes:512*1024**2}:{residentBytes:18*GIB,rssBytes:18*GIB,physicalFootprintBytes:18*GIB})};
    const run=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceIntervalMs:60000,resourceProbe:async()=>unsafe?failing:{...safe,sampledAt:new Date().toISOString()}}});
    const logs:string[]=[];run.runtime.on('log',text=>{if(text.startsWith('CODING_RESOURCE_FAILURE '))logs.push(text);});const prepared=await run.runtime.prepareModel('qwen3.8:27b');assert.equal(logs.length,0);unsafe=true;
    await assert.rejects(run.runtime.requestJson('/v1/chat/completions',{model:prepared.model,messages:[{role:'user',content:'must not run'}]}),error=>{assert(error instanceof RuntimeError);assert.equal(error.code,'MODEL_MEMORY_CALIBRATION_FAILED');for(const fragment of [guard,`pressure=${failing.pressure}`,sampledAt,'available=','RSS=','physical footprint=','resident bound=','plan working='])assert(error.message.includes(fragment));return true;});
    assert.equal(logs.length,1);assert(logs[0].length<2048);const metrics=JSON.parse(logs[0].slice('CODING_RESOURCE_FAILURE '.length));assert.deepEqual(metrics.guards,[guard]);assert.equal(metrics.sampledAt,sampledAt);assert.equal(metrics.pressure,failing.pressure);assert.equal(metrics.availableMemoryBytes,failing.availableMemoryBytes);assert.equal(metrics.rssBytes,failing.rssBytes);assert.equal(metrics.physicalFootprintBytes,failing.physicalFootprintBytes);assert.equal(metrics.residentLimitBytes,prepared.nativeMemoryPlan!.workingBytes);assert.equal(metrics.planWorkingBytes,prepared.nativeMemoryPlan!.workingBytes);assert.equal(metrics.planGpuAllocationBytes,prepared.nativeMemoryPlan!.gpuAllocationUpperBoundBytes);assert.equal(run.runtime.getStatus().loadedModel,null);assert.equal(run.launches.filter(args=>args.includes('--model')).length,1);
  }
});

test('mapped profiles require exact native KV/flash evidence and completed tool continuation before readiness',async t=>{
  for(const env of [{FAKE_PROFILE_WRONG_KV:'1'},{FAKE_PROFILE_FLASH_DISABLED:'1'}]){
    const fixtureValue=await fixture(t,env,hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});
    await assert.rejects(fixtureValue.runtime.prepareModel('qwen3.8:27b'),{code:'MODEL_PROFILE_MISMATCH'});assert.equal(fixtureValue.runtime.getStatus().loadedModel,null);
  }
  const continuation=await fixture(t,{FAKE_CONTINUATION_FAIL:'1'},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'muse-glimmer:30b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});
  await assert.rejects(continuation.runtime.prepareModel('muse-glimmer:30b'),{code:'MODEL_CALIBRATION_FAILED'});assert.equal(continuation.runtime.getStatus().loadedModel,null);assert.equal(continuation.launches.filter(args=>args.includes('--model')).length,1);
});

test('mapped calibration fails closed with missing physical footprint or insufficient cold workspace headroom',async t=>{
  const missing=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>resource(GIB,9.5*GIB)}});
  await assert.rejects(missing.runtime.prepareModel('qwen3.8:27b'),{code:'RESOURCE_MONITOR_UNAVAILABLE'});assert.equal(missing.launches.filter(args=>args.includes('--model')).length,1);
  const insufficient=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample(5*GIB)}});
  await assert.rejects(insufficient.runtime.prepareModel('qwen3.8:27b'),{code:'INSUFFICIENT_MEMORY'});assert.equal(insufficient.launches.filter(args=>args.includes('--model')).length,0);
});

test('mapped identity is checked again after native loading before any tool or Chat probe',async t=>{
  let directory='',probed=false;const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
  const fixtureValue=await fixture(t,{},hardware,async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/props'))await writeFile(path.join(directory,'models',spec.filename),corrupt);if(String(input).endsWith('/v1/chat/completions'))probed=true;return response;},{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});directory=fixtureValue.directory;
  await assert.rejects(fixtureValue.runtime.prepareModel('qwen3.8:27b'),{code:'MODEL_CHANGED'});assert.equal(probed,false);assert.equal(fixtureValue.runtime.getStatus().loadedModel,null);assert.equal(fixtureValue.launches.filter(args=>args.includes('--model')).length,1);
});

test('a metadata planner failure cannot masquerade as a recoverable inference allocation failure',async t=>{
  let attempts=0;const fixtureValue=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:()=>{attempts++;throw new RuntimeError('MODEL_MEMORY_PLAN_FAILED','Native allocation planning failed.');},resourceProbe:async()=>nativeMemorySample()}});
  await assert.rejects(fixtureValue.runtime.prepareModel('qwen3.8:27b'),{code:'MODEL_MEMORY_PLAN_FAILED'});assert.equal(attempts,1);assert.equal(fixtureValue.launches.filter(args=>args.includes('--model')).length,0);
});

test('metadata sampler PID disappearance defers only to that planner own bounded terminal event',async()=>{
  const gone=new RuntimeError('ENGINE_PROBE_FAILED','Engine exited 77.');
  const fakeChild=()=>Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as NodeJS.Signals|null}) as unknown as ChildProcess;
  const exiting=fakeChild();setTimeout(()=>{Object.assign(exiting,{exitCode:0});exiting.emit('exit',0,null);setTimeout(()=>exiting.emit('close',0,null),5);},10);
  assert.equal(await plannerExitedAfterSamplerFailure(exiting,gone),true,'successful own planner exit must win a sampler/exit notification race');assert.equal(exiting.listenerCount('exit'),0);assert.equal(exiting.listenerCount('close'),0);
  const live=fakeChild();assert.equal(await plannerExitedAfterSamplerFailure(live,gone),false,'a still-live planner identity failure must not be ignored');assert.equal(live.listenerCount('exit'),0);assert.equal(live.listenerCount('close'),0);
  const alreadyExited=fakeChild();Object.assign(alreadyExited,{exitCode:0});assert.equal(await plannerExitedAfterSamplerFailure(alreadyExited,gone),true);
  assert.equal(await plannerExitedAfterSamplerFailure(alreadyExited,new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Malformed metrics.')),false,'unrelated telemetry failures do not receive an exit exception');
});

test('changing from mapped coding to a legacy experimental trial clears the native plan and its profile evidence',async t=>{
  const fixtureValue=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[spec,{...spec,id:'qwen3.8:27b'}],nativePlannerTestOutput:nativePlanRows,resourceProbe:async()=>nativeMemorySample()}});
  await fixtureValue.runtime.prepareModel('qwen3.8:27b');assert(fixtureValue.runtime.getStatus().nativeMemoryPlan);
  const legacy=await fixtureValue.runtime.startExperimentalTrial(spec.id);assert.equal(legacy.contextTokens,4096);assert.equal(legacy.nativeMemoryPlan,undefined);assert.equal(fixtureValue.runtime.getStatus().nativeMemoryPlan,undefined);assert.equal(JSON.parse(legacy.profileSignature!).cacheTypeK,undefined);
});

test('a changed native sampler artifact is rejected before engine discovery or inference',async t=>{
  const {directory}=await fixture(t);const resources=path.join(directory,'native-resources');await mkdir(path.join(resources,'metal'),{recursive:true});
  const files=[];for(const [name,data] of [['engine','fake-engine'],['metal/agent-memory-sample','audited-sampler']] as const){const payload=Buffer.from(data);await writeFile(path.join(resources,name),payload);files.push({path:name,size:payload.length,sha256:createHash('sha256').update(payload).digest('hex')});}
  await writeFile(path.join(resources,'manifest.json'),JSON.stringify({schemaVersion:1,engine:'llama.cpp',version:'0.6.0',commit:ENGINE_COMMIT,build:11429,target:`${process.platform}-${process.arch}`,backends:[{id:'cpu',executable:'engine'}],resourceProbe:{id:'native-resource',executable:'metal/agent-memory-sample',arguments:[],sourceSha256:'aa0d0e8417dcb97af0beea648f14ba7b344669ce7f9a364b56371144fdbd4775'},files}));
  await writeFile(path.join(resources,'metal/agent-memory-sample'),'tampered-prober');
  let launched=false;const runtime=new LocalInferenceRuntime({dataDirectory:directory,resourcesDirectory:resources,spawn:()=>{launched=true;throw new Error('must not launch');}});t.after(()=>runtime.stop());await assert.rejects(runtime.start(),{code:'ENGINE_DIGEST_MISMATCH'});assert.equal(launched,false);
});

test('private offline inference strips inherited secrets and reuses a verified installed model',async t=>{
  const {runtime,directory,launches}=await fixture(t);const status=await runtime.start();assert.equal(status.state,'ready');assert.equal(status.baseUrl,null);
  const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.toolCapable,true);assert.equal(prepared.model,'local-agent-fixture-4b');assert.match(prepared.apiKey,/^[a-f0-9]{64}$/);assert.equal(prepared.measuredTokensPerSecond,42);assert.equal(prepared.outputTokens,2048);assert.equal(runtime.getStatus().profile?.outputTokens,2048);
  const env=await runtime.requestJson<{secret?:string;tools?:string;rpc?:string;flags:string[];pid:number;calibrationThinking?:boolean;metalNoResidency?:string;metalKeepAlive?:string}>('/env');assert.equal(env.secret,undefined);assert.equal(env.tools,undefined);assert.equal(env.rpc,undefined);assert.equal(env.metalNoResidency,undefined);assert.equal(env.metalKeepAlive,undefined);
  for(const flag of ['--offline','--no-agent','--no-webui','--no-ui-mcp-proxy','--no-cache-prompt','--no-cache-idle-slots','--no-context-shift'])assert(env.flags.includes(flag));
  assert.equal(env.flags[env.flags.indexOf('--cache-ram')+1],'0');assert.equal(env.flags[env.flags.indexOf('--parallel')+1],'1');assert.equal(env.flags[env.flags.indexOf('--host')+1],'127.0.0.1');
  assert.equal(env.flags[env.flags.indexOf('--predict')+1],'2048');assert.equal(env.flags[env.flags.indexOf('--ctx-size')+1],'8192');
  assert.equal(env.flags[env.flags.indexOf('--reasoning')+1],'auto');assert.equal(env.flags[env.flags.indexOf('--reasoning-format')+1],'deepseek');
  assert.equal(env.flags[env.flags.indexOf('--reasoning-budget')+1],'1024');
  for(const flag of ['--no-repack','--threads','--threads-batch'])assert.equal(env.flags.includes(flag),false,'Normal engine kernel and thread defaults remain unchanged.');
  assert.equal(env.calibrationThinking,false,'The bounded tool calibration must continue to request thinking off explicitly.');
  assert.equal((await fetch(`${prepared.baseUrl}/props`)).status,401);assert.deepEqual((await readdir(directory)).filter(f=>f.startsWith('.inference-key-')),[]);
  const again=await runtime.prepareModel(spec.id);assert.equal(again.baseUrl,prepared.baseUrl);assert.equal((await runtime.requestJson<{pid:number}>('/env')).pid,env.pid);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
  await runtime.stop();assert.equal(runtime.getStatus().state,'stopped');await assert.rejects(fetch(`${prepared.baseUrl}/props`));
});

test('cancelling a runtime download leaves first-run onboarding ready and resumes the verified artifact without a restart',async t=>{
  let downloads=0,streamCancelled=false;
  const nativeFetch=fetch;
  const fetcher:typeof fetch=async (input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return nativeFetch(input,init);
    downloads++;
    if(downloads===1){assert.equal(new Headers(init?.headers).get('range'),null);return new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(bytes.subarray(0,41));},cancel(){streamCancelled=true;}}));}
    assert.equal(new Headers(init?.headers).get('range'),'bytes=41-');
    return new Response(bytes.subarray(41),{status:206,headers:{'Content-Range':`bytes 41-${bytes.length-1}/${bytes.length}`}});
  };
  const {runtime,directory,launches}=await fixture(t,{},hardware,fetcher,{installedModel:false});await runtime.start();
  await assert.rejects(runtime.pullModel(spec.id,{onProgress(event){assert.equal(runtime.getStatus().downloadingModel,spec.id);if(event.status==='downloading'&&(event.completed??0)>0)runtime.cancelPull();}}),{name:'AbortError'});
  assert(streamCancelled);assert.equal(runtime.getStatus().downloadingModel,null);assert.equal(runtime.getStatus().state,'ready');assert.equal(runtime.getStatus().error,null);
  assert.deepEqual(await readFile(path.join(directory,'models',`${spec.filename}.part`)),bytes.subarray(0,41));assert.equal((await runtime.listModels())[0].installed,false);
  const verified=await runtime.pullModel(spec.id);assert.equal(verified.digest,spec.sha256);assert.equal(downloads,2);assert.equal(runtime.getStatus().downloadingModel,null);
  assert.deepEqual(await readdir(path.join(directory,'models')),[spec.filename]);assert.equal((await runtime.listModels())[0].installed,true);
  await runtime.prepareModel(spec.id);assert.equal(runtime.getStatus().loadedModel,spec.id);assert.equal(launches.filter(args=>args.includes('--version')).length,1);
});

test('an active download does not block the already usable different model or replay its load',async t=>{
  const other={...spec,id:'fixture:other',filename:'fixture-other.gguf'};let startedResolve:()=>void=()=>{},cancelled=false;const started=new Promise<void>(r=>startedResolve=r),nativeFetch=fetch;
  const fetcher:typeof fetch=async(input,init)=>String(input).startsWith('http://127.0.0.1:')?nativeFetch(input,init):new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(bytes.subarray(0,41));},cancel(){cancelled=true;}}));
  const {runtime,directory,launches}=await fixture(t,{},hardware,fetcher,{runtimeSettings:{catalog:[spec,other]}});await runtime.start();const initial=await runtime.prepareModel(spec.id),pid=(await runtime.requestJson<{pid:number}>('/env')).pid;
  const pulling=runtime.pullModel(other.id,{onProgress:p=>{if((p.completed??0)>0)startedResolve();}}),rejected=assert.rejects(pulling,{name:'AbortError'});await started;
  assert.equal(runtime.getStatus().downloadingModel,other.id);await assert.rejects(runtime.prepareModel(other.id),{code:'DOWNLOAD_BUSY'});assert.equal((await runtime.prepareModel(spec.id)).baseUrl,initial.baseUrl);
  assert.equal((await runtime.requestJson<{choices:{message:{content:string}}[]}>('/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}]})).choices[0].message.content,'OK');assert.equal((await runtime.requestJson<{pid:number}>('/env')).pid,pid);
  runtime.cancelPull();await rejected;assert(cancelled);assert.deepEqual(await readFile(path.join(directory,'models',other.filename+'.part')),bytes.subarray(0,41));assert.equal(runtime.getStatus().loadedModel,spec.id);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
});

test('an interrupted runtime download stays unavailable and retry reuses its partial instead of discarding other cached files',async t=>{
  let downloads=0;
  const fetcher:typeof fetch=async (_input,init)=>{
    downloads++;
    if(downloads===1)return new Response(bytes.subarray(0,97));
    assert.equal(new Headers(init?.headers).get('range'),'bytes=97-');
    return new Response(bytes.subarray(97),{status:206,headers:{'Content-Range':`bytes 97-${bytes.length-1}/${bytes.length}`}});
  };
  const {runtime,directory,launches}=await fixture(t,{},hardware,fetcher,{installedModel:false});await runtime.start();
  const retained=path.join(directory,'models','retained-cache.gguf');await writeFile(retained,'existing independent model cache');
  await assert.rejects(runtime.pullModel(spec.id),{code:'DOWNLOAD_INTERRUPTED'});
  assert.equal(runtime.getStatus().state,'ready');assert.equal(runtime.getStatus().error,null);assert.equal(runtime.getStatus().downloadingModel,null);
  assert.equal((await runtime.listModels())[0].installed,false);assert.deepEqual(await readFile(path.join(directory,'models',`${spec.filename}.part`)),bytes.subarray(0,97));
  await runtime.pullModel(spec.id);assert.equal(downloads,2);assert.equal((await runtime.listModels())[0].installed,true);
  assert.equal(await readFile(retained,'utf8'),'existing independent model cache');assert.deepEqual(launches,[['--version']]);
});

test('a removed previously verified selection requests model setup before inference and preserves the rest of the cache',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();await runtime.inspectModel(spec.id);
  const retained=path.join(directory,'models','retained-cache.gguf');await writeFile(retained,'existing independent model cache');await rm(path.join(directory,'models',spec.filename));
  assert.equal((await runtime.listModels())[0].installed,false);
  await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_NOT_FOUND'});
  const status=runtime.getStatus();assert.equal(status.state,'ready');assert.equal(status.error?.code,'MODEL_NOT_FOUND');assert.equal(status.loadedModel,null);assert.equal(status.baseUrl,null);
  assert.deepEqual(launches,[['--version']]);assert.equal(await readFile(retained,'utf8'),'existing independent model cache');
});

test('same-size corrupt weights remain an actionable integrity failure without launching inference or deleting cached artifacts',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();
  const target=path.join(directory,'models',spec.filename),corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;await writeFile(target,corrupt);
  const retained=path.join(directory,'models','retained-cache.gguf');await writeFile(retained,'existing independent model cache');
  await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});
  assert.equal(runtime.getStatus().state,'ready');assert.equal(runtime.getStatus().error?.code,'MODEL_DIGEST_MISMATCH');assert.equal(runtime.getStatus().baseUrl,null);
  assert.deepEqual(launches,[['--version']]);assert.deepEqual(await readFile(target),corrupt);assert.equal(await readFile(retained,'utf8'),'existing independent model cache');
});

test('a failed preflight inspection blocks corrupt same-size weights until the artifact passes verification again',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();await runtime.inspectModel(spec.id);
  const target=path.join(directory,'models',spec.filename),corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;await writeFile(target,corrupt);
  await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});
  const blocked=(await runtime.listModels())[0];assert.equal(blocked.installed,true);assert.match(blocked.blockedReason!,/SHA-256/);assert.equal(blocked.verificationError,blocked.blockedReason);assert.equal(blocked.digest,null);
  assert.equal(runtime.getStatus().error,null);assert.equal(runtime.getStatus().state,'ready');assert.deepEqual(launches,[['--version']]);
  await writeFile(target,bytes);await runtime.inspectModel(spec.id);
  const restored=(await runtime.listModels())[0];assert.equal(restored.installed,true);assert.equal(restored.verificationError,undefined);assert.equal(restored.blockedReason,null);assert.equal(restored.digest,spec.sha256);
});

test('importing a verified replacement clears stale model integrity errors without restarting the ready engine',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();
  const target=path.join(directory,'models',spec.filename),corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;await writeFile(target,corrupt);
  await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});assert.equal(runtime.getStatus().error?.code,'MODEL_DIGEST_MISMATCH');
  const source=path.join(directory,'valid-replacement.gguf');await writeFile(source,bytes);const replacement=await runtime.importModel(source);
  assert.equal(replacement.model,spec.id);assert.equal(runtime.getStatus().error,null);assert.equal(runtime.getStatus().state,'ready');assert.equal((await runtime.listModels())[0].verificationError,undefined);
  assert.deepEqual(launches,[['--version']]);await runtime.prepareModel(spec.id);assert.equal(runtime.getStatus().loadedModel,spec.id);assert.equal(launches.filter(args=>args.includes('--version')).length,1);
});

test('valid model selection clears a previous model-load failure while retaining the initialized engine',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_BAD_MODEL:'1'});await runtime.start();
  await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_LOAD_FAILED'});assert.equal(runtime.getStatus().error?.code,'MODEL_LOAD_FAILED');assert.equal(runtime.getStatus().state,'ready');
  await runtime.inspectModel(spec.id);assert.equal(runtime.getStatus().error,null);assert.equal(runtime.getStatus().loadedModel,null);
  assert.equal(launches.filter(args=>args.includes('--version')).length,1);
});

test('verified model inspection never clears a genuine engine startup error',async t=>{
  const {directory}=await fixture(t);const unavailable=new LocalInferenceRuntime({dataDirectory:directory,resourcesDirectory:path.join(directory,'absent-resources'),catalog:[spec],hardware});t.after(()=>unavailable.stop());
  await assert.rejects(unavailable.start(),{code:'ENGINE_NOT_AVAILABLE'});const before=unavailable.getStatus();
  await unavailable.inspectModel(spec.id);assert.equal(unavailable.getStatus().state,'error');assert.deepEqual(unavailable.getStatus().error,before.error);
});

test('a removed imported artifact retains its catalog identity but cannot load using a stale verification record',async t=>{
  const {runtime,directory,launches}=await fixture(t);const source=path.join(directory,'custom.gguf');await writeFile(source,ggufFixture('llama','User import'));
  const imported=await runtime.importModel(source);await runtime.start();
  const catalog=(await runtime.listModels()).find(model=>model.id===imported.model);assert(catalog);assert.equal(catalog.installed,true);await rm(path.join(directory,'models',catalog.filename));
  const missing=(await runtime.listModels()).find(model=>model.id===imported.model);assert(missing);assert.equal(missing.installed,false);assert.equal(missing.digest,null);
  await assert.rejects(runtime.prepareModel(imported.model),{code:'MODEL_NOT_FOUND'});assert.deepEqual(launches,[['--version']]);
  assert.deepEqual(await readFile(path.join(directory,'models',spec.filename)),bytes);assert((await readFile(path.join(directory,'imports.json'),'utf8')).includes(imported.model));
});

test('an unreadable model cache is a discovery failure rather than an empty first-run catalog',async t=>{
  const {runtime,directory}=await fixture(t,{},hardware,undefined,{installedModel:false});await runtime.start();
  const cache=path.join(directory,'models');await rm(cache,{recursive:true});await writeFile(cache,'unexpected cache entry');
  await assert.rejects(runtime.listModels(),{code:'MODEL_DISCOVERY_FAILED'});
  assert.equal(await readFile(cache,'utf8'),'unexpected cache entry');assert.equal(runtime.getStatus().state,'ready');assert.equal(runtime.getStatus().error,null);
});

test('a corrupt local import reports invalid GGUF and leaves existing verified models and source files intact',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();const source=path.join(directory,'invalid-import.gguf'),invalid=Buffer.alloc(64,0x61);await writeFile(source,invalid);
  await assert.rejects(runtime.importModel(source),{code:'INVALID_GGUF'});
  assert.deepEqual(await readFile(source),invalid);assert.deepEqual(await readFile(path.join(directory,'models',spec.filename)),bytes);
  assert.deepEqual(await readdir(path.join(directory,'models')),[spec.filename]);assert.equal((await runtime.listModels())[0].installed,true);assert.equal(runtime.getStatus().error,null);
  await assert.rejects(readFile(path.join(directory,'imports.json')),{code:'ENOENT'});assert.deepEqual(launches,[['--version']]);
});

test('allocation failures reduce batches before the bounded 4K CPU profile, with finite exhaustion',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_ALLOCATE:'large'});await runtime.start();const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.contextTokens,8192);assert.equal(prepared.outputTokens,2048);assert.equal(runtime.getStatus().profile?.index,1);
  const lower=await runtime.restartLowerProfile();assert.equal(lower.contextTokens,4096);assert.equal(runtime.getStatus().profile?.backend,'cpu');assert.equal(lower.outputTokens,1024);assert.equal(runtime.getStatus().profile?.outputTokens,1024);await assert.rejects(runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});
  assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--batch-size')+1]),['512','256','128']);
  assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--predict')+1]),['2048','2048','1024']);
  assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--reasoning-budget')+1]),['1024','1024','512']);
});

test('a native context cap reduces the generation allowance to one quarter of the confirmed context',async t=>{
  const nativeFetch=fetch;
  // The real loader can cap a tiny model below the requested 8K context.
  const fetchImplementation:typeof fetch=async (...args)=>{
    const response=await nativeFetch(...args);
    if(String(args[0]).endsWith('/props')&&response.ok){const properties=await response.json();properties.default_generation_settings.n_ctx=2048;return Response.json(properties);}
    return response;
  };
  const {runtime,launches}=await fixture(t,{},hardware,fetchImplementation);
  await runtime.start();const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.contextTokens,2048);assert.equal(prepared.outputTokens,512);assert.equal(runtime.getStatus().profile?.outputTokens,512);
  const load=launches.find(args=>args.includes('--model'))!;assert.equal(load[load.indexOf('--ctx-size')+1],'8192');assert.equal(load[load.indexOf('--predict')+1],'2048');
});

test('model format errors never trigger allocation fallback',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_BAD_MODEL:'1'});await runtime.start();await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_LOAD_FAILED'});assert.equal(launches.filter(a=>a.includes('--model')).length,1);
  assert.equal(isAllocationFailure('unsupported model architecture'),false);
});

test('discrete VRAM cannot justify a CPU fallback whose system RAM cannot fit the model',async t=>{
  const gpuAssisted={...hardware,totalMemoryBytes:6*GIB,availableMemoryBytes:2.5*GIB,gpus:[{...hardware.gpus[0],unifiedMemory:false,totalMemoryBytes:12*GIB,freeMemoryBytes:12*GIB}]};
  const {runtime,launches}=await fixture(t,{FAKE_ALLOCATE:'all'},gpuAssisted);await runtime.start();assert.equal(classifyModel(spec,gpuAssisted).fit,'recommended');await assert.rejects(runtime.prepareModel(spec.id),{code:'INSUFFICIENT_MEMORY'});const loads=launches.filter(a=>a.includes('--model'));assert.equal(loads.length,2);assert(loads.every(a=>!a.includes('--device')));assert.equal(runtime.getStatus().baseUrl,null);
});

test('calibration failure keeps chat available while disabling tools',async t=>{
  const {runtime}=await fixture(t,{FAKE_CALIBRATE_FAIL:'1'});await runtime.start();const model=await runtime.prepareModel(spec.id);assert.equal(model.toolCapable,false);assert.equal(runtime.getStatus().state,'ready');assert.equal((await runtime.listModels())[0].toolCapable,false);await assert.rejects(runtime.calibrateModel(spec.id),{code:'MODEL_CALIBRATION_FAILED'});
});

test('cancelling loading stops only the owned child, cleans its auth file, and allows a later start',async t=>{
  const {runtime,directory}=await fixture(t,{FAKE_HEALTH_DELAY:'1'});await runtime.start();const controller=new AbortController();const loading=runtime.prepareModel(spec.id,{signal:controller.signal});const error=assert.rejects(loading,{name:'AbortError'});
  while(!runtime.getStatus().baseUrl)await new Promise(r=>setTimeout(r,5));controller.abort();await error;assert.equal(runtime.getStatus().baseUrl,null);assert.deepEqual((await readdir(directory)).filter(f=>f.startsWith('.inference-key-')),[]);await runtime.stop();assert.equal((await runtime.start()).state,'ready');
});

test('occupied port is rejected without contacting or stopping the existing service',async t=>{
  const {runtime,directory}=await fixture(t);const server=createServer((_req,res)=>res.end('unrelated'));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert(address&&typeof address!=='string');
  const other=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware,port:address.port,spawn:(command,args,options)=>spawn(process.execPath,[fake,...args],options)});t.after(()=>other.stop());await other.start();await assert.rejects(other.prepareModel(spec.id),{code:'PORT_IN_USE'});assert.equal(await(await fetch(`http://127.0.0.1:${address.port}`)).text(),'unrelated');await runtime.stop();
});

test('changed weights are rejected before starting a process; symlink cache files are rejected',async t=>{
  const {runtime,directory,launches}=await fixture(t);await runtime.start();await runtime.inspectModel(spec.id);const changed=Buffer.from(bytes);changed[changed.length-1]=1;const target=path.join(directory,'models',spec.filename);await writeFile(target,changed);await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});assert.equal(launches.filter(a=>a.includes('--model')).length,0);
  const outside=path.join(directory,'outside.gguf');await writeFile(outside,bytes);await rm(target);await symlink(outside,target);await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_SIZE_MISMATCH'});
});

test('generic imports are checksummed, persisted and cannot gain tools for unvalidated architectures',async t=>{
  const {runtime,directory}=await fixture(t);const custom=Buffer.concat([bytes,Buffer.from('different')]);const source=path.join(directory,'custom.gguf');await writeFile(source,custom);const model=await runtime.importModel(source);assert.match(model.model,/^import:[a-f0-9]{64}$/);assert.equal(model.toolCapable,false);await runtime.start();const prepared=await runtime.prepareModel(model.model);assert.equal(prepared.toolCapable,false);const measured=await runtime.calibrateModel(model.model);assert.equal(measured.toolCapable,false);assert.equal(measured.measuredTokensPerSecond,42);assert.equal(runtime.getStatus().state,'ready');
  const reloaded=new LocalInferenceRuntime({dataDirectory:directory,catalog:[spec],hardware});assert((await reloaded.listModels()).some(m=>m.id===model.model&&m.toolCapable===false));assert.equal((await readFile(path.join(directory,'imports.json'),'utf8')).includes(source),false);
});

test('an imported validated architecture can enable tools only after native template confirmation and explicit calibration',async t=>{
  const {runtime,directory}=await fixture(t);const custom=ggufFixture('qwen35','Custom Qwen');const source=path.join(directory,'custom-qwen.gguf');await writeFile(source,custom);const imported=await runtime.importModel(source);assert.equal(imported.toolCapable,false);await runtime.start();assert.equal((await runtime.listModels()).find(m=>m.id===imported.model)?.toolValidationEligible,true);const prepared=await runtime.prepareModel(imported.model);assert.equal(prepared.toolCapable,true);assert.equal(prepared.measuredTokensPerSecond,42);const passed=await runtime.calibrateModel(imported.model);assert.equal(passed.toolCapable,true);assert.equal(passed.measuredTokensPerSecond,42);
});

test('supported generic imports remain chat-only when actual tool calibration fails or the trusted fixture skips it',async t=>{
  for(const skip of [false,true]){const {runtime,directory}=await fixture(t,skip?{}:{FAKE_CALIBRATE_FAIL:'1'},hardware,undefined,{runtimeSettings:{skipCalibration:skip}});const source=path.join(directory,'supported-import.gguf');await writeFile(source,ggufFixture('qwen35','Supported import fixture'));const imported=await runtime.importModel(source);assert.equal(imported.toolCapable,false);const prepared=await runtime.prepareModel(imported.model);assert.equal(prepared.toolCapable,false);const row=(await runtime.listModels()).find(model=>model.id===imported.model)!;assert.equal(row.toolCapable,false);assert.notEqual(row.toolProbe?.status,'passed');if(skip)assert.equal(row.toolProbe?.diagnostic,undefined);else assert.equal(row.toolProbe?.status,'failed');}
});

test('Slow mode can unload an idle model and chooses a smaller batch on the next load',async t=>{
  const {runtime}=await fixture(t);await runtime.start();await runtime.prepareModel(spec.id);await runtime.setSlowMode(true);assert.equal(runtime.getStatus().loadedModel,null);const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.contextTokens,8192);assert.equal(runtime.getStatus().profile?.batchTokens,256);
});

test('stop blocks new loads and aborts manual calibration without restoring stale prepared credentials',async t=>{
  const {runtime,directory}=await fixture(t,{FAKE_CALIBRATION_DELAY:'1'});await runtime.start();await runtime.prepareModel(spec.id);
  const started=new Promise<void>(resolve=>{const listen=(message:string)=>{if(message.includes('CALIBRATION_STARTED')){runtime.removeListener('log',listen);resolve();}};runtime.on('log',listen);});
  const calibration=runtime.calibrateModel(spec.id);const failed=assert.rejects(calibration);await started;await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_BUSY'});
  const stopping=runtime.stop();await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_BUSY'});await failed;await stopping;
  assert.equal(runtime.getStatus().state,'stopped');assert.equal(runtime.getStatus().loadedModel,null);assert.equal(runtime.getStatus().baseUrl,null);await assert.rejects(runtime.requestJson('/props'),{code:'RUNTIME_NOT_READY'});assert.deepEqual((await readdir(directory)).filter(f=>f.startsWith('.inference-key-')),[]);
});

test('startup removes only stale app-created regular auth files after a crash',async t=>{
  const {runtime,directory}=await fixture(t);const name='.inference-key-12345678-1234-1234-1234-123456789abc';await writeFile(path.join(directory,name),'old-secret');await writeFile(path.join(directory,'.inference-key-user-notes'),'keep');await runtime.start();assert.equal((await readdir(directory)).includes(name),false);assert.equal(await readFile(path.join(directory,'.inference-key-user-notes'),'utf8'),'keep');
});

test('an accelerated loader failure falls back to the independently pinned CPU executable',async t=>{
  const {directory}=await fixture(t);const resources=path.join(directory,'resources');await mkdir(resources);const gpu=Buffer.from('gpu executable'),cpu=Buffer.from('cpu executable');await writeFile(path.join(resources,'gpu'),gpu);await writeFile(path.join(resources,'cpu'),cpu);
  const files=[['gpu',gpu],['cpu',cpu]].map(([name,data])=>({path:String(name),size:(data as Buffer).length,sha256:createHash('sha256').update(data as Buffer).digest('hex')}));
  await writeFile(path.join(resources,'manifest.json'),JSON.stringify({schemaVersion:1,engine:'llama.cpp',version:'0.6.0',commit:'d81235049384534c167caea52b85a694f6103d14',build:11429,target:`${process.platform}-${process.arch}`,backends:[{id:'metal',executable:'gpu',arguments:[]},{id:'cpu',executable:'cpu',arguments:['--device','none','--n-gpu-layers','0','--no-op-offload']}],files}));
  const runtime=new LocalInferenceRuntime({dataDirectory:directory,resourcesDirectory:resources,catalog:[spec],totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,spawn:(command,args,options)=>command.endsWith('/gpu')?spawn(process.execPath,['-e','console.error("missing Vulkan loader");process.exit(1)'],options):spawn(process.execPath,[fake,...args],options)});t.after(()=>runtime.stop());const status=await runtime.start();assert.equal(status.state,'ready');assert.equal(status.executablePath,path.join(resources,'cpu'));assert.deepEqual(status.hardware?.gpus,[]);await runtime.setSlowMode(true);await runtime.prepareModel(spec.id);assert.equal(runtime.getStatus().profile?.backend,'cpu');
});

test('memory fit respects unified Metal budget, active application pressure, OS reserve and all MoE weights',()=>{
  const lowGPU={...hardware,gpus:[{...hardware.gpus[0],freeMemoryBytes:3*GIB}]};assert.equal(classifyModel(spec,lowGPU).fit,'slow');assert.equal(classifyModel(spec,{...hardware,availableMemoryBytes:128*1024**2}).fit,'insufficient');assert.equal(classifyModel(MODEL_CATALOG.find(m=>m.id==='gemma4:31b')!,hardware).fit,'insufficient');
  const larger={...hardware,availableMemoryBytes:20*GIB,gpus:[{...hardware.gpus[0],freeMemoryBytes:17.7*GIB}]};assert.equal(classifyModel(MODEL_CATALOG.find(m=>m.id==='gemma4:26b')!,larger).fit,'slow');
  assert.equal(parseDevices('BLAS: Accelerate (24000 MiB, 24000 MiB free)\nMetal0: Apple M5 (18186 MiB, 18186 MiB free)','metal','darwin').length,1);
  assert.equal(parseMacAvailableMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2.\nPages inactive: 3.\nPages speculative: 4.\nPages purgeable: 1.'),7*16384);
});

test('malformed GGUF array bounds fail before allocating attacker-chosen sizes',async t=>{
  const {directory}=await fixture(t);const file=path.join(directory,'invalid.gguf');await writeFile(file,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(1),str('bad'),u32(9),u32(8),u64(100_000_000)]));await assert.rejects(readGGUFMetadata(file),{code:'INVALID_GGUF'});
});

const resource=(residentBytes=64*1024**2,availableMemoryBytes=20*GIB,pressure:ResourceMeasurements['pressure']='normal'):ResourceMeasurements=>({sampledAt:new Date().toISOString(),residentBytes,availableMemoryBytes,pressure});
async function waitFor(predicate:()=>boolean,timeoutMs=2500):Promise<void>{const deadline=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for runtime state.');await new Promise(resolve=>setTimeout(resolve,10));}}

test('Low memory starts with bounded 4K batches while retaining ordinary fit classification',async t=>{
  const {runtime}=await fixture(t);await runtime.start();const before=(await runtime.listModels())[0].fit;
  await runtime.setMemoryMode('low-memory');const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.memoryMode,'low-memory');
  assert.equal(prepared.contextTokens,4096);assert.equal(runtime.getStatus().profile?.batchTokens,128);assert.equal(runtime.getStatus().profile?.microBatchTokens,32);
  assert.equal((await runtime.listModels())[0].fit,before);const flags=(await runtime.requestJson<{flags:string[]}>('/env')).flags;
  assert.equal(flags[flags.indexOf('--fit')+1],'on');assert(!flags.includes('--lazy-mode'));
});

test('Experimental disk requires an explicit successful digest/profile probe and never changes normal fit labels',async t=>{
  const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  const fit=(await runtime.listModels())[0].fit;await runtime.setMemoryMode('experimental-disk');
  await assert.rejects(runtime.prepareModel(spec.id),{code:'EXPERIMENTAL_TRIAL_REQUIRED'});assert.equal(launches.filter(args=>args.includes('--model')).length,0);
  const prepared=await runtime.startExperimentalTrial(spec.id);assert.equal(prepared.probePassed,true);assert.equal(prepared.toolCapable,true);assert.equal(prepared.profileSignature,EXPERIMENTAL_PROFILE_SIGNATURE);
  assert.equal(runtime.getStatus().experimentalTrial?.digest,spec.sha256);assert.equal(runtime.getStatus().experimentalTrial?.state,'passed');assert.equal((await runtime.listModels())[0].fit,fit);
  const flags=(await runtime.requestJson<{flags:string[]}>('/env')).flags;
  for(const [flag,value] of [['--fit','off'],['--load-mode','mmap'],['--lazy-mode','on'],['--device','none'],['--n-gpu-layers','0'],['--cache-type-k','f16'],['--cache-type-v','f16'],['--ctx-size','4096'],['--batch-size','128'],['--ubatch-size','32'],['--parallel','1']])assert.equal(flags[flags.indexOf(flag)+1],value);
  assert(flags.includes('--no-op-offload'));assert.equal(runtime.getStatus().experimentalTrial?.mappedBytes,128*1024**2);assert.equal(runtime.getStatus().experimentalTrial?.lazyEligibleBytes,16*1024**2);
  assert.equal((await runtime.prepareModel(spec.id)).baseUrl,prepared.baseUrl);assert.equal(launches.filter(args=>args.includes('--model')).length,1);
  await assert.rejects(runtime.restartLowerProfile(),{code:'EXPERIMENTAL_RECOVERY_DISABLED'});
});

test('a prior app-owned model is unloaded before the experimental budget is measured',async t=>{
  let active=0,measured=false;const {runtime}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async pid=>{if(pid===null){assert.equal(active,0);measured=true;}return resource();}}});
  runtime.on('status',status=>{active=status.baseUrl?1:0;});await runtime.start();await runtime.prepareModel(spec.id);assert.equal(active,1);
  await runtime.startExperimentalTrial(spec.id);assert(measured);assert.equal(runtime.getStatus().experimentalTrial?.resourceBudgetBytes,19*GIB);
});

test('experimental tool-format failure retains a successfully probed Chat-only model',async t=>{
  const {runtime}=await fixture(t,{FAKE_CALIBRATE_FAIL:'1'},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});
  await runtime.start();const prepared=await runtime.startExperimentalTrial(spec.id);assert.equal(prepared.probePassed,true);assert.equal(prepared.toolCapable,false);assert.deepEqual(prepared.capabilities,['completion']);
  assert.equal(runtime.getStatus().experimentalTrial?.toolProbePassed,false);assert.equal(runtime.getStatus().experimentalTrial?.state,'passed');
});

test('failed experimental Chat probe does not allow subsequent model or Agent preparation',async t=>{
  const {runtime}=await fixture(t,{FAKE_CHAT_PROBE_FAIL:'1'},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  await assert.rejects(runtime.startExperimentalTrial(spec.id),{code:'EXPERIMENTAL_CHAT_PROBE_FAILED'});assert.equal(runtime.getStatus().baseUrl,null);assert.equal(runtime.getStatus().experimentalTrial?.probePassed,false);
  await assert.rejects(runtime.prepareModel(spec.id),{code:'EXPERIMENTAL_TRIAL_REQUIRED'});
});

test('experimental platform, headroom, and initial monitoring failures stop before launching weights',async t=>{
  const cases=[
    {hardware:{...hardware,platform:'linux' as const},probe:async()=>resource(),code:'EXPERIMENTAL_PLATFORM_UNSUPPORTED'},
    {hardware,probe:async()=>resource(0,2*GIB),code:'EXPERIMENTAL_WORKSPACE_INSUFFICIENT'},
    {hardware,probe:async()=>{throw new Error('missing measurements');},code:'EXPERIMENTAL_TRIAL_FAILED'},
    {hardware,probe:async()=>resource(0,20*GIB,'critical'),code:'EXPERIMENTAL_WORKSPACE_INSUFFICIENT'},
  ];
  for(const entry of cases){const {runtime,launches}=await fixture(t,{},entry.hardware,undefined,{runtimeSettings:{resourceProbe:entry.probe}});await runtime.start();await assert.rejects(runtime.startExperimentalTrial(spec.id),{code:entry.code});assert.equal(launches.filter(args=>args.includes('--model')).length,0);assert.equal(runtime.getStatus().baseUrl,null);}
});

test('experimental watchdog stops on resident limit, pressure, sustained low availability, or unavailable measurements without restarting',async t=>{
  for(const failure of ['resident','pressure','available','missing'] as const){let unsafe=false;const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceIntervalMs:20,resourceProbe:async()=>{if(!unsafe)return resource();if(failure==='missing')throw new Error('probe failed');return failure==='resident'?resource(20*GIB):failure==='pressure'?resource(0,20*GIB,'critical'):resource(0,128*1024**2);}}});
    await runtime.start();await runtime.startExperimentalTrial(spec.id);unsafe=true;await waitFor(()=>runtime.getStatus().experimentalTrial?.state==='failed'&&runtime.getStatus().baseUrl===null);
    assert.equal(runtime.getStatus().experimentalTrial?.probePassed,false);assert.equal(runtime.getStatus().loadedModel,null);assert.equal(launches.filter(args=>args.includes('--model')).length,1);
    assert.equal(runtime.getStatus().error?.code,{resident:'EXPERIMENTAL_RESIDENT_LIMIT',pressure:'EXPERIMENTAL_MEMORY_PRESSURE',available:'EXPERIMENTAL_AVAILABLE_MEMORY',missing:'RESOURCE_MONITOR_UNAVAILABLE'}[failure]);
  }
});

test('experimental loading and shared probe deadlines are bounded without allocation retries',async t=>{
  const loading=await fixture(t,{FAKE_HEALTH_DELAY:'1'},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource(),experimentalLoadTimeoutMs:80}});await loading.runtime.start();
  await assert.rejects(loading.runtime.startExperimentalTrial(spec.id),{code:'EXPERIMENTAL_LOAD_TIMEOUT'});assert.equal(loading.launches.filter(args=>args.includes('--model')).length,1);
  const probe=await fixture(t,{FAKE_CALIBRATION_DELAY:'1'},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource(),experimentalCalibrationTimeoutMs:80}});await probe.runtime.start();
  await assert.rejects(probe.runtime.startExperimentalTrial(spec.id),{code:'EXPERIMENTAL_CALIBRATION_TIMEOUT'});assert.equal(probe.runtime.getStatus().baseUrl,null);assert.equal(probe.launches.filter(args=>args.includes('--model')).length,1);
});

test('explicit experimental cancellation invalidates its probe and permits returning to the retained normal model',async t=>{
  const {runtime,directory}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();await runtime.startExperimentalTrial(spec.id);
  await runtime.cancelExperimentalTrial();assert.equal(runtime.getStatus().experimentalTrial?.state,'cancelled');assert.equal(runtime.getStatus().baseUrl,null);
  await assert.rejects(runtime.prepareModel(spec.id),{code:'EXPERIMENTAL_TRIAL_REQUIRED'});assert.deepEqual(await readFile(path.join(directory,'models',spec.filename)),bytes);
  await runtime.setMemoryMode('automatic');await runtime.prepareModel(spec.id);assert.equal(runtime.getStatus().profile?.contextTokens,8192);
});

test('experimental cancellation during loading settles once and cleans the private key',async t=>{
  const {runtime,directory,launches}=await fixture(t,{FAKE_HEALTH_DELAY:'1'},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  const trial=runtime.startExperimentalTrial(spec.id),rejected=assert.rejects(trial,{name:'AbortError'});await waitFor(()=>Boolean(runtime.getStatus().baseUrl));
  await runtime.cancelExperimentalTrial();await rejected;assert.equal(runtime.getStatus().experimentalTrial?.state,'cancelled');assert.equal(launches.filter(args=>args.includes('--model')).length,1);
  assert.deepEqual((await readdir(directory)).filter(file=>file.startsWith('.inference-key-')),[]);
});

test('experimental cancellation is effective immediately before engine/model preparation',async t=>{
  const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  const trial=runtime.startExperimentalTrial(spec.id),rejected=assert.rejects(trial,{name:'AbortError'});await runtime.cancelExperimentalTrial();await rejected;
  assert.equal(runtime.getStatus().experimentalTrial?.state,'cancelled');assert.equal(launches.filter(args=>args.includes('--model')).length,0);assert.equal(runtime.getStatus().baseUrl,null);
});

test('a stalled resource monitor and stale or future samples fail closed before loading',async t=>{
  for(const probe of [async()=>new Promise<ResourceMeasurements>(()=>{}),async()=>({...resource(),sampledAt:new Date(Date.now()-30000).toISOString()}),async()=>({...resource(),sampledAt:new Date(Date.now()+30000).toISOString()})]){
    const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:probe}});await runtime.start();
    await assert.rejects(runtime.startExperimentalTrial(spec.id),{code:'RESOURCE_MONITOR_UNAVAILABLE'});assert.equal(launches.filter(args=>args.includes('--model')).length,0);
  }
});

test('initial experimental loading deadline also bounds a stalled properties request',async t=>{
  const nativeFetch=fetch;const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).endsWith('/props'))return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});
    return nativeFetch(input,init);
  };
  const {runtime,launches}=await fixture(t,{},hardware,fetcher,{runtimeSettings:{resourceProbe:async()=>resource(),experimentalLoadTimeoutMs:350}});await runtime.start();
  await assert.rejects(runtime.startExperimentalTrial(spec.id),{code:'EXPERIMENTAL_LOAD_TIMEOUT'});assert.equal(launches.filter(args=>args.includes('--model')).length,1);assert.equal(runtime.getStatus().baseUrl,null);
});

test('an experimental startup failure preserves a genuine missing-engine error state',async t=>{
  const {directory}=await fixture(t);const runtime=new LocalInferenceRuntime({dataDirectory:directory,resourcesDirectory:path.join(directory,'missing-runtime'),catalog:[spec],hardware,resourceProbe:async()=>resource()});t.after(()=>runtime.stop());
  await assert.rejects(runtime.startExperimentalTrial(spec.id),{code:'ENGINE_NOT_AVAILABLE'});assert.equal(runtime.getStatus().state,'error');assert.equal(runtime.getStatus().error?.code,'ENGINE_NOT_AVAILABLE');assert.equal(runtime.getStatus().experimentalTrial?.state,'failed');
});

test('experimental model selection keeps insufficient fit labels without treating estimates as hard integrity blocks',async t=>{
  const oversized={...spec,workingMemoryGB:40};const {runtime,directory,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{catalog:[oversized]}});await runtime.start();
  const automatic=(await runtime.listModels())[0];assert.equal(automatic.fit,'insufficient');assert.equal(automatic.blockedReason,automatic.fitReason);
  await runtime.setMemoryMode('experimental-disk');const experimental=(await runtime.listModels())[0];assert.equal(experimental.fit,'insufficient');assert.equal(experimental.fitReason,automatic.fitReason);assert.equal(experimental.blockedReason,null);
  assert.equal(experimental.digest,null,'Same-sized catalog files are unverified until actual hashing.');assert.equal(experimental.integrity,'unverified');await runtime.inspectModel(spec.id);assert.equal((await runtime.listModels())[0].digest,spec.sha256);assert.equal(experimental.installed,true);assert.deepEqual(launches,[['--version']],'Selection/listing must not launch an experimental trial.');
  const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;await writeFile(path.join(directory,'models',spec.filename),corrupt);await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});
  const blocked=(await runtime.listModels())[0];assert.equal(blocked.fit,'insufficient');assert.equal(blocked.blockedReason,blocked.verificationError);assert.match(blocked.blockedReason!,/SHA-256/);assert.equal(blocked.digest,null);
  await assert.rejects(runtime.prepareModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});assert.deepEqual(launches,[['--version']]);
});

test('experimental mode cannot grant tools to an unvalidated import or accept corrupt imported weights',async t=>{
  const {runtime,directory}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  const source=path.join(directory,'custom-model.gguf');await writeFile(source,ggufFixture('llama','Unvalidated architecture'));const imported=await runtime.importModel(source);
  const prepared=await runtime.startExperimentalTrial(imported.model);assert.equal(prepared.probePassed,true);assert.equal(prepared.toolCapable,false);assert.deepEqual(prepared.capabilities,['completion']);assert.equal(runtime.getStatus().experimentalTrial?.toolProbePassed,false);
  const invalid=path.join(directory,'corrupt-import.gguf');await writeFile(invalid,Buffer.alloc(64,0x61));await assert.rejects(runtime.importModel(invalid),{code:'INVALID_GGUF'});
  assert.equal((await runtime.listModels()).find(model=>model.id===imported.model)?.toolCapable,false);assert.equal(await readFile(invalid,'utf8'),'a'.repeat(64));
});

test('all memory modes expose the same stable effective profile identity in status, prepared model and successful trials',async t=>{
  const nativeFetch=fetch;const fetcher:typeof fetch=async(input,init)=>{const response=await nativeFetch(input,init);if(String(input).endsWith('/props')&&response.ok){const props=await response.json();props.default_generation_settings.n_ctx=2048;return Response.json(props);}return response;};
  const {runtime}=await fixture(t,{},hardware,fetcher,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();assert.equal(runtime.getStatus().profileSignature,null);
  const automatic=await runtime.prepareModel(spec.id);assert.equal(automatic.profileSignature,runtime.getStatus().profileSignature);
  const descriptor=JSON.parse(automatic.profileSignature!);assert.equal(descriptor.engineCommit,ENGINE_COMMIT);assert.equal(descriptor.memoryMode,'automatic');assert.equal(descriptor.contextTokens,2048);assert.equal(descriptor.outputTokens,512);assert.equal(descriptor.batchTokens,512);assert.equal(descriptor.microBatchTokens,128);
  assert.equal(automatic.profileSignature,inferenceProfileSignature(runtime.getStatus().profile!,'automatic'));assert.equal((await runtime.prepareModel(spec.id)).profileSignature,automatic.profileSignature);
  await runtime.setMemoryMode('low-memory');assert.equal(runtime.getStatus().profileSignature,null);const low=await runtime.prepareModel(spec.id);assert.equal(low.profileSignature,runtime.getStatus().profileSignature);assert.notEqual(low.profileSignature,automatic.profileSignature);assert.equal(JSON.parse(low.profileSignature!).batchTokens,128);
  const lower=await runtime.restartLowerProfile();assert.equal(lower.profileSignature,runtime.getStatus().profileSignature);assert.notEqual(lower.profileSignature,low.profileSignature);assert.equal(JSON.parse(lower.profileSignature!).batchTokens,64);
  const experimental=await runtime.startExperimentalTrial(spec.id);assert.equal(experimental.profileSignature,runtime.getStatus().profileSignature);assert.equal(runtime.getStatus().experimentalTrial?.profileSignature,experimental.profileSignature);assert.notEqual(experimental.profileSignature,EXPERIMENTAL_PROFILE_SIGNATURE,'A confirmed smaller native context must alter the requested experimental identity.');
  assert.equal(JSON.parse(experimental.profileSignature!).contextTokens,2048);assert.equal(JSON.parse(experimental.profileSignature!).backend,'cpu');assert.equal(JSON.parse(experimental.profileSignature!).memoryMode,'experimental-disk');assert.equal((await runtime.prepareModel(spec.id)).profileSignature,experimental.profileSignature);
  await runtime.stop();assert.equal(runtime.getStatus().profileSignature,null);
});

test('manual calibration synchronizes only the tool probe of the same successful experimental digest/profile',async t=>{
  let validToolFormat=false;const nativeFetch=fetch;
  const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).endsWith('/v1/chat/completions')&&JSON.parse(String(init?.body)).tools&&validToolFormat)return Response.json({choices:[{message:{tool_calls:[{function:{name:'local_probe',arguments:'{"word":"OK"}'}}]}}],timings:{predicted_per_second:42}});
    return nativeFetch(input,init);
  };
  const {runtime}=await fixture(t,{FAKE_CALIBRATE_FAIL:'1'},hardware,fetcher,{runtimeSettings:{resourceProbe:async()=>resource()}});await runtime.start();
  const chatOnly=await runtime.startExperimentalTrial(spec.id);assert.equal(chatOnly.toolCapable,false);const trial=runtime.getStatus().experimentalTrial!;assert.equal(trial.toolProbePassed,false);
  validToolFormat=true;const calibrated=await runtime.calibrateModel(spec.id);assert.equal(calibrated.toolCapable,true);assert.deepEqual(calibrated.capabilities,['completion','tools']);
  const promoted=runtime.getStatus().experimentalTrial!,passedProbe=promoted.probes!.tools!;assert.equal(passedProbe.passed,true);assert.equal(passedProbe.toolCallCount,1);assert.deepEqual(passedProbe.toolCalls,[{name:'local_probe',arguments:'{"word":"OK"}'}]);assert.equal(passedProbe.requestedOutputTokens,96);assert.equal(passedProbe.outputTokens,null,'Missing native token usage is not inferred from measured speed.');assert.deepEqual(passedProbe.binding,trial.probes!.tools!.binding);
  assert.deepEqual(promoted,{...trial,toolProbePassed:true,probes:{...trial.probes,tools:passedProbe}},'Only the actual tool-format diagnostic and tool status may change; Chat evidence, identity, state, timing, metrics and task validation remain unchanged.');
  validToolFormat=false;await assert.rejects(runtime.calibrateModel(spec.id),{code:'MODEL_CALIBRATION_FAILED'});const failed=await runtime.prepareModel(spec.id);assert.equal(failed.toolCapable,false);assert.deepEqual(failed.capabilities,['completion']);
  const failedTrial=runtime.getStatus().experimentalTrial!,failedProbe=failedTrial.probes!.tools!;assert.equal(failedProbe.passed,false);assert.equal(failedProbe.toolCallCount,0);assert.deepEqual(failedProbe.toolCalls,[]);assert.equal(failedProbe.content,'Hello');assert.equal(failedProbe.requestedOutputTokens,96);assert.deepEqual(failedProbe.binding,passedProbe.binding);
  assert.deepEqual(failedTrial,{...trial,probes:{...trial.probes,tools:failedProbe}},'A failed tool probe retains the successful Chat evidence and exact trial identity without promoting it.');
  await runtime.cancelExperimentalTrial();const cancelled=runtime.getStatus().experimentalTrial;
  validToolFormat=true;await assert.rejects(runtime.calibrateModel(spec.id),{code:'EXPERIMENTAL_TRIAL_REQUIRED'});assert.deepEqual(runtime.getStatus().experimentalTrial,cancelled,'Calibration cannot revive a cancelled trial.');
});

test('experimental RAM refresh preserves validated Metal devices for the return to Automatic inference',async t=>{
  const {runtime,launches}=await fixture(t,{},hardware,undefined,{runtimeSettings:{resourceProbe:async()=>resource(),refreshHardware:async()=>({...hardware,availableMemoryBytes:18*GIB,freeDiskBytes:90*GIB,gpus:[]})}});await runtime.start();
  const originalGPUs=runtime.getStatus().hardware!.gpus;const originalFit=(await runtime.listModels())[0].fit;
  await runtime.startExperimentalTrial(spec.id);assert.equal(runtime.getStatus().profile?.backend,'cpu');assert.deepEqual(runtime.getStatus().hardware?.gpus,originalGPUs);assert.equal(runtime.getStatus().hardware?.freeDiskBytes,90*GIB);assert.equal((await runtime.listModels())[0].fit,originalFit);
  const experimentalFlags=launches.filter(args=>args.includes('--model')).at(-1)!;assert.equal(experimentalFlags[experimentalFlags.indexOf('--n-gpu-layers')+1],'0');assert.equal(experimentalFlags[experimentalFlags.indexOf('--device')+1],'none');assert.equal(runtime.getStatus().experimentalTrial?.resourceBudgetBytes,19*GIB,'Preserved unified GPU descriptors cannot add another memory budget.');
  await runtime.setMemoryMode('automatic');const restored=await runtime.prepareModel(spec.id);assert.equal(runtime.getStatus().profile?.backend,'metal');assert.deepEqual(runtime.getStatus().hardware?.gpus,originalGPUs);assert.equal(JSON.parse(restored.profileSignature!).backend,'metal');
  const automaticFlags=launches.filter(args=>args.includes('--model')).at(-1)!;assert(!automaticFlags.includes('--device'));assert(!automaticFlags.includes('--n-gpu-layers'));assert.equal(automaticFlags[automaticFlags.indexOf('--fit')+1],'on');
});

test('execution request timeout is configurable to eight hours while control APIs retain short limits',async t=>{
  const nativeFetch=fetch;let captured:AbortSignal|undefined;
  const {runtime}=await fixture(t,{},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions')&&JSON.parse(String(init?.body)).messages?.[0]?.content==='deadline probe'){captured=init?.signal??undefined;return new Promise((_resolve,reject)=>{captured?.addEventListener('abort',()=>reject(captured?.reason),{once:true});});}return nativeFetch(input,init);});
  await runtime.start();await runtime.prepareModel(spec.id);runtime.setExecutionRequestTimeout(1000);
  await assert.rejects(runtime.requestStream('/v1/chat/completions',{messages:[{role:'user',content:'deadline probe'}]}),{name:'TimeoutError'});assert(captured?.aborted);
  runtime.setExecutionRequestTimeout(28800000);assert.throws(()=>runtime.setExecutionRequestTimeout(28800001),{code:'INVALID_REQUEST_DEADLINE'});assert.equal((await runtime.requestJson<{total_slots:number}>('/props')).total_slots,1);
});
