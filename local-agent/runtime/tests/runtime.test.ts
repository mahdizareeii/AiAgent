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
async function fixture(t:TestContext,extraEnv:NodeJS.ProcessEnv={},detectedHardware:HardwareInfo=hardware,fetchImplementation?:typeof fetch){
  const directory=await mkdtemp(path.join(tmpdir(),'local-agent-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(path.join(directory,'models'));await writeFile(path.join(directory,'models',spec.filename),bytes);
  const launches:string[][]=[];
  const runtime=new LocalInferenceRuntime({dataDirectory:directory,executablePath:process.execPath,catalog:[spec],hardware:detectedHardware,startupTimeoutMs:3000,stopTimeoutMs:500,fetch:fetchImplementation,
    env:{...process.env,OPENAI_API_KEY:'secret',LLAMA_ARG_TOOLS:'all',LLAMA_ARG_RPC:'remote:5000'},
    spawn:(command,args,options)=>{launches.push(args);return spawn(process.execPath,[fake,...args],{...options,env:{...options.env,...extraEnv}});}});
  t.after(()=>runtime.stop());return {runtime,directory,launches};
}

test('pinned engine starts without loading weights; private offline process strips inherited secrets and reuses a verified model',async t=>{
  const {runtime,directory,launches}=await fixture(t);const status=await runtime.start();assert.equal(status.state,'ready');assert.equal(status.baseUrl,null);
  const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.toolCapable,true);assert.equal(prepared.model,'local-agent-fixture-4b');assert.match(prepared.apiKey,/^[a-f0-9]{64}$/);assert.equal(prepared.measuredTokensPerSecond,42);assert.equal(prepared.outputTokens,2048);assert.equal(runtime.getStatus().profile?.outputTokens,2048);
  const env=await runtime.requestJson<{secret?:string;tools?:string;rpc?:string;flags:string[];pid:number}>('/env');assert.equal(env.secret,undefined);assert.equal(env.tools,undefined);assert.equal(env.rpc,undefined);
  for(const flag of ['--offline','--no-agent','--no-webui','--no-ui-mcp-proxy','--no-cache-prompt','--no-cache-idle-slots','--no-context-shift'])assert(env.flags.includes(flag));
  assert.equal(env.flags[env.flags.indexOf('--cache-ram')+1],'0');assert.equal(env.flags[env.flags.indexOf('--parallel')+1],'1');assert.equal(env.flags[env.flags.indexOf('--host')+1],'127.0.0.1');
  assert.equal(env.flags[env.flags.indexOf('--predict')+1],'2048');assert.equal(env.flags[env.flags.indexOf('--ctx-size')+1],'8192');
  assert.equal((await fetch(`${prepared.baseUrl}/props`)).status,401);assert.deepEqual((await readdir(directory)).filter(f=>f.startsWith('.inference-key-')),[]);
  const again=await runtime.prepareModel(spec.id);assert.equal(again.baseUrl,prepared.baseUrl);assert.equal((await runtime.requestJson<{pid:number}>('/env')).pid,env.pid);assert.equal(launches.filter(a=>a.includes('--model')).length,1);
  await runtime.stop();assert.equal(runtime.getStatus().state,'stopped');await assert.rejects(fetch(`${prepared.baseUrl}/props`));
});

test('allocation failures reduce batches before the bounded 4K CPU profile, with finite exhaustion',async t=>{
  const {runtime,launches}=await fixture(t,{FAKE_ALLOCATE:'large'});await runtime.start();const prepared=await runtime.prepareModel(spec.id);assert.equal(prepared.contextTokens,8192);assert.equal(prepared.outputTokens,2048);assert.equal(runtime.getStatus().profile?.index,1);
  const lower=await runtime.restartLowerProfile();assert.equal(lower.contextTokens,4096);assert.equal(runtime.getStatus().profile?.backend,'cpu');assert.equal(lower.outputTokens,1024);assert.equal(runtime.getStatus().profile?.outputTokens,1024);await assert.rejects(runtime.restartLowerProfile(),{code:'PROFILE_EXHAUSTED'});
  assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--batch-size')+1]),['512','256','128']);
  assert.deepEqual(launches.filter(a=>a.includes('--model')).map(a=>a[a.indexOf('--predict')+1]),['2048','2048','1024']);
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
