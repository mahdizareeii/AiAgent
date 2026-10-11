import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {LocalInferenceRuntime,MODEL_CATALOG,isAllocationFailure,type CuratedModel,type HardwareInfo} from '../index.ts';
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
async function fixture(t:TestContext,extraEnv:NodeJS.ProcessEnv={},detectedHardware:HardwareInfo=hardware,fetchImplementation?:typeof fetch,options:{installedModel?:boolean}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'local-agent-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));if(options.installedModel!==false){await mkdir(path.join(directory,'models'));await writeFile(path.join(directory,'models',spec.filename),bytes);}
  const launches:string[][]=[];
  const runtime=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:detectedHardware,startupTimeoutMs:3000,stopTimeoutMs:500,fetch:fetchImplementation,
    env:{...process.env,OPENAI_API_KEY:'secret',LLAMA_ARG_TOOLS:'all',LLAMA_ARG_RPC:'remote:5000'},
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
