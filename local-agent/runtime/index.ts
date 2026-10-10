import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { totalmem } from 'node:os';
import { MODEL_CATALOG, type CuratedModel } from './catalog.ts';
import { downloadModel, type PullProgress } from './download.ts';
import { abortError, isAllocationFailure, RuntimeError, throwIfAborted } from './errors.ts';
import { readGGUFMetadata, sha256File } from './gguf.ts';
import { classifyModel, GIB, parseDevices, probeHardware, type FitResult, type HardwareInfo } from './hardware.ts';
export { MODEL_CATALOG, RuntimeError, isAllocationFailure, classifyModel, probeHardware };
export type { CuratedModel, PullProgress, HardwareInfo };

export const ENGINE_VERSION='0.6.0';
export const ENGINE_COMMIT='d81235049384534c167caea52b85a694f6103d14';
export interface ModelRecommendation {supported:boolean;totalMemoryGB:number;suggestedModel:string|null;contextTokens:number;reason:string|null;}
export function recommendModel(memoryBytes=totalmem()):ModelRecommendation {
  const gb=memoryBytes/GIB;return {supported:gb>=8,totalMemoryGB:Math.round(gb*10)/10,suggestedModel:gb>=24?'gemma4:12b':gb>=8?'qwen3.5:4b':null,contextTokens:8192,reason:gb>=8?null:'The curated models require at least 8 GB of system memory.'};
}
export interface AvailableModel extends CuratedModel,FitResult {installed:boolean;sizeBytes:number;digest:string|null;blockedReason:string|null;measuredTokensPerSecond?:number;}
export interface VerifiedModel {model:string;digest:string;sizeBytes:number;capabilities:string[];verifiedAt:string;toolCapable:boolean;}
export interface PreparedModel extends VerifiedModel {sourceModel:string;baseUrl:string;apiKey:string;contextTokens:number;outputTokens:number;measuredTokensPerSecond?:number;}
export interface InferenceProfile {contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;backend:string;index:number;}
export type RuntimeState='stopped'|'starting'|'ready'|'loading'|'stopping'|'error';
export interface RuntimeStatus {state:RuntimeState;baseUrl:string|null;version:string|null;executablePath:string|null;modelCacheDirectory:string;recommendation:ModelRecommendation;downloadingModel:string|null;error:{code:string;message:string}|null;hardware:HardwareInfo|null;profile:InferenceProfile|null;loadedModel:string|null;slowMode:boolean;}
export interface EngineBackend {id:string;executable:string;libraryDirectory?:string;arguments?:string[];}
interface EngineManifest {schemaVersion:number;engine:string;version:string;commit:string;build:number;target:string;backends:EngineBackend[];files:{path:string;sha256:string;size:number}[];}
export interface RuntimeOptions {
  dataDirectory:string;resourcesDirectory?:string;
  /** Trusted development/test override. Never accept a renderer supplied executable path. */
  executablePath?:string;port?:number;startupTimeoutMs?:number;requestTimeoutMs?:number;stopTimeoutMs?:number;
  totalMemoryBytes?:number;availableMemoryBytes?:number;env?:NodeJS.ProcessEnv;fetch?:typeof fetch;
  spawn?:(command:string,args:string[],options:SpawnOptions)=>ChildProcess;
  freeDiskBytes?:(directory:string)=>Promise<number|null>;
  /** Trusted test fixtures; production always uses the pinned catalog and actual hardware. */
  catalog?:readonly CuratedModel[];hardware?:HardwareInfo;skipCalibration?:boolean;
}
interface FileFingerprint {size:number;mtimeMs:number;ctimeMs:number;ino:number;dev:number;}
interface VerificationRecord {fingerprint:FileFingerprint;verified:VerifiedModel;}
const fingerprint=(s:Stats):FileFingerprint=>({size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino,dev:s.dev});
const same=(a:FileFingerprint,b:FileFingerprint)=>Object.keys(a).every(k=>a[k as keyof FileFingerprint]===b[k as keyof FileFingerprint]);
async function reservePort(port?:number):Promise<number>{
  if(port!==undefined&&(!Number.isInteger(port)||port<1||port>65535))throw new RuntimeError('INVALID_PORT','The local inference port is invalid.');
  return new Promise((resolve,reject)=>{const server=createServer();server.once('error',(e:NodeJS.ErrnoException)=>reject(new RuntimeError(e.code==='EADDRINUSE'?'PORT_IN_USE':'PORT_UNAVAILABLE','The app-owned inference port is unavailable.',{cause:e})));server.listen({host:'127.0.0.1',port:port??0,exclusive:true},()=>{const address=server.address();if(!address||typeof address==='string'){server.close();reject(new RuntimeError('PORT_UNAVAILABLE','Could not reserve a loopback port.'));return;}server.close(e=>e?reject(e):resolve(address.port));});});
}
/** App-owned offline inference process and pinned GGUF management; no external daemon/install. */
export class LocalInferenceRuntime extends EventEmitter {
  private settings:RuntimeOptions;private status:RuntimeStatus;private engine:EngineBackend[]=[];
  private manifest:EngineManifest|null=null;private child:ChildProcess|null=null;private childExit:Promise<void>|null=null;
  private startPromise:Promise<RuntimeStatus>|null=null;private stopPromise:Promise<void>|null=null;private preparePromise:Promise<PreparedModel>|null=null;private pullPromise:Promise<VerifiedModel>|null=null;
  private startController:AbortController|null=null;private loadController:AbortController|null=null;private pullController:AbortController|null=null;
  private lastLog='';private suppressExit=false;private apiKey='';private prepared:PreparedModel|null=null;
  private verification=new Map<string,VerificationRecord>();private measurements=new Map<string,number>();private profileIndex=0;
  private imports=new Map<string,CuratedModel>();private importsLoaded=false;private toolsPassed=new Map<string,boolean>();
  private calibrationPromise:Promise<PreparedModel>|null=null;private calibrationController:AbortController|null=null;
  private settingsPromise:Promise<void>|null=null;
  constructor(settings:RuntimeOptions){super();if(!path.isAbsolute(settings.dataDirectory))throw new RuntimeError('INVALID_DATA_DIRECTORY','Use an absolute app-owned runtime directory.');this.settings=settings;
    this.status={state:'stopped',baseUrl:null,version:null,executablePath:null,modelCacheDirectory:path.join(settings.dataDirectory,'models'),recommendation:recommendModel(settings.totalMemoryBytes),downloadingModel:null,error:null,hardware:null,profile:null,loadedModel:null,slowMode:false};}
  getStatus():RuntimeStatus{return structuredClone(this.status);}
  async setSlowMode(enabled:boolean):Promise<void> {this.assertIdle();if(this.status.slowMode===Boolean(enabled))return;
    this.settingsPromise=Promise.resolve().then(async()=>{if(this.child){await this.terminateChild();this.prepared=null;}if(this.stopPromise||this.status.state==='stopping')throw new RuntimeError('MODEL_BUSY','The runtime is stopping.');this.update({slowMode:Boolean(enabled),loadedModel:null,profile:null,state:this.engine.length?'ready':'stopped'});if(this.status.hardware)this.update({recommendation:this.hardwareRecommendation(this.status.hardware)});}).finally(()=>{this.settingsPromise=null;});return this.settingsPromise;
  }
  private assertIdle():void {if(this.stopPromise||this.status.state==='stopping')throw new RuntimeError('MODEL_BUSY','The runtime is stopping.');if(this.preparePromise||this.calibrationPromise||this.settingsPromise)throw new RuntimeError('MODEL_BUSY','Wait for model loading, calibration or settings to finish.');}
  private update(changes:Partial<RuntimeStatus>):void{this.status={...this.status,...changes};this.emit('status',this.getStatus());}
  private catalog():readonly CuratedModel[]{return [...(this.settings.catalog??MODEL_CATALOG),...this.imports.values()];}
  private hardwareRecommendation(hardware:HardwareInfo):ModelRecommendation {
    const rows=this.catalog().map(spec=>({spec,fit:classifyModel(spec,hardware).fit}));const eligible=rows.filter(r=>r.fit==='recommended'||this.status.slowMode&&r.fit==='slow');
    const preferred=hardware.totalMemoryBytes>=24*GIB?'gemma4:12b':'qwen3.5:4b';const chosen=eligible.find(r=>r.spec.id===preferred&&r.fit==='recommended')??eligible.find(r=>r.fit==='recommended')??eligible[0];
    return {...recommendModel(hardware.totalMemoryBytes),supported:rows.some(r=>r.fit!=='insufficient'),suggestedModel:chosen?.spec.id??null,contextTokens:8192,reason:chosen?null:rows.some(r=>r.fit==='slow')?'Enable Slow mode for CPU or partial GPU inference, or free memory to use an accelerated model.':'The model weights exceed the current safe memory budget. Close applications or choose a smaller GGUF.'};
  }
  private spec(model:string):CuratedModel{const spec=this.catalog().find(s=>s.id===model);if(!spec)throw new RuntimeError('MODEL_NOT_ALLOWED','Select a curated local model.');return spec;}
  private async loadImports():Promise<void>{
    if(this.importsLoaded)return;this.importsLoaded=true;
    let records:unknown;try{records=JSON.parse(await readFile(path.join(this.settings.dataDirectory,'imports.json'),'utf8'));}catch{return;}
    if(!Array.isArray(records)||records.length>100)return;
    for(const raw of records){if(!raw||typeof raw!=='object')continue;const s=raw as CuratedModel;
      if(!/^import:[a-f0-9]{64}$/.test(s.id)||!/^import-[a-f0-9]{64}\.gguf$/.test(s.filename)||s.id!==`import:${s.sha256}`||s.filename!==`import-${s.sha256}.gguf`||!Number.isSafeInteger(s.estimatedDownloadBytes)||s.estimatedDownloadBytes<24||s.estimatedDownloadBytes>128*GIB||!Number.isFinite(s.workingMemoryGB)||s.workingMemoryGB<s.estimatedDownloadBytes/GIB||typeof s.architecture!=='string'||s.architecture.length>100||typeof s.title!=='string'||s.title.length>500)continue;
      this.imports.set(s.id,{...s,repository:'',revision:'',sourceUrl:'',license:'Imported file: verify its publisher license',toolCapable:false});
    }
  }
  private async saveImports():Promise<void>{const target=path.join(this.settings.dataDirectory,'imports.json'),temp=`${target}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify([...this.imports.values()]),{mode:0o600,flag:'wx'});await rename(temp,target);}finally{await rm(temp,{force:true});}}
  private async disk(directory:string):Promise<number|null>{if(this.settings.freeDiskBytes)return this.settings.freeDiskBytes(directory);try{const s=await statfs(directory);return Number(s.bavail)*Number(s.bsize);}catch{return null;}}
  private childEnvironment(backend?:EngineBackend):NodeJS.ProcessEnv {
    const input=this.settings.env??process.env;const env:NodeJS.ProcessEnv={};
    for(const name of ['PATH','Path','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','LOCALAPPDATA','APPDATA'])if(input[name]!==undefined)env[name]=input[name];
    if(backend?.libraryDirectory&&this.settings.resourcesDirectory){const directory=path.resolve(this.settings.resourcesDirectory,backend.libraryDirectory);if(process.platform==='win32')env.PATH=`${directory};${env.PATH??env.Path??''}`;else env[process.platform==='darwin'?'DYLD_LIBRARY_PATH':'LD_LIBRARY_PATH']=directory;}
    return env;
  }
  private execute(command:string,args:string[],signal?:AbortSignal,backend?:EngineBackend):Promise<string>{return new Promise((resolve,reject)=>{
    throwIfAborted(signal);const child=(this.settings.spawn??spawn)(command,args,{env:this.childEnvironment(backend),stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});let output='',done=false;
    const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(output);};
    const cancel=()=>{child.kill('SIGKILL');finish(abortError());};const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new RuntimeError('ENGINE_PROBE_TIMEOUT','The bundled engine probe timed out.'));},15000);
    signal?.addEventListener('abort',cancel,{once:true});for(const stream of [child.stdout,child.stderr])stream?.on('data',(b:Buffer)=>{output=(output+b.toString()).slice(-128*1024);});child.once('error',finish);child.once('close',code=>finish(code===0?undefined:new RuntimeError('ENGINE_PROBE_FAILED',output.slice(-2000)||`Engine exited ${code}.`)));if(signal?.aborted)cancel();
  });}
  start(options:{signal?:AbortSignal}={}):Promise<RuntimeStatus>{
    if(this.status.state==='ready'||this.status.state==='loading')return Promise.resolve(this.getStatus());if(this.startPromise)return this.startPromise;if(this.stopPromise)return this.stopPromise.then(()=>this.start(options));
    const controller=new AbortController();this.startController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    this.startPromise=this.startInternal(signal).finally(()=>{this.startPromise=null;this.startController=null;});return this.startPromise;
  }
  private async startInternal(signal:AbortSignal):Promise<RuntimeStatus>{this.update({state:'starting',error:null});try{
    await mkdir(this.status.modelCacheDirectory,{recursive:true,mode:0o700});
    for(const name of await readdir(this.settings.dataDirectory)){if(/^\.inference-key-[a-f0-9-]{36}$/.test(name)){const candidate=path.join(this.settings.dataDirectory,name);const s=await lstat(candidate);if(s.isFile()&&!s.isSymbolicLink())await rm(candidate,{force:true});}}
    await this.loadImports();throwIfAborted(signal);
    if(this.settings.executablePath){await access(this.settings.executablePath,process.platform==='win32'?constants.F_OK:constants.X_OK);this.engine=[{id:process.platform==='darwin'?'metal':'vulkan',executable:this.settings.executablePath},{id:'cpu',executable:this.settings.executablePath,arguments:['--device','none','--n-gpu-layers','0']}];}
    else await this.readManifest(signal);
    let backend:EngineBackend|undefined,lastProbeError:unknown;
    for(const candidate of [this.engine[0],this.engine.find(b=>b.id==='cpu')].filter((b,i,all):b is EngineBackend=>Boolean(b)&&all.indexOf(b)===i)){
      try{const version=await this.execute(this.binary(candidate),['--version'],signal,candidate);
        if(!/0\.6\.0(?:-dev)?\b/.test(version)||!version.includes('d812350')||!/11429/.test(version))throw new RuntimeError('INVALID_ENGINE_VERSION','The bundled inference engine does not match pinned llama.cpp 0.6.0 (build 11429, d812350).');backend=candidate;break;
      }catch(error){if(signal.aborted)throw error;lastProbeError=error;if(candidate.id!=='cpu')this.emit('log','Accelerated engine unavailable; checking the bundled CPU engine.\n');}
    }
    if(!backend)throw lastProbeError??new RuntimeError('ENGINE_NOT_AVAILABLE','No bundled inference backend can run.');
    if(backend!==this.engine[0])this.engine=[backend,...this.engine.filter(b=>b!==backend)];
    const hardware=this.settings.hardware?structuredClone(this.settings.hardware):await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});
    if(!this.settings.hardware&&backend.id!=='cpu'){try{hardware.gpus=parseDevices(await this.execute(this.binary(backend),['--list-devices'],signal,backend),backend.id,hardware.platform);}catch(error){if(signal.aborted)throw error;this.emit('log','GPU discovery unavailable; CPU fallback remains available.\n');}}
    const recommendation=this.hardwareRecommendation(hardware);
    throwIfAborted(signal);this.update({state:'ready',version:ENGINE_VERSION,executablePath:this.binary(backend),hardware,recommendation,error:null});return this.getStatus();
  }catch(error){if(signal.aborted){this.update({state:'stopped',error:null});throw abortError();}const failure=error instanceof RuntimeError?error:new RuntimeError('ENGINE_NOT_AVAILABLE','The bundled inference engine is missing or cannot run. Reinstall the app or prepare its native resources.',{cause:error});this.update({state:'error',error:{code:failure.code,message:failure.message}});throw failure;}}
  private binary(backend:EngineBackend):string{return path.isAbsolute(backend.executable)?backend.executable:path.resolve(this.settings.resourcesDirectory!,backend.executable);}
  private async readManifest(signal:AbortSignal):Promise<void>{
    if(!this.settings.resourcesDirectory)throw new RuntimeError('ENGINE_NOT_AVAILABLE','Bundled inference resources are unavailable.');const root=await realpath(this.settings.resourcesDirectory);const raw=await readFile(path.join(root,'manifest.json'),'utf8');if(raw.length>1024**2)throw new RuntimeError('INVALID_ENGINE_MANIFEST','The engine manifest is oversized.');
    const manifest=JSON.parse(raw) as EngineManifest;if(manifest.schemaVersion!==1||manifest.engine!=='llama.cpp'||manifest.version!==ENGINE_VERSION||manifest.commit!==ENGINE_COMMIT||manifest.build!==11429||manifest.target!==`${process.platform}-${process.arch}`||!Array.isArray(manifest.backends)||!Array.isArray(manifest.files)||!manifest.backends.some(b=>b.id==='cpu'))throw new RuntimeError('INVALID_ENGINE_MANIFEST','The engine manifest does not match this app and platform.');
    for(const file of manifest.files){throwIfAborted(signal);const candidate=path.resolve(root,file.path);if(!candidate.startsWith(`${root}${path.sep}`))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine resource path escapes its bundle.');const resolved=await realpath(candidate);if(!resolved.startsWith(`${root}${path.sep}`))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine resource link escapes its bundle.');const s=await stat(resolved);if(!s.isFile()||s.size!==file.size||await sha256File(resolved,signal)!==file.sha256)throw new RuntimeError('ENGINE_DIGEST_MISMATCH','A bundled engine resource does not match its pinned SHA-256.');}
    for(const backend of manifest.backends){if(!manifest.files.some(f=>f.path===backend.executable))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine executable is not covered by the integrity manifest.');}
    this.manifest=manifest;this.engine=manifest.backends;
  }
  async listModels():Promise<AvailableModel[]>{
    await this.loadImports();
    const hardware=this.status.hardware??await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});
    return Promise.all(this.catalog().map(async spec=>{let installed=false,sizeBytes=0;try{const s=await lstat(path.join(this.status.modelCacheDirectory,spec.filename));installed=s.isFile()&&!s.isSymbolicLink()&&s.size===spec.estimatedDownloadBytes;sizeBytes=s.size;}catch{}
      const fit=classifyModel(spec,hardware);return {...spec,...fit,toolCapable:this.toolsPassed.get(spec.id)??spec.toolCapable,installed,sizeBytes,digest:installed?spec.sha256:null,blockedReason:fit.fit==='insufficient'?fit.fitReason:null,measuredTokensPerSecond:this.measurements.get(spec.id)};}));
  }
  async inspectModel(model:string,options:{signal?:AbortSignal;acceptNewDigest?:boolean}={}):Promise<VerifiedModel>{
    await this.loadImports();const spec=this.spec(model);throwIfAborted(options.signal);const file=path.join(this.status.modelCacheDirectory,spec.filename);let s;try{s=await lstat(file);}catch{throw new RuntimeError('MODEL_NOT_FOUND','Download or import this model first.');}
    if(!s.isFile()||s.isSymbolicLink()||s.size!==spec.estimatedDownloadBytes)throw new RuntimeError('MODEL_SIZE_MISMATCH','The model file does not match the pinned artifact size.');const mark=fingerprint(s);const known=this.verification.get(model);if(known&&same(known.fingerprint,mark))return {...known.verified};
    const digest=await sha256File(file,options.signal);if(digest!==spec.sha256)throw new RuntimeError('MODEL_DIGEST_MISMATCH','The model does not match its pinned SHA-256. Download or import the approved file again.');const metadata=await readGGUFMetadata(file,options.signal);if(!metadata.architecture.startsWith(spec.architecture))throw new RuntimeError('MODEL_ARCHITECTURE_MISMATCH','The model architecture does not match the curated catalog.');
    const after=await stat(file);if(!same(mark,fingerprint(after)))throw new RuntimeError('MODEL_CHANGED','The model changed while it was being verified.');
    const toolCapable=this.toolsPassed.get(model)??spec.toolCapable;const verified={model,digest,sizeBytes:s.size,capabilities:toolCapable?['completion','tools']:['completion'],toolCapable,verifiedAt:new Date().toISOString()};this.verification.set(model,{fingerprint:mark,verified});return {...verified};
  }
  async pullModel(model:string,options:{signal?:AbortSignal;onProgress?:(p:PullProgress)=>void}={}):Promise<VerifiedModel>{
    this.assertIdle();const spec=this.spec(model);if(!spec.repository)throw new RuntimeError('MODEL_DOWNLOAD_UNAVAILABLE','Imported files cannot be downloaded from the catalog.');if(this.pullController)throw new RuntimeError('DOWNLOAD_BUSY','A model download is already running.');throwIfAborted(options.signal);
    const controller=new AbortController();this.pullController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;this.update({downloadingModel:model});
    this.pullPromise=(async()=>{try{await downloadModel(spec,this.status.modelCacheDirectory,{signal,fetch:this.settings.fetch,freeDiskBytes:d=>this.disk(d),onProgress:p=>{options.onProgress?.(p);this.emit('pull-progress',p);}});this.verification.delete(model);return await this.inspectModel(model,{signal});}
    finally{if(this.pullController===controller)this.pullController=null;this.update({downloadingModel:null});}})().finally(()=>{this.pullPromise=null;});return this.pullPromise;
  }
  cancelPull():void{this.pullController?.abort();}
  async importModel(sourcePath:string,options:{signal?:AbortSignal}={}):Promise<VerifiedModel>{
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController)throw new RuntimeError('MODEL_BUSY','Wait for other model operations to finish.');
    const controller=new AbortController();this.pullController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const work=(async()=>{await this.loadImports();const source=await lstat(sourcePath);if(!source.isFile()||source.isSymbolicLink()||source.size<24||source.size>128*GIB)throw new RuntimeError('INVALID_GGUF','Import a regular GGUF file no larger than 128 GiB.');
      await mkdir(this.status.modelCacheDirectory,{recursive:true,mode:0o700});const free=await this.disk(this.status.modelCacheDirectory);if(free!==null&&free<source.size+512*1024**2)throw new RuntimeError('INSUFFICIENT_STORAGE','There is not enough free storage to copy this GGUF into the app cache.');
      const temp=path.join(this.status.modelCacheDirectory,`.import-${randomUUID()}.gguf`);
      try{await pipeline(createReadStream(sourcePath,{end:source.size-1}),createWriteStream(temp,{flags:'wx',mode:0o600}),{signal});throwIfAborted(signal);if((await stat(temp)).size!==source.size)throw new RuntimeError('MODEL_CHANGED','The source GGUF changed while being imported.');const metadata=await readGGUFMetadata(temp,signal),digest=await sha256File(temp,signal);const curated=this.catalog().find(s=>s.sha256===digest&&s.estimatedDownloadBytes===source.size);
        const spec:CuratedModel=curated??{id:`import:${digest}`,title:(metadata.name||path.basename(sourcePath)).slice(0,500),description:'Imported local GGUF. Chat only until tool-call calibration succeeds.',estimatedDownloadBytes:source.size,minimumMemoryGB:Math.ceil(source.size/GIB+4),workingMemoryGB:source.size/GIB+2,license:'Imported file: verify its publisher license',sourceUrl:'',quantization:'Imported GGUF',repository:'',revision:'',filename:`import-${digest}.gguf`,sha256:digest,architecture:metadata.architecture,toolCapable:false};
        throwIfAborted(signal);await rename(temp,path.join(this.status.modelCacheDirectory,spec.filename));if(!curated){this.imports.set(spec.id,spec);await this.saveImports();}this.verification.delete(spec.id);return await this.inspectModel(spec.id,{signal});
      }finally{await rm(temp,{force:true});}
    })();this.pullPromise=work;try{return await work;}finally{if(this.pullController===controller)this.pullController=null;if(this.pullPromise===work)this.pullPromise=null;}
  }
  async prepareModel(model:string,options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController)throw new RuntimeError('DOWNLOAD_BUSY','Wait for the model download to finish.');
    const controller=new AbortController();this.loadController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;if(this.prepared?.sourceModel!==model)this.profileIndex=0;
    this.preparePromise=this.prepareInternal(model,signal,true).catch(error=>{if(!this.child){this.update({state:this.engine.length?'ready':'stopped',baseUrl:null,loadedModel:null,profile:null,error:signal.aborted?null:{code:error instanceof RuntimeError?error.code:'MODEL_LOAD_FAILED',message:error instanceof Error?error.message:'Model loading failed.'}});}throw error;}).finally(()=>{this.preparePromise=null;this.loadController=null;});return this.preparePromise;
  }
  private profiles():InferenceProfile[]{const available=this.status.hardware?.gpus.some(g=>g.backend===this.engine[0]?.id);const backend=available?this.engine[0].id:'cpu';return [
    {contextTokens:8192,outputTokens:2048,batchTokens:512,microBatchTokens:128,backend,index:0},
    {contextTokens:8192,outputTokens:2048,batchTokens:256,microBatchTokens:64,backend,index:1},
    {contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32,backend:'cpu',index:2}];}
  private async prepareInternal(model:string,signal:AbortSignal,verify:boolean):Promise<PreparedModel>{
    if(!this.engine.length)await this.start({signal});const spec=this.spec(model);
    const verified=await this.inspectModel(model,{signal});throwIfAborted(signal);
    if(verify&&this.prepared?.sourceModel===model&&this.child&&this.status.state==='ready'&&this.prepared.digest===verified.digest)return {...this.prepared};
    await this.terminateChild();this.prepared=null;
    if(!this.settings.hardware){const hardware=await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});hardware.gpus=this.status.hardware?.gpus??[];this.update({hardware,recommendation:this.hardwareRecommendation(hardware)});}
    const hardware=this.status.hardware!;const fit=classifyModel(spec,hardware);
    if(fit.fit==='insufficient')throw new RuntimeError('INSUFFICIENT_MEMORY',fit.fitReason);if(verify&&fit.fit==='slow'&&!this.status.slowMode)throw new RuntimeError('SLOW_MODE_REQUIRED','This model requires Slow mode on the detected hardware. Enable it explicitly or choose a recommended model.');
    const profiles=this.profiles();if(this.status.slowMode)this.profileIndex=Math.max(this.profileIndex,1);
    for(;this.profileIndex<profiles.length;this.profileIndex++){
      const profile=profiles[this.profileIndex];this.update({state:'loading',profile,loadedModel:null,error:null});
      try{if(profile.backend==='cpu'){const cpuFit=classifyModel(spec,{...hardware,gpus:[]});if(cpuFit.fit==='insufficient')throw new RuntimeError('INSUFFICIENT_MEMORY',`CPU fallback cannot fit this model in system memory without exceeding the safe budget. ${cpuFit.fitReason}`);}const prepared=await this.loadModel(spec,verified,profile,signal);this.prepared=prepared;this.update({state:'ready',loadedModel:model,error:null});return {...prepared};}
      catch(error){await this.terminateChild();if(signal.aborted){this.update({state:'ready',loadedModel:null,baseUrl:null,profile:null,error:null});throw abortError();}if(!isAllocationFailure(error)||this.profileIndex===profiles.length-1){const failure=error instanceof RuntimeError?error:new RuntimeError('MODEL_LOAD_FAILED',error instanceof Error?error.message:'The model could not load.',{cause:error});this.update({state:'error',baseUrl:null,loadedModel:null,error:{code:failure.code,message:failure.message}});throw failure;}this.emit('log','Allocation failed; trying a smaller bounded inference profile.\n');}
    }throw new RuntimeError('INSUFFICIENT_MEMORY','All bounded inference profiles exhausted available memory.');
  }
  private async loadModel(spec:CuratedModel,verified:VerifiedModel,profile:InferenceProfile,signal:AbortSignal):Promise<PreparedModel>{
    const backend=this.engine.find(b=>b.id===profile.backend)??this.engine.find(b=>b.id==='cpu')!;const port=await reservePort(this.settings.port);throwIfAborted(signal);this.apiKey=randomBytes(32).toString('hex');const authFile=path.join(this.settings.dataDirectory,`.inference-key-${randomUUID()}`);await writeFile(authFile,this.apiKey,{mode:0o600,flag:'wx'});
    const alias=`local-agent-${spec.id.replace(/[^a-z0-9]/g,'-')}`;const args=[...(backend.arguments??[]),'--model',path.join(this.status.modelCacheDirectory,spec.filename),'--alias',alias,'--host','127.0.0.1','--port',String(port),'--api-key-file',authFile,'--offline','--no-agent','--no-webui','--no-ui-mcp-proxy','--parallel','1','--jinja','--ctx-size',String(profile.contextTokens),'--predict',String(profile.outputTokens),'--batch-size',String(profile.batchTokens),'--ubatch-size',String(profile.microBatchTokens),'--cache-ram','0','--no-cache-prompt','--no-cache-idle-slots','--ctx-checkpoints','0','--no-context-shift','--no-warmup','--flash-attn','auto','--reasoning','off','--load-mode','mmap','--fit','on','--fit-target','1024'];
    this.lastLog='';this.update({baseUrl:`http://127.0.0.1:${port}`,executablePath:this.binary(backend)});let child:ChildProcess;try{throwIfAborted(signal);child=(this.settings.spawn??spawn)(this.binary(backend),args,{env:this.childEnvironment(backend),cwd:this.settings.dataDirectory,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});}catch(error){await rm(authFile,{force:true});throw error;}this.child=child;const launch:{error?:Error}={};
    child.once('error',e=>{launch.error=e;});this.childExit=new Promise(resolve=>child.once('close',(code,exitSignal)=>{if(this.child===child){this.child=null;if(!this.suppressExit&&this.status.state!=='stopping'&&this.status.state!=='stopped')this.update({state:'error',loadedModel:null,baseUrl:null,error:{code:'RUNTIME_EXITED',message:`The local inference engine stopped (${exitSignal??code}). ${this.lastLog.slice(-1000)}`}});}resolve();}));
    for(const stream of [child.stdout,child.stderr])stream?.on('data',(b:Buffer)=>{const text=b.toString();this.lastLog=(this.lastLog+text).slice(-8000);this.emit('log',text.replaceAll(this.apiKey,'[internal token]'));});
    const cancel=()=>child.kill('SIGTERM');signal.addEventListener('abort',cancel,{once:true});
    try{const deadline=Date.now()+(this.settings.startupTimeoutMs??180000);let healthy=false;
      while(Date.now()<deadline){throwIfAborted(signal);if(launch.error||this.child!==child||child.exitCode!==null||child.signalCode!==null)throw new RuntimeError(/address already in use/i.test(this.lastLog)?'PORT_IN_USE':isAllocationFailure(this.lastLog)?'ALLOCATION_FAILED':'MODEL_LOAD_FAILED',launch.error?.message??(this.lastLog.slice(-4000)||'The inference engine stopped before readiness.'));
        try{const health=await this.requestJson<{status:string}>('/health',undefined,signal,1500);if(health.status==='ok'){healthy=true;break;}}catch(error){if(signal.aborted)throw error;}
        await new Promise(resolve=>setTimeout(resolve,100));}
      if(!healthy)throw new RuntimeError('MODEL_LOAD_TIMEOUT','The model did not become ready in time.');
      await new Promise(resolve=>setTimeout(resolve,100));throwIfAborted(signal);if(this.child!==child||child.exitCode!==null||child.signalCode!==null)throw new RuntimeError('MODEL_LOAD_FAILED',this.lastLog.slice(-2000));
      const props=await this.requestJson<{total_slots:number;default_generation_settings:{n_ctx:number};build_info:string;ui:boolean;cors_proxy_enabled:boolean;chat_template_caps:Record<string,unknown>}>('/props',undefined,signal);
      const actualContext=props.default_generation_settings?.n_ctx;
      if(props.total_slots!==1||!Number.isInteger(actualContext)||actualContext<512||actualContext>profile.contextTokens||props.ui!==false||props.cors_proxy_enabled!==false||!String(props.build_info).includes('d812350'))throw new RuntimeError('INVALID_ENGINE_PROPERTIES','The local service did not confirm the app-owned bounded engine configuration.');
      const outputTokens=Math.min(profile.outputTokens,Math.max(64,Math.floor(actualContext/4)));
      if(actualContext!==profile.contextTokens)this.update({profile:{...profile,contextTokens:actualContext,outputTokens}});
      let toolCapable=props.chat_template_caps?.supports_tool_calls===true&&(this.toolsPassed.get(spec.id)??spec.toolCapable);
      let measuredTokensPerSecond:number|undefined;
      if(toolCapable&&!this.settings.skipCalibration){try{measuredTokensPerSecond=await this.calibrate(alias,signal);this.toolsPassed.set(spec.id,true);}catch(error){if(signal.aborted||isAllocationFailure(error))throw error;toolCapable=false;this.toolsPassed.set(spec.id,false);this.emit('log','Tool calibration did not pass; this model remains available for chat with tools disabled.\n');}}
      if(!toolCapable&&!this.settings.skipCalibration){try{measuredTokensPerSecond=await this.measureChat(alias,signal);}catch(error){if(signal.aborted||isAllocationFailure(error))throw error;this.emit('log','Chat speed measurement unavailable; this model remains chat-only.\n');}}
      if(!toolCapable)this.toolsPassed.set(spec.id,false);
      const record=this.verification.get(spec.id);if(record){record.verified.toolCapable=toolCapable;record.verified.capabilities=toolCapable?['completion','tools']:['completion'];}
      if(measuredTokensPerSecond!==undefined)this.measurements.set(spec.id,measuredTokensPerSecond);
      return {...verified,capabilities:toolCapable?['completion','tools']:['completion'],model:alias,sourceModel:spec.id,baseUrl:this.status.baseUrl!,apiKey:this.apiKey,contextTokens:actualContext,outputTokens,toolCapable,measuredTokensPerSecond};
    }finally{signal.removeEventListener('abort',cancel);await rm(authFile,{force:true});}
  }
  private async calibrate(model:string,signal:AbortSignal):Promise<number|undefined>{
    const tool={type:'function',function:{name:'local_probe',description:'Return the supplied word.',parameters:{type:'object',properties:{word:{type:'string'}},required:['word'],additionalProperties:false}}};
    const body={model,messages:[{role:'user',content:'Call local_probe with word OK.'}],tools:[tool],tool_choice:'required',parallel_tool_calls:false,max_tokens:96,temperature:0,chat_template_kwargs:{enable_thinking:false},cache_prompt:false};
    await this.requestJson('/v1/chat/completions/input_tokens',body,signal);
    const result=await this.requestJson<{choices?:{message?:{tool_calls?:{function?:{name?:string;arguments?:string}}[]}}[];timings?:{predicted_per_second?:number}}>('/v1/chat/completions',body,signal,120000);
    const call=result.choices?.[0]?.message?.tool_calls?.[0]?.function;let argumentsValid=false;try{argumentsValid=JSON.parse(call?.arguments??'').word==='OK';}catch{}
    if(call?.name!=='local_probe'||!argumentsValid)throw new RuntimeError('MODEL_CALIBRATION_FAILED','The model did not pass its local tool-call calibration. Its tools will remain disabled.');
    const speed=result.timings?.predicted_per_second;return typeof speed==='number'&&Number.isFinite(speed)&&speed>0?speed:undefined;
  }
  private async measureChat(model:string,signal:AbortSignal):Promise<number|undefined>{
    const body={model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:16,temperature:0,cache_prompt:false};
    const result=await this.requestJson<{choices?:{message?:{content?:string}}[];timings?:{predicted_per_second?:number}}>('/v1/chat/completions',body,signal,120000);const speed=result.timings?.predicted_per_second;return typeof result.choices?.[0]?.message?.content==='string'&&typeof speed==='number'&&Number.isFinite(speed)&&speed>0?speed:undefined;
  }
  calibrateModel(model:string,options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(options.signal);const spec=this.spec(model);
    if(model.startsWith('import:')&&!/^(qwen35|gemma4(?:moe)?)$/.test(spec.architecture)){this.toolsPassed.set(model,false);this.emit('log','This imported architecture remains chat-only; checking local chat speed without enabling agent tools.\n');return this.prepareModel(model,options);}
    const controller=new AbortController();this.calibrationController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const loading=this.prepareModel(model,{signal});this.calibrationPromise=(async()=>{const prepared=await loading;throwIfAborted(signal);const owned=this.child;if(!owned||this.stopPromise)throw abortError();
    const props=await this.requestJson<{chat_template_caps?:{supports_tool_calls?:boolean}}>('/props',undefined,signal);
    if(props.chat_template_caps?.supports_tool_calls!==true)throw new RuntimeError('MODEL_TOOL_TEMPLATE_UNSUPPORTED','This model template does not support native tool calls. Chat remains available.');
    try{const speed=await this.calibrate(prepared.model,signal);throwIfAborted(signal);if(this.child!==owned||this.prepared?.sourceModel!==model||this.stopPromise)throw abortError();this.toolsPassed.set(model,true);if(speed)this.measurements.set(model,speed);const record=this.verification.get(model);if(record){record.verified.toolCapable=true;record.verified.capabilities=['completion','tools'];}this.prepared={...prepared,toolCapable:true,capabilities:['completion','tools'],measuredTokensPerSecond:speed};return {...this.prepared};}
    catch(error){if(!signal.aborted){this.toolsPassed.set(model,false);if(this.prepared)this.prepared.toolCapable=false;const record=this.verification.get(model);if(record){record.verified.toolCapable=false;record.verified.capabilities=['completion'];}}throw error;}
    })().finally(()=>{this.calibrationPromise=null;this.calibrationController=null;});return this.calibrationPromise;
  }
  async restartLowerProfile(signal?:AbortSignal):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(signal);if(!this.prepared)throw new RuntimeError('MODEL_NOT_LOADED','Load a verified model before changing its profile.');
    if(this.profileIndex>=2)throw new RuntimeError('PROFILE_EXHAUSTED','The smallest bounded profile is already in use.');const model=this.prepared.sourceModel;this.profileIndex++;const controller=new AbortController();this.loadController=controller;const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    this.preparePromise=this.prepareInternal(model,combined,false).finally(()=>{this.preparePromise=null;this.loadController=null;});return this.preparePromise;
  }
  async requestStream(pathname:string,body:object,signal?:AbortSignal):Promise<Response>{return this.request(pathname,body,signal,0);}
  async requestJson<T=Record<string,unknown>>(pathname:string,body?:object,signal?:AbortSignal,timeoutMs?:number):Promise<T>{return (await this.request(pathname,body,signal,timeoutMs)).json() as Promise<T>;}
  private async request(pathname:string,body?:object,signal?:AbortSignal,timeoutMs=this.settings.requestTimeoutMs??(pathname==='/v1/chat/completions'?900000:60000)):Promise<Response>{
    throwIfAborted(signal);if(!this.child||!this.status.baseUrl||!this.apiKey)throw new RuntimeError('RUNTIME_NOT_READY','Load a local model first.');
    if(!/^\/[a-z0-9_\/-]+$/i.test(pathname))throw new RuntimeError('INVALID_INFERENCE_PATH','Use a local inference API path.');
    const signals=[signal,timeoutMs>0?AbortSignal.timeout(timeoutMs):undefined].filter((v):v is AbortSignal=>Boolean(v));const response=await (this.settings.fetch??fetch)(`${this.status.baseUrl}${pathname}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.apiKey}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:signals.length?AbortSignal.any(signals):undefined,redirect:'error',credentials:'omit'});
    if(!response.ok){const raw=(await response.text()).slice(0,4000);let message=raw;try{const error=JSON.parse(raw).error;message=typeof error==='string'?error:error?.message??raw;}catch{}throw new RuntimeError(isAllocationFailure(message)?'ALLOCATION_FAILED':'INFERENCE_API_ERROR',`Local inference HTTP ${response.status}: ${message}`);}return response;
  }
  stop():Promise<void>{if(this.stopPromise)return this.stopPromise;this.startController?.abort();this.loadController?.abort();this.calibrationController?.abort();this.cancelPull();this.update({state:'stopping'});
    this.stopPromise=(async()=>{await this.terminateChild();await this.preparePromise?.catch(()=>{});await this.calibrationPromise?.catch(()=>{});await this.settingsPromise?.catch(()=>{});await this.startPromise?.catch(()=>{});await this.pullPromise?.catch(()=>{});await this.terminateChild();this.prepared=null;this.apiKey='';this.update({state:'stopped',baseUrl:null,loadedModel:null,profile:null,downloadingModel:null,error:null});})().finally(()=>{this.stopPromise=null;});return this.stopPromise;}
  private async terminateChild():Promise<void>{const child=this.child,exited=this.childExit;if(!child||!exited){this.update({baseUrl:null});return;}this.suppressExit=true;child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{const graceful=await Promise.race([exited.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),this.settings.stopTimeoutMs??3000);})]);if(!graceful&&this.child===child){child.kill('SIGKILL');await exited;}}finally{if(timer)clearTimeout(timer);if(this.child===child)this.child=null;this.suppressExit=false;this.update({baseUrl:null});}}
}
