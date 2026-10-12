import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {LocalInferenceRuntime,MODEL_CATALOG,isAllocationFailure,EXPERIMENTAL_PROFILE_SIGNATURE,ENGINE_COMMIT,inferenceProfileSignature,type CuratedModel,type HardwareInfo,type RuntimeOptions,type ResourceMeasurements} from '../index.ts';
import {classifyModel,GIB,parseDevices,parseMacAvailableMemory} from '../hardware.ts';
import {readGGUFMetadata} from '../gguf.ts';

const u32=(v:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;};
const u64=(v:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
const str=(v:string)=>{const b=Buffer.from(v);return Buffer.concat([u64(b.length),b]);};
const entry=(k:string,v:string)=>Buffer.concat([str(k),u32(8),str(v)]);
function ggufFixture(architecture='llama',name='Local fixture'){
  const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(3),entry('general.architecture',architecture),entry('general.name',name),entry('tokenizer.chat_template','{{messages|tojson}}'),str('token_embd.weight'),u32(2),u64(8),u64(1),u32(0),u64(0)]);
  return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(8*4)]);
}
const bytes=ggufFixture();
const spec:CuratedModel={id:'fixture:4b',title:'Fixture',description:'Test model',estimatedDownloadBytes:bytes.length,minimumMemoryGB:8,workingMemoryGB:4,license:'Apache-2.0',sourceUrl:'https://huggingface.co/example/model',quantization:'Q4',repository:'example/model',revision:'a'.repeat(40),filename:'fixture.gguf',sha256:createHash('sha256').update(bytes).digest('hex'),architecture:'llama',toolCapable:true};
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'Fixture',cpuCores:8,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,freeDiskBytes:100*GIB,gpus:[{name:'Metal fixture',backend:'metal',totalMemoryBytes:20*GIB,freeMemoryBytes:20*GIB,unifiedMemory:true}]};
const fake=fileURLToPath(new URL('./fake-engine.cjs',import.meta.url));
async function fixture(t:TestContext,extraEnv:NodeJS.ProcessEnv={},detectedHardware:HardwareInfo=hardware,fetchImplementation?:typeof fetch,options:{installedModel?:boolean;runtimeSettings?:Partial<RuntimeOptions>}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'local-agent-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));if(options.installedModel!==false){await mkdir(path.join(directory,'models'));await writeFile(path.join(directory,'models',spec.filename),bytes);}
  const launches:string[][]=[];
  const runtime=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:detectedHardware,startupTimeoutMs:3000,stopTimeoutMs:500,fetch:fetchImplementation,
    env:{...process.env,OPENAI_API_KEY:'secret',LLAMA_ARG_TOOLS:'all',LLAMA_ARG_RPC:'remote:5000'},...options.runtimeSettings,
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

test('private offline inference strips inherited secrets and reuses a verified installed model',async t=>{
  const {runtime,directory,launches}=await fixture(t);const status=await runtime.start();assert.equal(status.state,'ready');assert.equal(status.baseUrl,null);
  const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.toolCapable,true);assert.equal(prepared.model,'local-agent-fixture-4b');assert.match(prepared.apiKey,/^[a-f0-9]{64}$/);assert.equal(prepared.measuredTokensPerSecond,42);assert.equal(prepared.outputTokens,2048);assert.equal(runtime.getStatus().profile?.outputTokens,2048);
  const env=await runtime.requestJson<{secret?:string;tools?:string;rpc?:string;flags:string[];pid:number;calibrationThinking?:boolean}>('/env');assert.equal(env.secret,undefined);assert.equal(env.tools,undefined);assert.equal(env.rpc,undefined);
  for(const flag of ['--offline','--no-agent','--no-webui','--no-ui-mcp-proxy','--no-cache-prompt','--no-cache-idle-slots','--no-context-shift'])assert(env.flags.includes(flag));
  assert.equal(env.flags[env.flags.indexOf('--cache-ram')+1],'0');assert.equal(env.flags[env.flags.indexOf('--parallel')+1],'1');assert.equal(env.flags[env.flags.indexOf('--host')+1],'127.0.0.1');
  assert.equal(env.flags[env.flags.indexOf('--predict')+1],'2048');assert.equal(env.flags[env.flags.indexOf('--ctx-size')+1],'8192');
  assert.equal(env.flags[env.flags.indexOf('--reasoning')+1],'auto');assert.equal(env.flags[env.flags.indexOf('--reasoning-format')+1],'deepseek');
  assert.equal(env.flags[env.flags.indexOf('--reasoning-budget')+1],'1024');
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
  const {runtime,directory}=await fixture(t);const custom=ggufFixture('qwen35','Custom Qwen');const source=path.join(directory,'custom-qwen.gguf');await writeFile(source,custom);const imported=await runtime.importModel(source);assert.equal(imported.toolCapable,false);await runtime.start();const prepared=await runtime.prepareModel(imported.model);assert.equal(prepared.toolCapable,false);const passed=await runtime.calibrateModel(imported.model);assert.equal(passed.toolCapable,true);assert.equal(passed.measuredTokensPerSecond,42);
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
  const lowGPU={...hardware,gpus:[{...hardware.gpus[0],freeMemoryBytes:3*GIB}]};assert.equal(classifyModel(spec,lowGPU).fit,'slow');assert.equal(classifyModel(spec,{...hardware,availableMemoryBytes:128*1024**2}).fit,'insufficient');assert.equal(classifyModel(MODEL_CATALOG[4],hardware).fit,'insufficient');
  const larger={...hardware,availableMemoryBytes:20*GIB,gpus:[{...hardware.gpus[0],freeMemoryBytes:17.7*GIB}]};assert.equal(classifyModel(MODEL_CATALOG[3],larger).fit,'slow');
  assert.equal(parseDevices('BLAS: Accelerate (24000 MiB, 24000 MiB free)\nMetal0: Apple M5 (18186 MiB, 18186 MiB free)','metal','darwin').length,1);
  assert.equal(parseMacAvailableMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2.\nPages inactive: 3.\nPages speculative: 4.\nPages purgeable: 1.'),9*16384);
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
  assert.equal(experimental.digest,spec.sha256);assert.equal(experimental.installed,true);assert.deepEqual(launches,[['--version']],'Selection/listing must not launch an experimental trial.');
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
  assert.deepEqual(runtime.getStatus().experimentalTrial,{...trial,toolProbePassed:true},'Calibration must not change Chat probe, identity, state, timing, metrics or task validation.');
  validToolFormat=false;await assert.rejects(runtime.calibrateModel(spec.id),{code:'MODEL_CALIBRATION_FAILED'});const failed=await runtime.prepareModel(spec.id);assert.equal(failed.toolCapable,false);assert.deepEqual(failed.capabilities,['completion']);
  assert.deepEqual(runtime.getStatus().experimentalTrial,trial,'A failed tool probe retains the successful Chat-only trial without promoting it.');
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

test('execution request timeout is configurable to one hour while control APIs retain short limits',async t=>{
  const nativeFetch=fetch;let captured:AbortSignal|undefined;
  const {runtime}=await fixture(t,{},hardware,async(input,init)=>{if(String(input).endsWith('/v1/chat/completions')&&JSON.parse(String(init?.body)).messages?.[0]?.content==='deadline probe'){captured=init?.signal??undefined;return new Promise((_resolve,reject)=>{captured?.addEventListener('abort',()=>reject(captured?.reason),{once:true});});}return nativeFetch(input,init);});
  await runtime.start();await runtime.prepareModel(spec.id);runtime.setExecutionRequestTimeout(1000);
  await assert.rejects(runtime.requestStream('/v1/chat/completions',{messages:[{role:'user',content:'deadline probe'}]}),{name:'TimeoutError'});assert(captured?.aborted);
  runtime.setExecutionRequestTimeout(3600000);assert.throws(()=>runtime.setExecutionRequestTimeout(3600001),{code:'INVALID_REQUEST_DEADLINE'});assert.equal((await runtime.requestJson<{total_slots:number}>('/props')).total_slots,1);
});
