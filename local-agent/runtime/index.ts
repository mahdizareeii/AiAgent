import { curatedArtifactSetDigest, ssdProfileContract, exactQwen80Source, ssdNumericalNativeBinding, qwen80SSDArguments, Qwen80NativeStartupLog } from './ssd-contract.ts';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants, type Stats } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { totalmem, release } from 'node:os';
import { MODEL_CATALOG, modelArtifacts, type ModelArtifact, type ModelTaskGuidance, type CuratedModel } from './catalog.ts';
import {generationPolicyForModel,modelGenerationOptions,usesQualifiedProfiles,type ModelGenerationPolicy} from './generation.ts';
import {loopbackFetch} from './transport.ts';
import {validateSSDHashProof} from './integrity.ts';
import {fixedProbeDiagnostic,probeFailureDetail,type FixedProbeDiagnostic,type FixedProbeResponse} from './probes.ts';
import {SSDTrialHistory,type SSDTrialHistoryEntry,type SSDTrialHistoryError} from './history.ts';
import { downloadModel, type PullProgress } from './download.ts';
import { abortError, isAllocationFailure, RuntimeError, throwIfAborted } from './errors.ts';
import { readGGUFMetadata, validateGGUFModelSet, sha256File, type GGUFMetadata } from './gguf.ts';
import { resolveModelImportSource, stageModelImport } from './import-files.ts';
import { PORTABLE_CPU_PROFILE, PORTABLE_CPU_ARGUMENTS, PortableCPUStartupLog, parsePortableCPUAllocationPlan, pendingPortableCPUAdmissionDiagnostic, assertPortableCPUAdmission, assertPortableCPURuntime, type PortableCPUAllocationPlan, type PortableCPUAdmissionDiagnostic } from './portable-admission.ts';
import { allocationPlannerPin, matchesAllocationPlanner } from './planner-pins.ts';
import { classifyModel, GIB, operatingSystemReserve, parseDevices, probeHardware, type FitResult, type HardwareInfo } from './hardware.ts';
import { EngineMemoryLog, EXPERIMENTAL_PROFILE_SIGNATURE, PINNED_ENGINE_COMMIT, experimentalResidentBudget, inferenceProfileSignature, probeResourceMeasurements, validResourceMeasurements, assertQwen80SSDMemory, type ExperimentalTrial, type MemoryMode, type ResourceMeasurements, type SSDStreamingStatus, type SSDResourcePlan, validateSSDResourcePlan, SSD_DEFAULT_PROFILE, ssdProfileSignature, validateSSDStreamingStatus, SSD_CPU_ARGUMENTS, validateSSDNumericalProof, type SSDNumericalConfiguration, type SSDCPUProfileBinding } from './memory.ts';
import {parseNativeMemoryPlan,assertNativeMemoryAdmission,parseNativeResourceSample,nativePlacementArguments,nativeMappedPlacement,museQ3CPUPlacement,nativeEnvironmentOverrides,NativeProfileLog,QWEN_Q3_CHECKPOINT_POLICY,assertNativeCheckpointProfile,PINNED_NATIVE_PLANNER_SHA256,NATIVE_RESOURCE_SOURCE_SHA256,type NativeMemoryPlan,type NativeMemoryProfile} from './memory.ts';
export { MODEL_CATALOG, RuntimeError, isAllocationFailure, classifyModel, probeHardware };
export type { CuratedModel, ModelArtifact, ModelTaskGuidance, PullProgress, HardwareInfo };
export { EXPERIMENTAL_PROFILE_SIGNATURE, experimentalResidentBudget, inferenceProfileSignature, probeResourceMeasurements } from './memory.ts';
export type { ExperimentalTrial, MemoryMode, ResourceMeasurements } from './memory.ts';
export type {SSDTrialHistoryEntry,SSDTrialHistoryError} from './history.ts';
export {generationPolicyForModel,modelGenerationOptions,codingModelFamily,isQualificationEligible} from './generation.ts';
export type {ModelGenerationPolicy,ModelGenerationOptions,CodingModelFamily} from './generation.ts';

export const ENGINE_VERSION='0.6.0';
export const ENGINE_COMMIT=PINNED_ENGINE_COMMIT;
/** A no-longer-owned PID can be the just-exited metadata planner. Only its
 * own terminal event may resolve that ambiguity, within a short bounded grace.
 * Live-process identity/telemetry failures still require stopping the planner. */
export async function plannerExitedAfterSamplerFailure(child:ChildProcess,error:unknown):Promise<boolean>{
  if(!(error instanceof RuntimeError)||error.code!=='ENGINE_PROBE_FAILED'||!/^Engine exited 77\.?$/.test(error.message))return false;
  const exited=()=>child.exitCode!==null||child.signalCode!==null;if(exited())return true;
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);child.removeListener('exit',finish);child.removeListener('close',finish);resolve();};const timer=setTimeout(finish,100);child.once('exit',finish);child.once('close',finish);if(exited())finish();});
  return exited();
}
export interface ModelRecommendation {supported:boolean;totalMemoryGB:number;suggestedModel:string|null;contextTokens:number;reason:string|null;feasibleModels?:string[];}
export function recommendModel(memoryBytes=totalmem()):ModelRecommendation {
  const gb=memoryBytes/GIB;return {supported:gb>=8,totalMemoryGB:Math.round(gb*10)/10,suggestedModel:gb>=24?'gemma4:12b':gb>=8?'qwen3.5:4b':null,contextTokens:8192,reason:gb>=8?null:'The curated models require at least 8 GB of system memory.'};
}
/** The small reference and candidates share the CPU profile on hosts with at most 8 GiB. */
export function isPortableModel(spec:Pick<CuratedModel,'id'|'lowRamCandidate'>,hardware:Pick<HardwareInfo,'totalMemoryBytes'>|null):boolean{return Boolean(spec.lowRamCandidate||spec.id==='qwen3.5:4b'&&hardware&&hardware.totalMemoryBytes>0&&hardware.totalMemoryBytes<=8*GIB);}
function qualifiedBackendBlocker(spec:CuratedModel,hardware:HardwareInfo):ModelBlocker|null{
  return usesQualifiedProfiles(spec.id)&&!(hardware.platform==='darwin'&&hardware.architecture==='arm64'&&hardware.gpus.some(g=>g.backend==='metal'))?{code:'MODEL_BACKEND_UNSUPPORTED',message:'This 27B/30B coding profile requires Apple Silicon Metal. Choose a portable 4K CPU candidate or a smaller supported model on this computer; downloading or importing does not add a compatible backend.'}:null;
}
function modelFit(spec:CuratedModel,hardware:HardwareInfo,mappedCalibration=false):FitResult {
  if(isPortableModel(spec,hardware)){const fit=classifyModel(spec,{...hardware,gpus:[]},4096);return fit.fit==='slow'?{...fit,fitReason:'Estimated weights fit the CPU 4K profile. This profile is selected automatically; exact native allocation planning, current memory admission and local calibration must pass before readiness. Generation may be slow.'}:fit;}
  const backend=qualifiedBackendBlocker(spec,hardware);if(backend)return {...classifyModel(spec,hardware,16384),fit:'insufficient',fitReason:backend.message};
  if(!usesQualifiedProfiles(spec.id))return classifyModel(spec,hardware);
  if(mappedCalibration){const fit=classifyModel(spec,hardware,16384),reserve=operatingSystemReserve(hardware.totalMemoryBytes),workspace=Math.max(GIB,fit.workingMemoryGB*GIB-spec.estimatedDownloadBytes),metal=hardware.gpus.find(g=>g.backend==='metal'&&g.unifiedMemory);if(metal&&spec.estimatedDownloadBytes<metal.freeMemoryBytes&&fit.workingMemoryGB*GIB<=hardware.totalMemoryBytes-reserve&&hardware.availableMemoryBytes>=workspace+reserve)return {...fit,fit:'recommended',fitReason:'Candidate 16K mapped-weight profile: complete checksums, a native allocation plan, memory calibration and local task checks are required before readiness.'};return {...fit,fit:'insufficient',fitReason:'The candidate requires enough capacity for weights and enough current reclaimable memory for bounded workspace plus the OS reserve. Native allocation planning remains required.'};}
  const contexts=[32768,16384];for(const context of contexts){const fit=classifyModel(spec,hardware,context);if(fit.fit==='recommended'&&hardware.availableMemoryBytes>=fit.workingMemoryGB*GIB+512*1024**2)return fit;}
  const fit=classifyModel(spec,hardware,16384);return {...fit,fit:'insufficient',fitReason:'The minimum 16K coding profile requires more currently available memory after the OS reserve. Close memory-heavy applications and refresh hardware.'};
}
export interface ExecutionStoppedEvent {model:string;code:string;message:string;trialId?:string;}
export interface ModelBlocker {code:string;message:string;}
export interface ModelProbeEvidence {status:'passed'|'failed'|'unverified';digest?:string;templateHash?:string;runtime?:string;profileSignature?:string;detail?:string;diagnostic?:FixedProbeDiagnostic;}
export interface AvailableModel extends CuratedModel,FitResult {/** Host-selected preparation route, never a passed allocation or quality result. */preparationProfile?:'portable-cpu-4k-v1';installed:boolean;sizeBytes:number;digest:string|null;blockedReason:string|null;verificationError?:string;measuredTokensPerSecond?:number;integrity?:'verified'|'unverified'|'failed';acquisitionBlocker?:ModelBlocker|null;useBlocker?:ModelBlocker|null;trialBlocker?:ModelBlocker|null;downloadBlocker?:string|null;ssdEligibility?:{supported:boolean;reason:string;minimumSlotsPerLayer:number|null;engineReady:boolean};templateHash?:string;engineIdentity?:string;historicalBindingVerified?:boolean;needsPreparation?:boolean;chatProbe?:ModelProbeEvidence;toolProbe?:ModelProbeEvidence;toolValidationEligible?:boolean;}

export interface VerifiedModel {model:string;digest:string;sizeBytes:number;capabilities:string[];verifiedAt:string;toolCapable:boolean;verificationIO?:'node'|'darwin-nocache';templateHash?:string;artifactDigests?:{filename:string;sha256:string;sizeBytes:number}[];}
export interface PreparedModel extends VerifiedModel {sourceModel:string;baseUrl:string;apiKey:string;contextTokens:number;outputTokens:number;generationPolicy?:ModelGenerationPolicy;calibrationMeasurements?:ResourceMeasurements;nativeMemoryPlan?:NativeMemoryPlan;portableMemoryPlan?:PortableCPUAllocationPlan;measuredTokensPerSecond?:number;memoryMode?:MemoryMode;profileSignature?:string;probePassed?:boolean;engineIdentity?:string;executionRoute?:'normal'|'ssd-experts';backendValidation?:'cpu-baseline'|'validated'|'qa-unvalidated';}
export interface InferenceProfile extends NativeMemoryProfile {index:number;}
export type RuntimeState='stopped'|'starting'|'ready'|'loading'|'stopping'|'error';
export interface RuntimeStatus {state:RuntimeState;baseUrl:string|null;version:string|null;executablePath:string|null;modelCacheDirectory:string;recommendation:ModelRecommendation;downloadingModel:string|null;error:{code:string;message:string}|null;hardware:HardwareInfo|null;profile:InferenceProfile|null;loadedModel:string|null;slowMode:boolean;memoryMode?:MemoryMode;profileSignature?:string|null;nativeMemoryPlan?:NativeMemoryPlan;portableMemoryPlan?:PortableCPUAllocationPlan;portableAdmissionDiagnostic?:PortableCPUAdmissionDiagnostic;preparationStage?:'planning'|'loading'|'probing';experimentalTrial?:ExperimentalTrial|null;executionRoute?:'normal'|'ssd-experts';ssdEngineReady?:boolean;engineIdentity?:string;trialHistory?:SSDTrialHistoryEntry[];trialHistoryError?:SSDTrialHistoryError|null;}
export interface EngineBackend {id:string;executable:string;libraryDirectory?:string;arguments?:string[];}
type SSDValidatedConfiguration=SSDNumericalConfiguration;
interface SSDManifest {integrity?:EngineBackend&{schemaVersion:number;sourceSha256:string};planner?:EngineBackend&{schemaVersion:number;sourceSha256:string};minimumMacOS?:string;validatedConfigurations?:SSDValidatedConfiguration[];schemaVersion:number;engine:string;version:string;build:number;baseCommit:string;upstreamCommits:string[];patchSha256:string;target:string;backends:EngineBackend[];files:{path:string;sha256:string;size:number}[];}
interface EngineManifest {schemaVersion:number;engine:string;version:string;commit:string;build:number;target:string;backends:EngineBackend[];planner?:EngineBackend;resourceProbe?:EngineBackend&{sourceSha256:string};files:{path:string;sha256:string;size:number}[];}
export interface RuntimeOptions {
  dataDirectory:string;resourcesDirectory?:string;ssdResourcesDirectory?:string;
  /** Trusted development/test override. Never accept a renderer supplied executable path. */
  executablePath?:string;port?:number;startupTimeoutMs?:number;requestTimeoutMs?:number;stopTimeoutMs?:number;
  totalMemoryBytes?:number;availableMemoryBytes?:number;env?:NodeJS.ProcessEnv;fetch?:typeof fetch;
  spawn?:(command:string,args:string[],options:SpawnOptions)=>ChildProcess;
  freeDiskBytes?:(directory:string)=>Promise<number|null>;
  /** Trusted test fixtures; production always uses the pinned catalog and actual hardware. */
  catalog?:readonly CuratedModel[];hardware?:HardwareInfo;skipCalibration?:boolean;
  /** Trusted native/test probes; no renderer-supplied sampling functions or deadlines. */
  resourceProbe?:(pid:number|null)=>Promise<ResourceMeasurements>;
  refreshHardware?:()=>Promise<HardwareInfo>;
  /** Trusted fake-planner fixture only; production requires the pinned bundle. */
  nativePlannerTestOutput?:(profile:InferenceProfile)=>string;
  experimentalLoadTimeoutMs?:number;experimentalCalibrationTimeoutMs?:number;resourceIntervalMs?:number;
  ssdLoadTimeoutMs?:number;ssdCalibrationTimeoutMs?:number;
  /** Trusted fake-worker fixtures only; production uses the integrity-checked bundle. */
  ssdTestEngine?:{executablePath:string;patchDigest:string;plannerPath?:string;plannerSourceDigest?:string;integrityPath?:string;integritySourceDigest?:string;/** Artificial certificate binding for fake-worker tests only. Never a native numerical claim. */fixtureParityReportDigest?:string};
  /** Isolated native acceptance only; never renderer-configurable or persisted as consent. */
  qaSSDBackend?:'cpu'|'metal';
}
interface FileFingerprint {size:number;mtimeMs:number;ctimeMs:number;ino:number;dev:number;}
interface VerificationRecord {fingerprints:FileFingerprint[];verified:VerifiedModel;metadata:GGUFMetadata[];}
const fingerprint=(s:Stats):FileFingerprint=>({size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino,dev:s.dev});
const same=(a:FileFingerprint,b:FileFingerprint)=>Object.keys(a).every(k=>a[k as keyof FileFingerprint]===b[k as keyof FileFingerprint]);
const modelArchitectureAllowsTools=(spec:CuratedModel):boolean=>/^(qwen35|qwen3next|gemma4(?:moe)?|muse-glimmer)$/.test(spec.architecture);
async function reservePort(port?:number):Promise<number>{
  if(port!==undefined&&(!Number.isInteger(port)||port<1||port>65535))throw new RuntimeError('INVALID_PORT','The local inference port is invalid.');
  return new Promise((resolve,reject)=>{const server=createServer();server.once('error',(e:NodeJS.ErrnoException)=>reject(new RuntimeError(e.code==='EADDRINUSE'?'PORT_IN_USE':'PORT_UNAVAILABLE','The app-owned inference port is unavailable.',{cause:e})));server.listen({host:'127.0.0.1',port:port??0,exclusive:true},()=>{const address=server.address();if(!address||typeof address==='string'){server.close();reject(new RuntimeError('PORT_UNAVAILABLE','Could not reserve a loopback port.'));return;}server.close(e=>e?reject(e):resolve(address.port));});});
}
/** App-owned offline inference process and pinned GGUF management; no external daemon/install. */
export class LocalInferenceRuntime extends EventEmitter {
  private settings:RuntimeOptions;private status:RuntimeStatus;private engine:EngineBackend[]=[];
  private trialHistory:SSDTrialHistory;private historyReady:Promise<void>;private historyWrites:Promise<void>=Promise.resolve();private historyCheckpointKey='';private historyCheckpointAt=0;
  private integrityModes=new Map<string,'node'|'darwin-nocache'>();private integrityWork:Promise<void>=Promise.resolve();private integrityControllers=new Set<AbortController>();
  private savedSSDTrials=new Map<string,ExperimentalTrial>();private ssdManifest:SSDManifest|null=null;private numericalConfigurations:SSDNumericalConfiguration[]=[];private ssdEngine:EngineBackend[]=[];private ssdRoot:string|null=null;private ssdStatus:SSDStreamingStatus|null=null;private ssdPartialLog='';private ssdBinding:{engineDigest:string;patchDigest:string;artifactSetDigest:string;templateDigest:string;allocationBudgetBytes:number;residentLimitBytes:number;cacheBytes:number;expectedGroups:number;minimumSlotsPerLayer:number}&SSDCPUProfileBinding|null=null;
  private manifest:EngineManifest|null=null;private child:ChildProcess|null=null;private childExit:Promise<void>|null=null;
  private startPromise:Promise<RuntimeStatus>|null=null;private stopPromise:Promise<void>|null=null;private preparePromise:Promise<PreparedModel>|null=null;private pullPromise:Promise<VerifiedModel>|null=null;
  private startController:AbortController|null=null;private loadController:AbortController|null=null;private pullController:AbortController|null=null;
  private lastLog='';private suppressExit=false;private apiKey='';private prepared:PreparedModel|null=null;private qualifiedResourceFailure:RuntimeError|null=null;
  private nativeMemoryPlan:NativeMemoryPlan|null=null;
  private verification=new Map<string,VerificationRecord>();private measurements=new Map<string,number>();private profileIndex=0;
  private stoppedTrials=new Set<string>();private stoppedQualifiedChildren=new WeakSet<ChildProcess>();private ssdSpawnedAt=0;private chatProbeResults=new Map<string,boolean>();private modelFailures=new Map<string,string>();private modelProbes=new Map<string,{chat:ModelProbeEvidence;tool:ModelProbeEvidence}>();
  private imports=new Map<string,CuratedModel>();private importsLoaded=false;private toolsPassed=new Map<string,boolean>();
  private calibrationPromise:Promise<PreparedModel>|null=null;private calibrationController:AbortController|null=null;
  private settingsPromise:Promise<void>|null=null;
  private hardwareRefreshPromise:Promise<HardwareInfo>|null=null;
  private portableMemoryPlan:PortableCPUAllocationPlan|null=null;
  private trialPromise:Promise<PreparedModel>|null=null;private trialController:AbortController|null=null;
  private resourceTimer:ReturnType<typeof setInterval>|null=null;private resourceBusy=false;private lowMemorySamples=0;
  private memoryLog:EngineMemoryLog|null=null;private trialFailure:RuntimeError|null=null;
  private executionRequestTimeoutMs=3600000;private remainingExecutionMs:(()=>number)|undefined;
  constructor(settings:RuntimeOptions){super();if(!path.isAbsolute(settings.dataDirectory))throw new RuntimeError('INVALID_DATA_DIRECTORY','Use an absolute app-owned runtime directory.');this.settings=settings;
    this.status={state:'stopped',baseUrl:null,version:null,executablePath:null,modelCacheDirectory:path.join(settings.dataDirectory,'models'),recommendation:recommendModel(settings.totalMemoryBytes),downloadingModel:null,error:null,hardware:null,profile:null,loadedModel:null,slowMode:false,memoryMode:'automatic',profileSignature:null,experimentalTrial:null,executionRoute:'normal',ssdEngineReady:false,trialHistory:[],trialHistoryError:null};
    this.trialHistory=new SSDTrialHistory(settings.dataDirectory);this.historyReady=this.trialHistory.load().then(()=>this.publishTrialHistory());}
  getStatus():RuntimeStatus{return structuredClone(this.status);}
  /** Refresh estimates without loading weights or changing the selected model. */
  async refreshHardware(options:{signal?:AbortSignal}={}):Promise<HardwareInfo>{
    this.assertIdle();throwIfAborted(options.signal);
    if(this.hardwareRefreshPromise){const hardware=await this.hardwareRefreshPromise;throwIfAborted(options.signal);return structuredClone(hardware);}
    this.hardwareRefreshPromise=(async()=>{await this.loadImports();const hardware=await this.measureCurrentHardware(options.signal,false);throwIfAborted(options.signal);this.update({hardware,recommendation:this.hardwareRecommendation(hardware)});return hardware;})().finally(()=>{this.hardwareRefreshPromise=null;});
    return structuredClone(await this.hardwareRefreshPromise);
  }
  private async measureCurrentHardware(signal?:AbortSignal,requireMetal=true):Promise<HardwareInfo>{
    const hardware=this.settings.refreshHardware?await this.settings.refreshHardware():this.settings.hardware?structuredClone(this.settings.hardware):await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});
    throwIfAborted(signal);if(this.settings.hardware&&this.settings.refreshHardware&&!hardware.gpus.length)hardware.gpus=structuredClone(this.status.hardware?.gpus??this.settings.hardware.gpus);
    if(!this.settings.hardware){const metal=this.engine.find(b=>b.id==='metal');if(metal){try{const devices=await this.execute(this.binary(metal),['--list-devices'],signal,metal,5000);hardware.gpus=parseDevices(devices,'metal',hardware.platform);if(!hardware.gpus.length&&requireMetal)throw new RuntimeError('MODEL_BACKEND_UNSUPPORTED','The current Metal memory budget could not be confirmed. No CPU profile substitutes for a qualified coding model.');}catch(error){if(signal?.aborted||requireMetal)throw error;hardware.gpus=[];}}}
    return hardware;
  }
  async setMemoryMode(mode:MemoryMode):Promise<void>{
    if(!['automatic','low-memory','experimental-disk','ssd-experts'].includes(mode))throw new RuntimeError('INVALID_MEMORY_MODE','Choose an available memory profile.');
    this.assertIdle();if(this.status.memoryMode===mode)return;
    this.settingsPromise=(async()=>{await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;this.profileIndex=0;this.invalidateTrial();this.update({memoryMode:mode,executionRoute:mode==='ssd-experts'?'ssd-experts':'normal',loadedModel:null,profile:null,state:this.engine.length?'ready':'stopped',error:null});})().finally(()=>{this.settingsPromise=null;});
    await this.settingsPromise;
  }
  setExecutionRequestTimeout(timeoutMs:number,remainingMs?:()=>number):void{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>28800000)throw new RuntimeError('INVALID_REQUEST_DEADLINE','Inference requests require a deadline between one second and eight hours.');
    this.executionRequestTimeoutMs=timeoutMs;this.remainingExecutionMs=remainingMs;
  }
  private invalidateTrial():void{
    this.trialController?.abort();this.trialController=null;this.stopResourceWatchdog();
    if(this.status.experimentalTrial&&['loading','calibrating','passed'].includes(this.status.experimentalTrial.state))this.updateTrial({state:'stopped',probePassed:false,toolProbePassed:false,finishedAt:new Date().toISOString()});
  }
  private publishTrialHistory():void{this.update({trialHistory:this.trialHistory.snapshot(),trialHistoryError:this.trialHistory.error?{...this.trialHistory.error}:null});}
  private checkpointTrialHistory():void{
    const trial=this.status.experimentalTrial;if(trial?.mode!=='ssd-experts')return;
    const key=JSON.stringify({id:trial.id,state:trial.state,profile:trial.profileSignature,artifact:trial.artifactSetDigest,template:trial.templateDigest,engine:trial.engineDigest,patch:trial.patchDigest,budget:trial.resourceBudgetBytes,allocation:trial.allocationBudgetBytes,stage:trial.progress?.stage,probes:trial.probes,error:trial.error});
    // Preserve stage/binding/result changes immediately. Progress-only writes
    // are bounded while preparation runs; idle status samples do not rewrite history.
    if(key===this.historyCheckpointKey&&(!['loading','calibrating'].includes(trial.state)||Date.now()-this.historyCheckpointAt<15000))return;
    this.historyCheckpointKey=key;this.historyCheckpointAt=Date.now();const snapshot=structuredClone(trial);
    this.historyWrites=this.historyWrites.then(()=>this.historyReady).then(()=>this.trialHistory.record(snapshot)).then(()=>this.publishTrialHistory()).catch(()=>{});
  }
  private updateTrial(changes:Partial<ExperimentalTrial>):void{if(this.status.experimentalTrial)this.update({experimentalTrial:{...this.status.experimentalTrial,...changes}});}
  private syncExperimentalToolProbe(prepared:PreparedModel,passed:boolean):void{
    const trial=this.status.experimentalTrial,signature=this.status.profileSignature;
    if(['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic')&&this.child&&trial?.state==='passed'&&trial.probePassed&&trial.model===prepared.sourceModel&&trial.digest===prepared.digest&&signature&&trial.profileSignature===signature&&prepared.profileSignature===signature)this.updateTrial({toolProbePassed:passed});
  }
  private notifyExecutionStopped(code:string,message:string):void{
    const trial=this.status.experimentalTrial;if(trial?.mode!=='ssd-experts'||this.stoppedTrials.has(trial.id))return;this.stoppedTrials.add(trial.id);
    // Only app-owned lifecycle/guard observations emit this boundary. Never
    // derive an approval cancellation event from model text or tool output.
    this.emit('executionStopped',{model:trial.model,code,message,trialId:trial.id} satisfies ExecutionStoppedEvent);
  }
  private stopResourceWatchdog():void{if(this.resourceTimer)clearInterval(this.resourceTimer);this.resourceTimer=null;this.lowMemorySamples=0;}
  private async resourceSample(pid:number|null):Promise<ResourceMeasurements>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const measured=(async()=>{const base=await (this.settings.resourceProbe??(ownedPid=>probeResourceMeasurements(ownedPid)))(pid);if(pid!==null&&(this.nativeMemoryPlan||this.portableMemoryPlan)&&this.manifest?.resourceProbe&&!this.settings.resourceProbe)return {...base,...await this.nativeProcessSample(pid)};return base;})();
      const sample=await Promise.race([measured,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The required current memory measurements timed out.')),2000);})]);
      if(!validResourceMeasurements(sample)||Math.abs(Date.now()-Date.parse(sample.sampledAt))>10000)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Current resident-memory, available-memory, and pressure measurements are required.');
      return sample;
    }finally{if(timer)clearTimeout(timer);}
  }
  private async checkQualifiedResources(child:ChildProcess):Promise<ResourceMeasurements>{
    if(!child.pid||this.child!==child)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The qualified model has no measurable owned process.');
    if(this.portableMemoryPlan){await this.assertNativeModelUnchanged(this.portableMemoryPlan);const sample=await this.resourceSample(child.pid);if(this.child!==child)throw abortError();assertPortableCPURuntime(this.portableMemoryPlan,this.status.hardware!,sample);return sample;}
    if(this.nativeMemoryPlan)await this.assertNativeModelUnchanged(this.nativeMemoryPlan);const sample=await this.resourceSample(child.pid),hardware=this.status.hardware!;if(this.child!==child)throw abortError();
    const planned=this.nativeMemoryPlan;
    if(planned){if(sample.physicalFootprintBytes===undefined||!Number.isSafeInteger(sample.physicalFootprintBytes)||sample.physicalFootprintBytes!<=0)throw this.qualifiedResourceDiagnostic(sample,hardware,planned,['physical-footprint-unavailable'],'RESOURCE_MONITOR_UNAVAILABLE');const guards:string[]=[];if(sample.pressure!=='normal')guards.push('normal-pressure');if(sample.availableMemoryBytes<GIB)guards.push('available-headroom');if(Math.max(sample.residentBytes,sample.physicalFootprintBytes!)>Math.min(planned.workingBytes,hardware.totalMemoryBytes-operatingSystemReserve(hardware.totalMemoryBytes)))guards.push('owned-residency');if(guards.length)throw this.qualifiedResourceDiagnostic(sample,hardware,planned,guards);}
    else{const guards:string[]=[];if(sample.pressure==='critical')guards.push('critical-pressure');if(sample.availableMemoryBytes<512*1024**2)guards.push('available-headroom');if(sample.residentBytes>hardware.totalMemoryBytes-operatingSystemReserve(hardware.totalMemoryBytes))guards.push('owned-residency');if(guards.length)throw this.qualifiedResourceDiagnostic(sample,hardware,null,guards);}
    return sample;
  }
  /** Failure-only bounded metrics: no paths, prompts, raw logs or user content. */
  private qualifiedResourceDiagnostic(sample:ResourceMeasurements,hardware:HardwareInfo,plan:NativeMemoryPlan|null,guards:string[],code='MODEL_MEMORY_CALIBRATION_FAILED'):RuntimeError{
    const systemCapacityBytes=hardware.totalMemoryBytes-operatingSystemReserve(hardware.totalMemoryBytes),residentLimitBytes=plan?Math.min(plan.workingBytes,systemCapacityBytes):systemCapacityBytes;
    const physicalFootprintBytes=Number.isSafeInteger(sample.physicalFootprintBytes)&&sample.physicalFootprintBytes!>0?sample.physicalFootprintBytes!:null;
    const diagnostic={code,guards,sampledAt:new Date(sample.sampledAt).toISOString(),pressure:sample.pressure,availableMemoryBytes:sample.availableMemoryBytes,
      minimumAvailableBytes:plan?GIB:512*1024**2,rssBytes:sample.rssBytes??sample.residentBytes,physicalFootprintBytes,residentBytes:sample.residentBytes,
      residentLimitBytes,systemCapacityBytes,planWorkingBytes:plan?.workingBytes??null,planGpuAllocationBytes:plan?.gpuAllocationUpperBoundBytes??null,
      model:plan?.model??this.status.loadedModel,contextTokens:this.status.profile?.contextTokens??null,cacheTypeK:this.status.profile?.cacheTypeK??null,cacheTypeV:this.status.profile?.cacheTypeV??null};
    this.emit('log',`CODING_RESOURCE_FAILURE ${JSON.stringify(diagnostic)}\n`);
    const gib=(bytes:number|null)=>bytes===null?'unavailable':`${(bytes/GIB).toFixed(3)} GiB`;
    return new RuntimeError(code,`The coding profile stopped at ${diagnostic.sampledAt}: guards=${guards.join(',')}; pressure=${sample.pressure}; available=${gib(sample.availableMemoryBytes)} (minimum ${gib(diagnostic.minimumAvailableBytes)}); RSS=${gib(diagnostic.rssBytes)}; physical footprint=${gib(physicalFootprintBytes)}; resident bound=${gib(residentLimitBytes)}; plan working=${gib(diagnostic.planWorkingBytes)}; system capacity=${gib(systemCapacityBytes)}. Completed actions are preserved.`);
  }
  private async stopQualifiedExecution(child:ChildProcess,model:string,error:unknown):Promise<void>{
    if(this.child!==child||this.stoppedQualifiedChildren.has(child))return;this.stoppedQualifiedChildren.add(child);const profileSignature=this.status.profileSignature,portablePlan=this.portableMemoryPlan,profile=JSON.stringify(this.status.profile);
    const failure=error instanceof RuntimeError?error:new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The qualified model memory monitor became unavailable.',{cause:error});
    this.qualifiedResourceFailure=failure;this.stopResourceWatchdog();this.emit('executionStopped',{model,code:failure.code,message:failure.message} satisfies ExecutionStoppedEvent);
    await this.terminateChild();
    // An old sample or shutdown must not clear a later explicit profile/process.
    const ownPortableTeardown=portablePlan&&!this.portableMemoryPlan&&this.status.profileSignature===portablePlan.profileSignature&&this.status.loadedModel===model&&JSON.stringify(this.status.profile)===profile;
    if(this.child&&this.child!==child||this.status.profileSignature!==profileSignature&&!ownPortableTeardown||['stopping','stopped'].includes(this.status.state))return;
    this.prepared=null;this.update({state:'ready',loadedModel:null,profile:null,engineIdentity:undefined,error:{code:failure.code,message:failure.message}});
  }
  private startQualifiedResourceWatchdog(child:ChildProcess,model:string):void{
    this.stopResourceWatchdog();this.resourceTimer=setInterval(()=>{void (async()=>{if(this.resourceBusy||this.child!==child)return;this.resourceBusy=true;try{const sample=await this.checkQualifiedResources(child);if(this.child===child&&this.prepared?.sourceModel===model)this.prepared={...this.prepared,calibrationMeasurements:sample};}
      catch(error){await this.stopQualifiedExecution(child,model,error);}
      finally{this.resourceBusy=false;}})();},this.settings.resourceIntervalMs??(this.nativeMemoryPlan&&this.status.state==='loading'?250:2000));this.resourceTimer.unref();
  }
  /** Uses actual worker telemetry. Never substitutes the host's RSS for native RSS. */
  private qwen80SSDWorkerSample(spec:CuratedModel,sample:ResourceMeasurements):ResourceMeasurements{
    if(!exactQwen80Source(spec))return sample;
    assertQwen80SSDMemory(spec,sample);
    const native=this.ssdStatus,trial=this.status.experimentalTrial,hardware=this.status.hardware;
    if(!native||!hardware||!trial||trial.mode!=='ssd-experts'||this.status.memoryMode!=='ssd-experts'||trial.model!==spec.id||
      !Number.isSafeInteger(native.pid)||native.pid!<=0||native.pid!==this.child?.pid||!Number.isSafeInteger(native.rssBytes)||!Number.isSafeInteger(native.physicalFootprintBytes)||
      !Number.isFinite(Date.parse(native.sampledAt))||Math.abs(Date.now()-Date.parse(native.sampledAt))>10000)
      throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Qwen80 SSD requires current app-owned native process measurements and its measured resource plan.');
    if(['calibrating','passed'].includes(trial.state)){
      if(!this.ssdBinding)throw new RuntimeError('SSD_ALLOCATION_BUDGET','The current Qwen80 SSD resource binding is unavailable.');
      validateSSDStreamingStatus(native,this.ssdBinding);
    }
    const measured={...sample,rssBytes:native.rssBytes,physicalFootprintBytes:native.physicalFootprintBytes,
      residentBytes:Math.max(native.rssBytes,native.physicalFootprintBytes)};
    assertQwen80SSDMemory(spec,measured,{hardware,residentLimitBytes:trial.resourceBudgetBytes??0,
      allocationBudgetBytes:trial.allocationBudgetBytes??0,plan:trial.memoryPlan});
    return measured;
  }
  private async checkQwen80SSDRequestResources(child:ChildProcess,trialId:string,spec:CuratedModel):Promise<void>{
    try{
      if(!child.pid||this.child!==child||this.status.experimentalTrial?.id!==trialId)throw abortError();
      const sample=await this.resourceSample(child.pid);
      if(this.child!==child||this.status.experimentalTrial?.id!==trialId)throw abortError();
      const measured=this.qwen80SSDWorkerSample(spec,sample);this.updateTrial({measurements:measured});
      if(this.child!==child||this.status.experimentalTrial?.id!==trialId)throw abortError();
    }catch(error){await this.stopQwen80SSDResources(child,trialId,error);throw error;}
  }
  /** A stale sample or synchronous cancellation handler cannot stop a replacement. */
  private async stopQwen80SSDResources(child:ChildProcess,trialId:string,error:unknown):Promise<void>{
    if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;
    const failure=error instanceof RuntimeError?error:new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Qwen80 SSD stopped because reliable memory monitoring became unavailable.',{cause:error});
    this.trialFailure=failure;this.notifyExecutionStopped(failure.code,failure.message);
    if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;
    this.updateTrial({state:'failed',probePassed:false,toolProbePassed:false,error:{code:failure.code,message:failure.message},finishedAt:new Date().toISOString()});
    if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;
    this.trialController?.abort();
    if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;
    await this.terminateChild();
    if(this.child&&this.child!==child||this.status.experimentalTrial?.id!==trialId)return;
    this.prepared=null;this.update({state:'ready',loadedModel:null,profile:null,engineIdentity:undefined,error:{code:failure.code,message:failure.message}});
  }
  private async watchResources(child:ChildProcess):Promise<void>{
    if(this.resourceBusy||this.child!==child||!this.status.experimentalTrial)return;const trialId=this.status.experimentalTrial.id,qwenSSD=this.status.memoryMode==='ssd-experts'&&exactQwen80Source(this.spec(this.status.experimentalTrial.model));this.resourceBusy=true;
    try{
      if(!child.pid)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The app-owned model process has no measurable process identity.');
      let sample=await this.resourceSample(child.pid);if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;if(this.status.memoryMode==='ssd-experts'){const currentSpec=this.spec(this.status.experimentalTrial.model);if(exactQwen80Source(currentSpec))assertQwen80SSDMemory(currentSpec,sample);const model=this.status.experimentalTrial.model,record=this.verification.get(model);if(!record)throw new RuntimeError('MODEL_CHANGED','The SSD model verification record is unavailable.');const artifacts=modelArtifacts(this.spec(model));for(let i=0;i<artifacts.length;i++){const current=await lstat(path.join(this.status.modelCacheDirectory,artifacts[i].filename));if(!current.isFile()||current.isSymbolicLink()||!same(record.fingerprints[i],fingerprint(current)))throw new RuntimeError('MODEL_CHANGED','An SSD model shard changed after verification. The active trial was stopped.');}const native=this.ssdStatus;if(!native&&Date.now()-this.ssdSpawnedAt<2000)return;if(!native||!Number.isSafeInteger(native.physicalFootprintBytes)||native.physicalFootprintBytes<0||!Number.isSafeInteger(native.rssBytes)||native.rssBytes<0||!Number.isFinite(Date.parse(native.sampledAt))||Math.abs(Date.now()-Date.parse(native.sampledAt))>10000)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The SSD worker physical-footprint sampler is missing or stale.');if(this.ssdBinding&&['calibrating','passed'].includes(this.status.experimentalTrial?.state??''))validateSSDStreamingStatus(native,this.ssdBinding);sample={...sample,physicalFootprintBytes:native.physicalFootprintBytes,rssBytes:native.rssBytes,residentBytes:Math.max(native.physicalFootprintBytes,native.rssBytes)};if(exactQwen80Source(currentSpec))sample=this.qwen80SSDWorkerSample(currentSpec,sample);}if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;this.updateTrial({measurements:sample});if(qwenSSD&&(this.child!==child||this.status.experimentalTrial?.id!==trialId))return;
      const budget=this.status.experimentalTrial?.resourceBudgetBytes??0;
      this.lowMemorySamples=sample.availableMemoryBytes<512*1024**2?this.lowMemorySamples+1:0;
      const failure=sample.residentBytes>=budget?new RuntimeError('EXPERIMENTAL_RESIDENT_LIMIT','Experimental disk mode stopped because the model reached its sampled resident-memory budget.'):
        sample.pressure==='critical'?new RuntimeError('EXPERIMENTAL_MEMORY_PRESSURE','Experimental disk mode stopped because macOS reported critical memory pressure.'):
        this.lowMemorySamples>=2?new RuntimeError('EXPERIMENTAL_AVAILABLE_MEMORY','Experimental disk mode stopped after sustained available memory below 512 MiB.'):null;
      if(failure)throw failure;
    }catch(error){
      if(this.child!==child||this.status.experimentalTrial?.id!==trialId)return;if(this.status.memoryMode==='ssd-experts'&&exactQwen80Source(this.spec(this.status.experimentalTrial.model))){await this.stopQwen80SSDResources(child,trialId,error);return;}const failure=error instanceof RuntimeError?error:new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Experimental disk mode stopped because reliable memory monitoring became unavailable.',{cause:error});
      this.trialFailure=failure;this.notifyExecutionStopped(failure.code,failure.message);this.updateTrial({state:'failed',probePassed:false,toolProbePassed:false,error:{code:failure.code,message:failure.message},finishedAt:new Date().toISOString()});
      this.trialController?.abort();await this.terminateChild();if(this.status.experimentalTrial?.id!==trialId)return;this.prepared=null;this.update({state:'ready',loadedModel:null,profile:null,engineIdentity:undefined,error:{code:failure.code,message:failure.message}});
    }finally{this.resourceBusy=false;}
  }
  private captureSSDStatus(text:string,stillOwned?:()=>boolean):void{
    if(stillOwned&&!stillOwned())return;
    const lines=(this.ssdPartialLog+text).split('\n');this.ssdPartialLog=(lines.pop()??'').slice(-65536);
    for(const line of lines){if(stillOwned&&!stillOwned())return;if(!line.startsWith('SSD_STATUS '))continue;try{const status=JSON.parse(line.slice(11)) as SSDStreamingStatus;if(status.baseCommit===ENGINE_COMMIT&&status.patchSha256===this.ssdManifest?.patchSha256){this.ssdStatus=status;this.updateTrial({streaming:status});}}catch{}}
  }
  private captureOwnedQwen80SSDStatus(child:ChildProcess,trialId:string|undefined,text:string):boolean{
    const owned=()=>Boolean(trialId&&this.child===child&&this.status.experimentalTrial?.id===trialId);
    if(!owned())return false;this.captureSSDStatus(text,owned);return owned();
  }
  private startResourceWatchdog(child:ChildProcess):void{
    this.stopResourceWatchdog();this.resourceTimer=setInterval(()=>{void this.watchResources(child);},this.settings.resourceIntervalMs??2000);this.resourceTimer.unref();
  }
  async startExperimentalTrial(model:string,options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    if(usesQualifiedProfiles(model))throw new RuntimeError('MODEL_MEMORY_MODE_UNSUPPORTED','These coding models require their calibrated 32K or 16K Metal profile. Experimental disk loading cannot substitute a 4K CPU profile.');
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController&&this.status.downloadingModel===model)throw new RuntimeError('DOWNLOAD_BUSY','Wait for this model download to finish.');
    this.stopResourceWatchdog();this.trialController?.abort();
    const controller=new AbortController();this.trialController=controller;this.trialFailure=null;
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    this.update({memoryMode:'experimental-disk',experimentalTrial:{id:randomUUID(),model,digest:null,state:'loading',startedAt:new Date().toISOString(),profileSignature:EXPERIMENTAL_PROFILE_SIGNATURE,probePassed:false,toolProbePassed:false,error:null,resourceBudgetBytes:null,mappedBytes:null,lazyEligibleBytes:null,measurements:null}});
    this.trialPromise=this.experimentalTrialInternal(model,signal).catch(async error=>{
      await this.terminateChild();this.prepared=null;
      const failure=this.trialFailure??(error instanceof RuntimeError?error:new RuntimeError(signal.aborted?'EXPERIMENTAL_CANCELLED':'EXPERIMENTAL_TRIAL_FAILED',signal.aborted?'Experimental disk mode was cancelled.':error instanceof Error?error.message:'The experimental model trial failed.',{cause:error}));
      const cancelled=signal.aborted&&!this.trialFailure;
      this.updateTrial({state:cancelled?'cancelled':'failed',probePassed:false,toolProbePassed:false,error:cancelled?null:{code:failure.code,message:failure.message},finishedAt:new Date().toISOString()});
      this.update({state:this.engine.length?'ready':cancelled?'stopped':'error',loadedModel:null,profile:null,error:cancelled?null:{code:failure.code,message:failure.message}});
      throw cancelled?abortError():failure;
    }).finally(()=>{this.trialPromise=null;if(this.status.experimentalTrial?.state!=='passed')this.trialController=null;});
    return this.trialPromise;
  }
  async cancelExperimentalTrial(expectedTrialId?:string):Promise<void>{
    if(expectedTrialId!==undefined&&(this.status.experimentalTrial?.id!==expectedTrialId||!['loading','calibrating'].includes(this.status.experimentalTrial?.state??'')))return;
    if(!['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic')||!this.status.experimentalTrial)return;
    if(this.status.memoryMode==='ssd-experts')this.notifyExecutionStopped('SSD_CANCELLED','The SSD model trial was cancelled.');this.trialController?.abort();this.stopResourceWatchdog();await this.terminateChild();await this.trialPromise?.catch(()=>{});this.prepared=null;this.trialController=null;
    this.updateTrial({state:'cancelled',probePassed:false,toolProbePassed:false,error:null,finishedAt:new Date().toISOString()});
    this.update({state:this.engine.length?'ready':'stopped',loadedModel:null,profile:null,error:null});await this.historyWrites;
  }
  private async experimentalTrialInternal(model:string,signal:AbortSignal):Promise<PreparedModel>{
    if(!this.engine.length)await this.start({signal});const spec=this.spec(model);
    const hardware=this.status.hardware!;
    if(hardware.platform!=='darwin'||hardware.architecture!=='arm64')throw new RuntimeError('EXPERIMENTAL_PLATFORM_UNSUPPORTED','Experimental disk mode is currently available only on macOS Apple Silicon.');
    const verified=await this.inspectModel(model,{signal});this.updateTrial({digest:verified.digest});throwIfAborted(signal);
    await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;throwIfAborted(signal);
    const fresh=this.settings.refreshHardware?await this.settings.refreshHardware():this.settings.hardware?structuredClone(this.settings.hardware):await probeHardware(this.settings.dataDirectory,{freeDiskBytes:d=>this.disk(d)});
    // RAM/disk refresh does not discover devices. Keep the separately verified
    // accelerator descriptors so returning to Automatic can use Metal/Vulkan.
    fresh.gpus=structuredClone(hardware.gpus);
    const initial=await this.resourceSample(null);throwIfAborted(signal);fresh.availableMemoryBytes=Math.min(fresh.totalMemoryBytes,initial.availableMemoryBytes);
    this.update({hardware:fresh,recommendation:this.hardwareRecommendation(fresh)});
    const budget=experimentalResidentBudget(fresh),fit=classifyModel(spec,fresh);
    const workspace=Math.max(512*1024**2,Math.ceil(fit.memoryEstimate.contextBytes/2))+fit.memoryEstimate.scratchBytes;
    this.updateTrial({resourceBudgetBytes:budget,measurements:initial});
    if(initial.pressure==='critical'||budget<workspace)throw new RuntimeError('EXPERIMENTAL_WORKSPACE_INSUFFICIENT','There is not enough current context and scratch headroom for a bounded experimental trial. Close applications or choose a smaller model.');
    const profile:InferenceProfile={contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32,backend:'cpu',index:2};
    this.update({state:'loading',profile,loadedModel:null,error:null});
    const prepared=await this.loadModel(spec,verified,profile,signal,true);throwIfAborted(signal);
    if(this.trialFailure)throw this.trialFailure;const owned=this.child;if(!owned)throw new RuntimeError('EXPERIMENTAL_TRIAL_FAILED','The experimental model stopped before its probe completed.');
    await this.watchResources(owned);throwIfAborted(signal);if(this.child!==owned)throw this.trialFailure??new RuntimeError('EXPERIMENTAL_TRIAL_FAILED','The experimental model stopped during resource validation.');
    this.prepared={...prepared,memoryMode:'experimental-disk',probePassed:true};
    this.updateTrial({state:'passed',profileSignature:this.prepared.profileSignature!,probePassed:true,toolProbePassed:prepared.toolCapable,finishedAt:new Date().toISOString(),...this.memoryLog?.values(true)});
    this.update({state:'ready',loadedModel:model,error:null});return {...this.prepared};
  }
  async setSlowMode(enabled:boolean):Promise<void> {this.assertIdle();if(this.status.slowMode===Boolean(enabled))return;
    this.settingsPromise=Promise.resolve().then(async()=>{if(this.child){await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;this.invalidateTrial();}if(this.stopPromise||this.status.state==='stopping')throw new RuntimeError('MODEL_BUSY','The runtime is stopping.');this.update({slowMode:Boolean(enabled),loadedModel:null,profile:null,state:this.engine.length?'ready':'stopped'});if(this.status.hardware)this.update({recommendation:this.hardwareRecommendation(this.status.hardware)});}).finally(()=>{this.settingsPromise=null;});return this.settingsPromise;
  }
  private assertIdle():void {if(this.stopPromise||this.status.state==='stopping')throw new RuntimeError('MODEL_BUSY','The runtime is stopping.');if(this.preparePromise||this.calibrationPromise||this.settingsPromise||this.trialPromise)throw new RuntimeError('MODEL_BUSY','Wait for model loading, calibration, experimental trial or settings to finish.');}
  private update(changes:Partial<RuntimeStatus>):void{const status={...this.status,...changes};status.profileSignature=status.profile?(status.memoryMode==='ssd-experts'&&this.ssdBinding?ssdProfileSignature(status.profile,this.ssdBinding):inferenceProfileSignature(status.profile,status.memoryMode??'automatic')):null;const plan=this.nativeMemoryPlan;if(plan&&status.profileSignature===plan.profileSignature){status.nativeMemoryPlan=plan;status.profileSignature=JSON.stringify({...JSON.parse(status.profileSignature),memoryPlanDigest:createHash('sha256').update(JSON.stringify(plan)).digest('hex')});}else status.nativeMemoryPlan=undefined;const portable=this.portableMemoryPlan;if(portable&&status.profileSignature===portable.profileSignature){status.portableMemoryPlan=portable;status.profileSignature=JSON.stringify({...JSON.parse(status.profileSignature),portableMemoryPlanDigest:createHash('sha256').update(JSON.stringify(portable)).digest('hex')});}else status.portableMemoryPlan=undefined;if(status.state!=='loading')status.preparationStage=undefined;this.status=status;if(changes.experimentalTrial)this.checkpointTrialHistory();this.emit('status',this.getStatus());}
  private catalog():readonly CuratedModel[]{return [...(this.settings.catalog??MODEL_CATALOG),...this.imports.values()];}
  private hardwareRecommendation(hardware:HardwareInfo):ModelRecommendation {
    const rows=this.catalog().map(spec=>({spec,fit:modelFit(spec,hardware,this.nativePlanningAvailable()).fit}));const eligible=rows.filter(r=>r.fit==='recommended'||(this.status.slowMode||this.status.memoryMode==='low-memory'||isPortableModel(r.spec,hardware))&&r.fit==='slow');
    const preferred=hardware.totalMemoryBytes>=24*GIB?'gemma4:12b':'qwen3.5:4b';
    const priority=['qwen3.8:27b','muse-glimmer:30b','qwen3.8:27b-q3-k-m','muse-glimmer:30b-q3-k-m',preferred,'qwen3.5:9b','qwen3.5:4b'];
    const rank=(id:string)=>{const index=priority.indexOf(id);return index<0?priority.length:index;};
    eligible.sort((a,b)=>(a.fit==='recommended'?0:1)-(b.fit==='recommended'?0:1)||rank(a.spec.id)-rank(b.spec.id));
    const chosen=eligible[0],qualified=chosen&&usesQualifiedProfiles(chosen.spec.id);
    const context=chosen&&isPortableModel(chosen.spec,hardware)?4096:qualified?(this.nativePlanningAvailable()&&hardware.totalMemoryBytes<=24*GIB||chosen.spec.id.includes('q3-k-m')?16384:classifyModel(chosen.spec,hardware,32768).workingMemoryGB*GIB+512*1024**2<=hardware.availableMemoryBytes?32768:16384):8192;
    return {...recommendModel(hardware.totalMemoryBytes),supported:rows.some(r=>r.fit!=='insufficient'),suggestedModel:chosen?.spec.id??null,feasibleModels:eligible.map(r=>r.spec.id),contextTokens:context,reason:chosen?isPortableModel(chosen.spec,hardware)?'CPU 4K memory fit is estimated. Native allocation and live memory checks are required; coding quality on this hardware remains unverified.':null:rows.some(r=>r.fit==='slow')?'Enable Slow mode for CPU or partial GPU inference, or free memory to use an accelerated model.':'No catalog or imported model fits the current safe memory budget. Close applications or choose a smaller GGUF. Recommendations are estimates; preparation and task checks remain required.'};
  }
  private spec(model:string):CuratedModel{const spec=this.catalog().find(s=>s.id===model);if(!spec)throw new RuntimeError('MODEL_NOT_ALLOWED','Select a curated local model.');return spec;}
  private async loadImports():Promise<void>{
    if(this.importsLoaded)return;this.importsLoaded=true;
    let records:unknown;try{records=JSON.parse(await readFile(path.join(this.settings.dataDirectory,'imports.json'),'utf8'));}catch{return;}
    if(!Array.isArray(records)||records.length>100)return;
    for(const raw of records){if(!raw||typeof raw!=='object')continue;const s=raw as CuratedModel;
      if(!/^import:[a-f0-9]{64}$/.test(s.id)||!/^import-[a-f0-9]{64}\.gguf$/.test(s.filename)||s.id!==`import:${s.sha256}`||s.filename!==`import-${s.sha256}.gguf`||!Number.isSafeInteger(s.estimatedDownloadBytes)||s.estimatedDownloadBytes<24||s.estimatedDownloadBytes>128*GIB||!Number.isFinite(s.workingMemoryGB)||s.workingMemoryGB<s.estimatedDownloadBytes/GIB||typeof s.architecture!=='string'||s.architecture.length>100||typeof s.title!=='string'||s.title.length>500)continue;
      this.imports.set(s.id,{...s,repository:'',revision:'',sourceUrl:'',license:'Imported file: verify its publisher license',toolCapable:false,ssd:undefined,artifacts:undefined});
    }
  }
  private async saveImports():Promise<void>{const target=path.join(this.settings.dataDirectory,'imports.json'),temp=`${target}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify([...this.imports.values()]),{mode:0o600,flag:'wx'});await rename(temp,target);}finally{await rm(temp,{force:true});}}
  private async disk(directory:string):Promise<number|null>{if(this.settings.freeDiskBytes)return this.settings.freeDiskBytes(directory);try{const s=await statfs(directory);return Number(s.bavail)*Number(s.bsize);}catch{return null;}}
  private childEnvironment(backend?:EngineBackend,resourceRoot=this.settings.resourcesDirectory):NodeJS.ProcessEnv {
    const input=this.settings.env??process.env;const env:NodeJS.ProcessEnv={};
    for(const name of ['PATH','Path','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','LOCALAPPDATA','APPDATA'])if(input[name]!==undefined)env[name]=input[name];
    if(backend?.libraryDirectory&&resourceRoot){const directory=path.resolve(resourceRoot,backend.libraryDirectory);if(process.platform==='win32')env.PATH=`${directory};${env.PATH??env.Path??''}`;else env[process.platform==='darwin'?'DYLD_LIBRARY_PATH':'LD_LIBRARY_PATH']=directory;}
    return env;
  }
  private execute(command:string,args:string[],signal?:AbortSignal,backend?:EngineBackend,timeoutMs=15000,resourceRoot=this.settings.resourcesDirectory,onOutput?:(text:string)=>void):Promise<string>{return new Promise((resolve,reject)=>{
    throwIfAborted(signal);const child=(this.settings.spawn??spawn)(command,args,{env:this.childEnvironment(backend,resourceRoot),stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});let output='',done=false;
    const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(output);};
    const cancel=()=>{child.kill('SIGKILL');finish(abortError());};const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new RuntimeError('ENGINE_PROBE_TIMEOUT','The bundled engine probe timed out.'));},timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});for(const stream of [child.stdout,child.stderr])stream?.on('data',(b:Buffer)=>{const text=b.toString();output=(output+text).slice(-128*1024);onOutput?.(text);});child.once('error',finish);child.once('close',code=>finish(code===0?undefined:new RuntimeError('ENGINE_PROBE_FAILED',output.slice(-2000)||`Engine exited ${code}.`)));if(signal?.aborted)cancel();
  });}
  start(options:{signal?:AbortSignal}={}):Promise<RuntimeStatus>{
    if(this.status.state==='ready'||this.status.state==='loading')return Promise.resolve(this.getStatus());if(this.startPromise)return this.startPromise;if(this.stopPromise)return this.stopPromise.then(()=>this.start(options));
    const controller=new AbortController();this.startController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    this.startPromise=this.startInternal(signal).finally(()=>{this.startPromise=null;this.startController=null;});return this.startPromise;
  }
  private async startInternal(signal:AbortSignal):Promise<RuntimeStatus>{this.update({state:'starting',error:null});try{
    await this.historyReady;throwIfAborted(signal);
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
    await this.readSSDManifest(signal);throwIfAborted(signal);this.update({state:'ready',version:ENGINE_VERSION,executablePath:this.binary(backend),hardware,recommendation,error:null});return this.getStatus();
  }catch(error){if(signal.aborted){this.update({state:'stopped',error:null});throw abortError();}const failure=error instanceof RuntimeError?error:new RuntimeError('ENGINE_NOT_AVAILABLE','The bundled inference engine is missing or cannot run. Reinstall the app or prepare its native resources.',{cause:error});this.update({state:'error',error:{code:failure.code,message:failure.message}});throw failure;}}
  private binary(backend:EngineBackend):string{return path.isAbsolute(backend.executable)?backend.executable:path.resolve(this.settings.resourcesDirectory!,backend.executable);}
  private nativePlanningAvailable(portable=false):boolean{return Boolean(this.settings.nativePlannerTestOutput||this.manifest?.planner&&(portable?this.manifest.resourceProbe||['linux-x64','win32-x64'].includes(this.manifest.target)&&this.manifest.planner.id==='cpu':this.manifest.planner.id==='metal'&&this.manifest.resourceProbe));}
  private async assertNativeModelUnchanged(plan:Pick<NativeMemoryPlan,'model'|'modelDigest'|'templateDigest'>):Promise<void>{
    const spec=this.spec(plan.model),known=this.verification.get(plan.model);if(!known||known.verified.digest!==plan.modelDigest||known.verified.templateHash!==plan.templateDigest)throw new RuntimeError('MODEL_CHANGED','The active model no longer matches its verified native allocation plan.');
    const artifacts=modelArtifacts(spec);for(let i=0;i<artifacts.length;i++){const current=await lstat(path.join(this.status.modelCacheDirectory,artifacts[i].filename));if(!current.isFile()||current.isSymbolicLink()||!same(known.fingerprints[i],fingerprint(current)))throw new RuntimeError('MODEL_CHANGED','A model artifact changed after its native allocation plan was verified.');}
  }
  private async nativeProcessSample(pid:number):Promise<Pick<ResourceMeasurements,'residentBytes'|'physicalFootprintBytes'|'rssBytes'|'sampledAt'>>{
    const helper=this.manifest?.resourceProbe;if(!helper)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The integrity-covered native process sampler is required for mapped-weight calibration.');
    return parseNativeResourceSample(await this.execute(this.binary(helper),['--pid',String(pid)],undefined,helper,1500),pid,process.pid);
  }
  private planNativeResources(spec:CuratedModel,verified:VerifiedModel,profile:InferenceProfile,signal:AbortSignal,portable:true):Promise<PortableCPUAllocationPlan>;
  private planNativeResources(spec:CuratedModel,verified:VerifiedModel,profile:InferenceProfile,signal:AbortSignal,portable?:false):Promise<NativeMemoryPlan>;
  private async planNativeResources(spec:CuratedModel,verified:VerifiedModel,profile:InferenceProfile,signal:AbortSignal,portable=false):Promise<NativeMemoryPlan|PortableCPUAllocationPlan>{
    const planner=this.manifest?.planner,engineDigest=createHash('sha256').update(JSON.stringify({commit:ENGINE_COMMIT,files:this.manifest?.files.slice().sort((a,b)=>a.path.localeCompare(b.path))??[]})).digest('hex');
    const metadata=this.verification.get(spec.id)?.metadata;
    if(profile.nativePlacement&&metadata?.length!==1)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Mixed placement requires one complete verified GGUF header.');
    const mappedPlacement=!portable&&metadata?.[0]?nativeMappedPlacement(metadata[0],profile,spec.id):undefined;
    const plannerDigest=portable&&this.manifest?allocationPlannerPin(this.manifest.target)?.sha256:PINNED_NATIVE_PLANNER_SHA256;
    if(!plannerDigest)throw new RuntimeError('MODEL_MEMORY_PLANNER_UNAVAILABLE','No exact planner identity is pinned for this platform.');
    const binding={model:spec.id,engineDigest,plannerDigest,modelDigest:verified.digest,templateDigest:verified.templateHash!,profileSignature:inferenceProfileSignature(profile,this.status.memoryMode??'automatic'),artifactBytes:verified.sizeBytes,...(mappedPlacement?{mappedPlacement}:{}),...(profile.metalResidency?{metalResidency:profile.metalResidency}:{})};
    const parse=(output:string)=>portable?parsePortableCPUAllocationPlan(output,binding):parseNativeMemoryPlan(output,binding);
    if(this.settings.nativePlannerTestOutput)return parse(this.settings.nativePlannerTestOutput(profile));
    if(!planner||!this.nativePlanningAvailable(portable))throw new RuntimeError('MODEL_MEMORY_PLANNER_UNAVAILABLE','The pinned metadata-only planner and app-owned process monitor are required before allocation.');
    // These shared flags describe the same bounded native allocations as loadModel.
    // fit-params rejects server-only checkpoint/context-shift flags. Its no-alloc
    // graph never constructs server prompt caches or checkpoints; loading disables them.
    const args=[...(planner.arguments??[]),'--model',path.join(this.status.modelCacheDirectory,spec.filename),'--fit-print','on','--offline','--ctx-size',String(profile.contextTokens),'--batch-size',String(profile.batchTokens),'--ubatch-size',String(profile.microBatchTokens),...(portable?PORTABLE_CPU_ARGUMENTS:nativePlacementArguments(profile)),'--parallel','1','--cache-type-k',profile.cacheTypeK!,'--cache-type-v',profile.cacheTypeV!,'--flash-attn',portable?'off':'on','--load-mode','mmap','--fit','off'];
    const output=await new Promise<string>((resolve,reject)=>{throwIfAborted(signal);const child=spawn(this.binary(planner),args,{env:{...this.childEnvironment(planner),...nativeEnvironmentOverrides(profile)},stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});let text='',done=false,busy=false;
      const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(deadline);clearInterval(monitor);signal.removeEventListener('abort',cancel);if(error){child.kill('SIGKILL');if(child.exitCode!==null||child.signalCode!==null)reject(error);else child.once('close',()=>reject(error));}else resolve(text);};
      const cancel=()=>finish(abortError());const deadline=setTimeout(()=>finish(new RuntimeError('MODEL_MEMORY_PLAN_TIMEOUT','Metadata-only allocation planning exceeded its thirty-second deadline.')),30000);
      const monitor=setInterval(()=>{if(done||busy||!child.pid||child.exitCode!==null||child.signalCode!==null)return;busy=true;void (async()=>{try{const sample=portable&&!this.manifest?.resourceProbe?await this.resourceSample(child.pid!):await this.nativeProcessSample(child.pid!);if(done)return;if(sample.residentBytes>512*1024**2)finish(new RuntimeError('MODEL_MEMORY_PLAN_LIMIT','The metadata-only planner exceeded its bounded 512 MiB process budget.'));}catch(error){if(!done&&!await plannerExitedAfterSamplerFailure(child,error))finish(error);}finally{busy=false;}})();},250);
      signal.addEventListener('abort',cancel,{once:true});for(const stream of [child.stdout,child.stderr])stream?.on('data',(chunk:Buffer)=>{text+=chunk.toString();if(text.length>128*1024)finish(new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The metadata-only planner returned oversized output.'));});child.once('error',finish);child.once('close',code=>finish(code===0?undefined:new RuntimeError('MODEL_MEMORY_PLAN_FAILED',text.slice(-2000)||'Native allocation planning failed.')));if(signal.aborted)cancel();
    });
    throwIfAborted(signal);const known=this.verification.get(spec.id);if(!known||known.verified.digest!==verified.digest)throw new RuntimeError('MODEL_CHANGED','The model identity changed during native planning.');for(let i=0;i<known.fingerprints.length;i++){if(!same(known.fingerprints[i],fingerprint(await lstat(path.join(this.status.modelCacheDirectory,modelArtifacts(spec)[i].filename)))))throw new RuntimeError('MODEL_CHANGED','A verified model artifact changed during native planning.');}
    return parse(output);
  }
  private async readManifest(signal:AbortSignal):Promise<void>{
    if(!this.settings.resourcesDirectory)throw new RuntimeError('ENGINE_NOT_AVAILABLE','Bundled inference resources are unavailable.');const root=await realpath(this.settings.resourcesDirectory);const raw=await readFile(path.join(root,'manifest.json'),'utf8');if(raw.length>1024**2)throw new RuntimeError('INVALID_ENGINE_MANIFEST','The engine manifest is oversized.');
    const manifest=JSON.parse(raw) as EngineManifest;if(manifest.schemaVersion!==1||manifest.engine!=='llama.cpp'||manifest.version!==ENGINE_VERSION||manifest.commit!==ENGINE_COMMIT||manifest.build!==11429||manifest.target!==`${process.platform}-${process.arch}`||!Array.isArray(manifest.backends)||!Array.isArray(manifest.files)||!manifest.backends.some(b=>b.id==='cpu'))throw new RuntimeError('INVALID_ENGINE_MANIFEST','The engine manifest does not match this app and platform.');
    for(const file of manifest.files){throwIfAborted(signal);const candidate=path.resolve(root,file.path);if(!candidate.startsWith(`${root}${path.sep}`))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine resource path escapes its bundle.');const resolved=await realpath(candidate);if(!resolved.startsWith(`${root}${path.sep}`))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine resource link escapes its bundle.');const s=await stat(resolved);if(!s.isFile()||s.size!==file.size||await sha256File(resolved,signal)!==file.sha256)throw new RuntimeError('ENGINE_DIGEST_MISMATCH','A bundled engine resource does not match its pinned SHA-256.');}
    for(const backend of manifest.backends){if(!manifest.files.some(f=>f.path===backend.executable))throw new RuntimeError('INVALID_ENGINE_MANIFEST','An engine executable is not covered by the integrity manifest.');}
    if(manifest.planner&&!matchesAllocationPlanner(manifest.planner,manifest.target,manifest.files))throw new RuntimeError('INVALID_ENGINE_MANIFEST','The metadata-only planner is not the exact pinned official executable for this platform.');
    if(manifest.resourceProbe&&(manifest.target!=='darwin-arm64'||manifest.resourceProbe.id!=='native-resource'||manifest.resourceProbe.executable!=='metal/agent-memory-sample'||manifest.resourceProbe.sourceSha256!==NATIVE_RESOURCE_SOURCE_SHA256||JSON.stringify(manifest.resourceProbe.arguments??[])!=='[]'||!manifest.files.some(f=>f.path===manifest.resourceProbe!.executable)))throw new RuntimeError('INVALID_ENGINE_MANIFEST','The owned process sampler is not covered by its audited source and resource manifest.');
    this.manifest=manifest;this.engine=manifest.backends;
  }
  private async readSSDManifest(signal:AbortSignal):Promise<void>{
    if(this.ssdManifest||this.ssdEngine.length)return;
    if(this.settings.ssdTestEngine){this.ssdRoot=path.dirname(this.settings.ssdTestEngine.executablePath);this.ssdEngine=[{id:'cpu',executable:this.settings.ssdTestEngine.executablePath,arguments:['--device','none','--n-gpu-layers','0','--no-op-offload']}];this.ssdManifest={integrity:this.settings.ssdTestEngine.integrityPath?{id:'integrity',executable:this.settings.ssdTestEngine.integrityPath,schemaVersion:1,sourceSha256:this.settings.ssdTestEngine.integritySourceDigest??'e'.repeat(64)}:undefined,planner:this.settings.ssdTestEngine.plannerPath?{id:'planner',executable:this.settings.ssdTestEngine.plannerPath,schemaVersion:1,sourceSha256:this.settings.ssdTestEngine.plannerSourceDigest??'f'.repeat(64)}:undefined,schemaVersion:1,engine:'llama.cpp-ssd-experts',version:ENGINE_VERSION,build:11429,baseCommit:ENGINE_COMMIT,upstreamCommits:[],patchSha256:this.settings.ssdTestEngine.patchDigest,target:'darwin-arm64',minimumMacOS:'14.0',backends:this.ssdEngine,files:[{path:this.settings.ssdTestEngine.executablePath,sha256:await sha256File(this.settings.ssdTestEngine.executablePath,signal),size:(await stat(this.settings.ssdTestEngine.executablePath)).size}]};this.update({ssdEngineReady:true});await this.loadSavedSSDTrials(this.ssdManifest.patchSha256,signal);return;}
    const root=this.settings.ssdResourcesDirectory??(this.settings.resourcesDirectory?path.resolve(this.settings.resourcesDirectory,'../ssd-inference/darwin-arm64'):null);if(!root)return;
    try{
      const resolvedRoot=await realpath(root),raw=await readFile(path.join(resolvedRoot,'manifest.json'),'utf8');if(raw.length>1024**2)throw new RuntimeError('SSD_ENGINE_MANIFEST','The SSD engine manifest is oversized.');const manifest=JSON.parse(raw) as SSDManifest;
      if(manifest.schemaVersion!==1||manifest.engine!=='llama.cpp-ssd-experts'||manifest.version!==ENGINE_VERSION||manifest.build!==11429||manifest.baseCommit!==ENGINE_COMMIT||manifest.target!=='darwin-arm64'||manifest.minimumMacOS!=='14.0'||!/^[a-f0-9]{64}$/.test(manifest.patchSha256)||!Array.isArray(manifest.backends)||!manifest.backends.some(b=>b.id==='cpu')||!Array.isArray(manifest.files))throw new RuntimeError('SSD_ENGINE_MANIFEST','The SSD engine manifest does not match the audited app worker.');
      for(const file of manifest.files){throwIfAborted(signal);const candidate=await realpath(path.resolve(resolvedRoot,file.path));if(!candidate.startsWith(resolvedRoot+path.sep))throw new RuntimeError('SSD_ENGINE_MANIFEST','An SSD worker resource escapes its bundle.');const info=await stat(candidate);if(!info.isFile()||info.size!==file.size||await sha256File(candidate,signal)!==file.sha256)throw new RuntimeError('SSD_ENGINE_DIGEST','An SSD worker resource failed bundle integrity verification.');}
      if(manifest.planner&&(manifest.planner.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(manifest.planner.sourceSha256)||!manifest.files.some(f=>f.path===manifest.planner!.executable)))throw new RuntimeError('SSD_ENGINE_MANIFEST','The metadata-only planner is not integrity-covered.');
      if(manifest.integrity&&(manifest.integrity.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(manifest.integrity.sourceSha256)||!manifest.files.some(f=>f.path===manifest.integrity!.executable)))throw new RuntimeError('SSD_ENGINE_MANIFEST','The bounded uncached integrity reader is not covered by the worker manifest.');
      for(const backend of manifest.backends)if(!manifest.files.some(f=>f.path===backend.executable))throw new RuntimeError('SSD_ENGINE_MANIFEST','The SSD executable is not integrity-covered.');
      this.numericalConfigurations=[];
      for(const configuration of manifest.validatedConfigurations??[]){
        const covered=manifest.files.find(f=>f.path===configuration.report&&f.sha256===configuration.reportSha256&&f.path.startsWith('validation/'));
        if(!covered||covered.size>1024**2)continue;
        try{const report=JSON.parse(await readFile(path.join(resolvedRoot,covered.path),'utf8'));if(validateSSDNumericalProof(report,configuration,manifest.patchSha256,ssdNumericalNativeBinding(manifest)))this.numericalConfigurations.push(structuredClone(configuration));}catch{ /* Missing or malformed proofs never authorize execution. */ }
      }
      this.ssdRoot=resolvedRoot;this.ssdManifest=manifest;this.ssdEngine=manifest.backends;this.update({ssdEngineReady:true});
      await this.loadSavedSSDTrials(manifest.patchSha256,signal);
    }catch(error){if(signal.aborted)throw abortError();this.ssdManifest=null;this.ssdEngine=[];this.numericalConfigurations=[];this.update({ssdEngineReady:false});this.emit('log',`SSD worker unavailable: ${error instanceof Error?error.message:'invalid bundle'}. Normal inference remains available.\n`);}
  }
  private ssdPlatformSupported(hardware:HardwareInfo):boolean{return hardware.platform==='darwin'&&hardware.architecture==='arm64'&&Number((hardware.osRelease??(process.platform==='darwin'?release():'')).split('.')[0])>=23;}
  private ssdBackendArguments(backend:EngineBackend):string[]{return [...(backend.arguments??[]),...(backend.id==='cpu'?SSD_CPU_ARGUMENTS:[])];}
  private ssdEngineIdentity(backend:EngineBackend,parityReportDigest:string|null=null):string{
    const manifest=this.ssdManifest!;return createHash('sha256').update(JSON.stringify({baseCommit:manifest.baseCommit,patchSha256:manifest.patchSha256,target:manifest.target,backend:backend.id,backendArguments:this.ssdBackendArguments(backend),cpuKernel:backend.id==='cpu'?'standard':'default',useExtraBufts:backend.id!=='cpu',decodeThreads:backend.id==='cpu'?4:null,batchThreads:backend.id==='cpu'?4:null,parityReportDigest,planner:manifest.planner??null,integrity:manifest.integrity??null,files:manifest.files.filter(f=>f.path.startsWith((backend.libraryDirectory??path.dirname(backend.executable))+'/')||f.path===manifest.planner?.executable||f.path===manifest.integrity?.executable).sort((a,b)=>a.path.localeCompare(b.path))})).digest('hex');
  }
  private numericalConfiguration(spec:CuratedModel,verified?:VerifiedModel):SSDNumericalConfiguration|undefined{
    return this.numericalConfigurations.find(c=>c.modelSha256===(verified?.digest??curatedArtifactSetDigest(spec))&&(!verified||c.templateSha256===verified.templateHash)&&c.architecture===spec.architecture&&c.backend==='cpu'&&c.workerPatchSha256===this.ssdManifest?.patchSha256&&c.profile.cacheSlotsPerLayer===spec.ssd?.minimumSlotsPerLayer);
  }
  private parityDigest(spec:CuratedModel,verified?:VerifiedModel):string|null{
    if(this.settings.ssdTestEngine)return /^[a-f0-9]{64}$/.test(this.settings.ssdTestEngine.fixtureParityReportDigest??'')?this.settings.ssdTestEngine.fixtureParityReportDigest!:null;
    return this.numericalConfiguration(spec,verified)?.reportSha256??null;
  }
  private parityBlocker(spec:CuratedModel,verified?:VerifiedModel):ModelBlocker|null{
    if(this.settings.qaSSDBackend)return null;
    return this.parityDigest(spec,verified)?null:{code:'SSD_PARITY_UNVERIFIED',message:'SSD execution is unavailable until this exact model and standard CPU profile have a bundled, verified numerical validation report. Downloading remains available.'};
  }
  private validatedMetalConfiguration(_spec:CuratedModel,_verified:VerifiedModel):boolean{return false;}
  private currentSSDConsent(spec:CuratedModel,verified:VerifiedModel,trial:ExperimentalTrial|undefined):boolean{
    const reportDigest=this.parityDigest(spec,verified),backend=this.ssdEngine.find(b=>b.id==='cpu');
    if(!trial||!reportDigest||!backend||trial.mode!=='ssd-experts'||trial.state!=='passed'||trial.backendValidation!=='validated'||trial.parityReportDigest!==reportDigest||trial.artifactSetDigest!==verified.digest||trial.templateDigest!==verified.templateHash||trial.patchDigest!==this.ssdManifest?.patchSha256||trial.engineDigest!==this.ssdEngineIdentity(backend,reportDigest))return false;
    try{const p=JSON.parse(trial.profileSignature),contract=ssdProfileContract(spec);return p.memoryMode==='ssd-experts'&&p.engineCommit===ENGINE_COMMIT&&p.backend==='cpu'&&p.cpuKernel==='standard'&&p.useExtraBufts===false&&p.decodeThreads===4&&p.batchThreads===4&&p.parityReportDigest===reportDigest&&p.engineDigest===trial.engineDigest&&p.patchDigest===trial.patchDigest&&p.artifactSetDigest===verified.digest&&p.templateDigest===verified.templateHash&&p.contextTokens===contract.profile.contextTokens&&p.outputTokens===contract.profile.outputTokens&&p.batchTokens===contract.profile.batchTokens&&p.microBatchTokens===contract.profile.microBatchTokens&&(!exactQwen80Source(spec)||p.localOnly===true&&p.kvUnified===true&&p.nRsSeq===0&&p.checkpoints===0)&&p.slots===1&&p.workers===2&&p.ioMode==='darwin-nocache'&&p.cacheTypeK==='f16'&&p.cacheTypeV==='f16'&&p.minimumSlotsPerLayer===spec.ssd?.minimumSlotsPerLayer&&p.expectedGroups===spec.ssd?.expectedLayers&&p.residentLimitBytes===trial.resourceBudgetBytes&&p.allocationBudgetBytes===trial.allocationBudgetBytes&&Number.isSafeInteger(p.allocationBudgetBytes)&&p.allocationBudgetBytes>0&&Number.isSafeInteger(p.cacheBytes)&&p.cacheBytes>0&&JSON.stringify(p.backendArguments)===JSON.stringify(this.ssdBackendArguments(backend));}catch{return false;}
  }
  private publishIntegrityProgress(spec:CuratedModel,file:string,progress:{sizeBytes:number;bytesRead:number;ioMode:string;rssBytes:number;physicalFootprintBytes:number}):void{
    this.emit('integrity-progress',{model:spec.id,artifact:path.basename(file),...progress});
    const trial=this.status.experimentalTrial,artifacts=modelArtifacts(spec),index=artifacts.findIndex(a=>a.filename===path.basename(file));
    if(this.status.memoryMode==='ssd-experts'&&trial?.mode==='ssd-experts'&&trial.model===spec.id&&trial.state==='loading'&&trial.progress?.stage==='verifying'&&index>=0&&progress.sizeBytes===artifacts[index].sizeBytes){
      this.updateTrial({progress:{stage:'verifying',message:'Verifying complete pinned model checksums.',completedBytes:artifacts.slice(0,index).reduce((n,a)=>n+a.sizeBytes,0)+progress.bytesRead,totalBytes:spec.estimatedDownloadBytes}});
    }
  }
  private async hashModelFile(spec:CuratedModel|undefined,file:string,signal?:AbortSignal,strict=Boolean(spec?.ssd&&this.status.memoryMode==='ssd-experts'),taskDeadline=true):Promise<string>{
    throwIfAborted(signal);const helper=this.ssdManifest?.integrity,hardware=this.status.hardware??this.settings.hardware;
    if(!spec?.ssd||!hardware||!this.ssdPlatformSupported(hardware)||!helper){
      if(strict&&!this.settings.ssdTestEngine)throw new RuntimeError('SSD_INTEGRITY_HELPER_UNAVAILABLE','SSD loading requires the bundled, verified uncached integrity reader on a supported local filesystem.');
      const digest=await sha256File(file,signal);this.integrityModes.set(file,'node');return digest;
    }
    const controller=new AbortController();this.integrityControllers.add(controller);const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const work=this.integrityWork.then(async()=>{
      throwIfAborted(combined);const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink())throw new RuntimeError('INVALID_DOWNLOAD_FILE','Model integrity verification requires a regular file.');
      const sample=await this.resourceSample(null),residentLimit=Math.floor(Math.min(256*1024**2,experimentalResidentBudget({...hardware,availableMemoryBytes:sample.availableMemoryBytes})));
      if(sample.pressure==='critical'||residentLimit<32*1024**2)throw new RuntimeError('SSD_HASH_RESOURCE_UNAVAILABLE','Current memory headroom is insufficient for bounded model verification.');
      const remaining=taskDeadline&&this.remainingExecutionMs?Math.floor(this.remainingExecutionMs()):1800000,deadline=Math.min(1800000,remaining);if(!Number.isSafeInteger(deadline)||deadline<=0)throw new RuntimeError('EXECUTION_TIMEOUT','The active execution deadline expired before model integrity verification.');
      let partialProgress='';const progress=(text:string)=>{const lines=(partialProgress+text).split('\n');partialProgress=(lines.pop()??'').slice(-16384);for(const line of lines){if(!line.startsWith('SSD_HASH_PROGRESS '))continue;try{const p=JSON.parse(line.slice(18));if(p.sizeBytes===before.size&&Number.isSafeInteger(p.bytesRead)&&p.bytesRead>=0&&p.bytesRead<=before.size)this.publishIntegrityProgress(spec,file,{sizeBytes:p.sizeBytes,bytesRead:p.bytesRead,ioMode:'darwin-nocache',rssBytes:p.rssBytes,physicalFootprintBytes:p.physicalFootprintBytes});}catch{}}};
      let output:string;try{output=await this.execute(this.ssdBinary(helper),[...(helper.arguments??[]),'--file',file,'--deadline-ms',String(deadline),'--resident-limit-bytes',String(residentLimit)],combined,helper,deadline,this.ssdRoot??undefined,progress);}
      catch(error){
        if(combined.aborted)throw abortError();const message=error instanceof Error?error.message:'';
        const structured=message.split('\n').findLast(line=>line.startsWith('SSD_HASH_ERROR '));let code:string|undefined;try{code=JSON.parse(structured?.slice(15)??'').code;}catch{}
        if(!strict&&code==='SSD_HASH_FILESYSTEM_UNSUPPORTED'){const digest=await sha256File(file,combined);this.integrityModes.set(file,'node');return digest;}
        throw new RuntimeError(code==='SSD_HASH_FILESYSTEM_UNSUPPORTED'?code:'SSD_HASH_FAILED',code==='SSD_HASH_FILESYSTEM_UNSUPPORTED'?'SSD streaming currently requires a validated local APFS model file.':'The uncached model integrity reader failed or reached its deadline.',{cause:error});
      }
      const line=output.split('\n').findLast(s=>s.startsWith('SSD_HASH '));let value:unknown;try{value=JSON.parse(line?.slice(9)??'');}catch{throw new RuntimeError('SSD_HASH_INVALID','The uncached integrity reader returned no valid checksum proof.');}
      const proof=validateSSDHashProof(value,{file:before,patchDigest:this.ssdManifest!.patchSha256,sourceDigest:helper.sourceSha256,residentLimitBytes:residentLimit});
      const after=await lstat(file);if(!after.isFile()||after.isSymbolicLink()||!same(fingerprint(before),fingerprint(after)))throw new RuntimeError('MODEL_CHANGED','The model file changed during uncached integrity verification.');
      this.integrityModes.set(file,'darwin-nocache');this.publishIntegrityProgress(spec,file,{sizeBytes:proof.sizeBytes,bytesRead:proof.bytesRead,ioMode:proof.ioMode,rssBytes:proof.rssBytes,physicalFootprintBytes:proof.physicalFootprintBytes});return proof.sha256;
    });this.integrityWork=work.then(()=>{},()=>{});
    let cancel:()=>void=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(abortError());combined.addEventListener('abort',cancel,{once:true});if(combined.aborted)cancel();});
    try{return await Promise.race([work,cancelled]);}finally{combined.removeEventListener('abort',cancel);this.integrityControllers.delete(controller);}
  }
  private async planSSDResources(spec:CuratedModel,backend:string,cacheBytes:number,allocationBudgetBytes:number,residentLimitBytes:number,rawDenseBytes:number,minimumCacheBytes:number,signal:AbortSignal):Promise<SSDResourcePlan|null>{
    const planner=this.ssdManifest?.planner;if(!planner)return null;const contract=ssdProfileContract(spec);
    const args=[...(planner.arguments??[]),'--model',path.join(this.status.modelCacheDirectory,spec.filename),'--backend',backend,'--ctx-size',String(contract.profile.contextTokens),'--batch-size',String(contract.profile.batchTokens),'--ubatch-size',String(contract.profile.microBatchTokens),'--output-tokens',String(contract.profile.outputTokens),'--cache-slots',String(spec.ssd!.minimumSlotsPerLayer),'--cache-bytes',String(cacheBytes),'--ssd-budget-bytes',String(allocationBudgetBytes),'--ssd-resident-limit-bytes',String(residentLimitBytes),'--deadline-ms','30000'];
    const output=await this.execute(this.ssdBinary(planner),args,signal,planner,30000,this.ssdRoot??undefined),line=output.split('\n').findLast(s=>s.startsWith('SSD_PLAN '));if(!line)throw new RuntimeError('SSD_PLAN_INVALID','The native metadata-only planner did not return a bounded resource plan.');
    let value:unknown;try{value=JSON.parse(line.slice(9));}catch{throw new RuntimeError('SSD_PLAN_INVALID','The native memory planner returned invalid JSON.');}
    return validateSSDResourcePlan(value,{architecture:spec.architecture,backend,patchDigest:this.ssdManifest!.patchSha256,sourceDigest:planner.sourceSha256,expectedGroups:spec.ssd!.expectedLayers,minimumSlotsPerLayer:spec.ssd!.minimumSlotsPerLayer,rawDenseBytes,cacheBytes,minimumCacheBytes,allocationBudgetBytes,residentLimitBytes,profile:contract.profile});
  }
  private async loadSavedSSDTrials(patchDigest:string,signal:AbortSignal):Promise<void>{
    try{const raw=await readFile(path.join(this.settings.dataDirectory,'ssd-trials.json'),'utf8');if(raw.length>1024**2)return;const records=JSON.parse(raw) as ExperimentalTrial[];if(!Array.isArray(records)||records.length>100)return;
      for(const item of records){
        const spec=this.catalog().find(s=>s.id===item.model);
        if(!spec||!item.artifactSetDigest||!item.templateDigest)continue;
        const binding={model:spec.id,digest:item.artifactSetDigest,templateHash:item.templateDigest,sizeBytes:spec.estimatedDownloadBytes,capabilities:[],verifiedAt:'',toolCapable:false};
        if(item.probePassed&&this.currentSSDConsent(spec,binding,item))this.savedSSDTrials.set(item.model,structuredClone(item));
      }
    }catch(error){if(signal.aborted)throw abortError();}
  }
  private ssdBinary(backend:EngineBackend):string{return path.isAbsolute(backend.executable)?backend.executable:path.resolve(this.ssdRoot!,backend.executable);}
  private async persistSSDTrial():Promise<void>{const trial=this.status.experimentalTrial;if(trial?.mode!=='ssd-experts'||trial.state!=='passed'||this.settings.qaSSDBackend)return;const verified=this.verification.get(trial.model)?.verified;if(!verified||!this.currentSSDConsent(this.spec(trial.model),verified,trial))return;this.savedSSDTrials.set(trial.model,structuredClone(trial));const target=path.join(this.settings.dataDirectory,'ssd-trials.json'),temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify([...this.savedSSDTrials.values()]),{mode:0o600,flag:'wx'});await rename(temp,target);}finally{await rm(temp,{force:true});}}
  async startModelTrial(model:string,route:'ssd-experts'='ssd-experts',options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    if(route!=='ssd-experts')throw new RuntimeError('SSD_ROUTE_INVALID','Choose the supported SSD expert streaming route.');
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController&&this.status.downloadingModel===model)throw new RuntimeError('DOWNLOAD_BUSY','Wait for this model download to finish.');const trialSpec=this.spec(model);
    const previousMode=this.status.memoryMode??'automatic',previousRoute=this.status.executionRoute??'normal';this.stopResourceWatchdog();this.trialController?.abort();const controller=new AbortController();this.trialController=controller;this.trialFailure=null;this.ssdStatus=null;this.ssdBinding=null;
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    this.update({memoryMode:'ssd-experts',executionRoute:'ssd-experts',loadedModel:null,profile:null,baseUrl:null,engineIdentity:undefined,experimentalTrial:{id:randomUUID(),mode:'ssd-experts',model,digest:null,state:'loading',startedAt:new Date().toISOString(),profileSignature:'pending-ssd-binding',probePassed:false,toolProbePassed:false,error:null,resourceBudgetBytes:null,mappedBytes:null,lazyEligibleBytes:null,measurements:null,streaming:null,progress:{stage:'verifying',message:'Verifying complete pinned model checksums.',completedBytes:0,totalBytes:trialSpec.estimatedDownloadBytes}}});
    this.trialPromise=this.ssdTrialInternal(model,signal).catch(async error=>{
      await this.terminateChild();this.prepared=null;const cancelled=signal.aborted&&!this.trialFailure,failure=this.trialFailure??(error instanceof RuntimeError?error:new RuntimeError(cancelled?'SSD_CANCELLED':'SSD_TRIAL_FAILED',error instanceof Error?error.message:'The SSD model trial failed.',{cause:error}));
      this.updateTrial({state:cancelled?'cancelled':'failed',probePassed:false,toolProbePassed:false,error:cancelled?null:{code:failure.code,message:failure.message},finishedAt:new Date().toISOString()});this.ssdBinding=null;
      this.update({memoryMode:previousMode,executionRoute:previousRoute,state:this.engine.length?'ready':'error',loadedModel:null,profile:null,engineIdentity:undefined,error:this.engine.length?null:{code:failure.code,message:failure.message}});throw cancelled?abortError():failure;
    }).finally(async()=>{await this.historyWrites;this.trialPromise=null;if(this.status.experimentalTrial?.state!=='passed')this.trialController=null;});return this.trialPromise;
  }
  private async ssdTrialInternal(model:string,signal:AbortSignal):Promise<PreparedModel>{
    if(!this.engine.length)await this.start({signal});const spec=this.spec(model),hardware=this.status.hardware!;
    if(!this.ssdPlatformSupported(hardware))throw new RuntimeError('SSD_PLATFORM_UNSUPPORTED','SSD expert streaming requires Apple Silicon and macOS 14 or newer. Normal bundled inference remains available on supported older macOS releases.');
    if(!spec.ssd)throw new RuntimeError('SSD_MODEL_UNSUPPORTED','This model architecture and artifact set has not been enabled for SSD expert streaming.');if(!this.ssdManifest||!this.ssdEngine.length)throw new RuntimeError('SSD_ENGINE_UNAVAILABLE','The audited SSD worker is unavailable in this app package.');
    await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;throwIfAborted(signal);const verified=await this.inspectModel(model,{signal,requireSSDIntegrity:true});this.updateTrial({digest:verified.digest,artifactSetDigest:verified.digest,templateDigest:verified.templateHash,progress:{stage:'planning',message:'Measuring resident weights, expert cache and workspace before allocation.'}});throwIfAborted(signal);
    const fresh=this.settings.refreshHardware?await this.settings.refreshHardware():this.settings.hardware?structuredClone(this.settings.hardware):await probeHardware(this.settings.dataDirectory,{freeDiskBytes:d=>this.disk(d)});fresh.gpus=structuredClone(hardware.gpus);const initial=await this.resourceSample(null);fresh.availableMemoryBytes=Math.min(fresh.totalMemoryBytes,initial.availableMemoryBytes);this.update({hardware:fresh,recommendation:this.hardwareRecommendation(fresh)});
    assertQwen80SSDMemory(spec,initial);
    let residentLimit=experimentalResidentBudget(fresh),allocationBudget=Math.max(0,Math.floor(residentLimit-Math.max(512*1024**2,residentLimit*.05))),record=this.verification.get(model)!;
    const tensors=record.metadata.flatMap(m=>m.tensors),expert=tensors.filter(t=>/^blk\.\d+\.ffn_(?:gate|up|down|gate_up)_exps\.weight$/.test(t.name));
    const layers=new Set(expert.map(t=>Number(t.name.split('.')[1]))),completeLayers=[...layers].every(layer=>{const names=new Set(expert.filter(t=>Number(t.name.split('.')[1])===layer).map(t=>t.name.split('.')[2]));return layer>=0&&layer<spec.ssd!.expectedLayers&&names.has('ffn_down_exps')&&(names.has('ffn_gate_up_exps')||names.has('ffn_up_exps')&&names.has('ffn_gate_exps'));});if(!completeLayers||layers.size!==spec.ssd.expectedLayers||expert.some(t=>t.dimensions.length!==3||t.dimensions[2]!==spec.ssd!.expertsPerLayer))throw new RuntimeError('SSD_EXPERT_LAYOUT_UNSUPPORTED','The exact GGUF expert layout does not match the validated streaming architecture.');
    const rawCacheBytes=Math.ceil(expert.reduce((n,t)=>n+t.bytes/spec.ssd!.expertsPerLayer,0)*spec.ssd.minimumSlotsPerLayer),cacheBytes=Math.ceil(rawCacheBytes*1.02+expert.length*16384),denseBytes=tensors.filter(t=>!expert.includes(t)).reduce((n,t)=>n+t.bytes,0),contextReserve=768*1024**2,scratchReserve=GIB,stagingReserve=Math.max(64*1024**2,...expert.map(t=>Math.ceil(t.bytes/spec.ssd!.expertsPerLayer)*spec.ssd!.activeExperts*2));
    // Every production SSD backend needs exact artifact/template/profile numerical evidence.
    // Device presence or a historical cpu-baseline record cannot authorize it.
    const validatedMetal=this.validatedMetalConfiguration(spec,verified),selectedBackend=this.settings.qaSSDBackend??(validatedMetal&&fresh.gpus.some(g=>g.backend==='metal')?'metal':'cpu'),backend=this.ssdEngine.find(b=>b.id===selectedBackend);if(!backend)throw new RuntimeError('SSD_BACKEND_UNAVAILABLE','The requested native SSD backend is not bundled.');const parityFailure=this.parityBlocker(spec,verified);if(parityFailure)throw new RuntimeError(parityFailure.code,parityFailure.message);const parityReportDigest=this.settings.qaSSDBackend?null:this.parityDigest(spec,verified),engineDigest=this.ssdEngineIdentity(backend,parityReportDigest),backendValidation=this.settings.qaSSDBackend?'qa-unvalidated':'validated';
    this.updateTrial({resourceBudgetBytes:residentLimit,allocationBudgetBytes:allocationBudget,measurements:initial});
    if(initial.pressure==='critical'||allocationBudget<=0)throw new RuntimeError('SSD_WORKSPACE_INSUFFICIENT','There is not enough safe available memory for a metadata-only SSD trial.');
    const plan=await this.planSSDResources(spec,selectedBackend,cacheBytes,allocationBudget,residentLimit,denseBytes,rawCacheBytes,signal);throwIfAborted(signal);
    let latest=initial;if(plan){latest=await this.resourceSample(null);const current=this.settings.refreshHardware?await this.settings.refreshHardware():this.settings.hardware?structuredClone(this.settings.hardware):await probeHardware(this.settings.dataDirectory,{freeDiskBytes:d=>this.disk(d)});current.gpus=structuredClone(hardware.gpus);current.availableMemoryBytes=Math.min(current.totalMemoryBytes,latest.availableMemoryBytes);residentLimit=Math.min(residentLimit,experimentalResidentBudget(current));allocationBudget=Math.max(0,Math.floor(residentLimit-Math.max(512*1024**2,residentLimit*.05)));this.update({hardware:current,recommendation:this.hardwareRecommendation(current)});
      for(let i=0;i<modelArtifacts(spec).length;i++)if(!same(record.fingerprints[i],fingerprint(await lstat(path.join(this.status.modelCacheDirectory,modelArtifacts(spec)[i].filename)))))throw new RuntimeError('MODEL_CHANGED','A model shard changed during native memory planning.');}
    assertQwen80SSDMemory(spec,latest);
    const required=plan?Math.max(plan.ledger.totalBytes,plan.loadingPeakBytes??0):denseBytes+cacheBytes+contextReserve+scratchReserve+stagingReserve;
    this.updateTrial({resourceBudgetBytes:residentLimit,allocationBudgetBytes:allocationBudget,measurements:latest,memoryPlan:plan});
    if(latest.pressure==='critical'||allocationBudget<required)throw new RuntimeError('SSD_WORKSPACE_INSUFFICIENT',`This SSD trial requires ${(required/GIB).toFixed(2)} GiB for resident weights, ${spec.ssd.minimumSlotsPerLayer} expert slots per layer, context and scratch; its current safe allocation budget is ${(Math.max(0,allocationBudget)/GIB).toFixed(2)} GiB. Close applications or choose a smaller model.`);
    this.ssdBinding={engineDigest,patchDigest:this.ssdManifest.patchSha256,artifactSetDigest:verified.digest,templateDigest:verified.templateHash!,allocationBudgetBytes:allocationBudget,residentLimitBytes:residentLimit,cacheBytes,expectedGroups:layers.size,minimumSlotsPerLayer:spec.ssd.minimumSlotsPerLayer,...(exactQwen80Source(spec)?{localOnly:true}:{}),backend:selectedBackend,backendArguments:this.ssdBackendArguments(backend),cpuKernel:selectedBackend==='cpu'?'standard':'default',useExtraBufts:selectedBackend!=='cpu',decodeThreads:selectedBackend==='cpu'?4:0,batchThreads:selectedBackend==='cpu'?4:0,parityReportDigest};
    this.updateTrial({engineDigest,patchDigest:this.ssdManifest.patchSha256,parityReportDigest:parityReportDigest??undefined,backendValidation,progress:{stage:'loading',message:'Loading resident tensors and preparing the bounded SSD expert cache.'}});const profile:InferenceProfile={...ssdProfileContract(spec).profile,backend:selectedBackend};this.update({state:'loading',profile,loadedModel:null,error:null});
    const prepared=await this.loadModel(spec,verified,profile,signal,true);throwIfAborted(signal);if(this.trialFailure)throw this.trialFailure;const child=this.child;if(!child)throw new RuntimeError('SSD_TRIAL_FAILED','The SSD worker stopped before verification.');
    const streaming=validateSSDStreamingStatus(await this.requestJson<SSDStreamingStatus>('/ssd/status',undefined,signal,3000),this.ssdBinding);this.ssdStatus=streaming;this.updateTrial({streaming});if(exactQwen80Source(spec))await this.checkQwen80SSDRequestResources(child,this.status.experimentalTrial!.id,spec);await this.watchResources(child);throwIfAborted(signal);if(this.child!==child)throw this.trialFailure??new RuntimeError('SSD_TRIAL_FAILED','The worker stopped during final resource verification.');
    this.prepared={...prepared,memoryMode:'ssd-experts',executionRoute:'ssd-experts',probePassed:true,backendValidation};this.updateTrial({state:'passed',profileSignature:this.prepared.profileSignature!,probePassed:true,toolProbePassed:prepared.toolCapable,finishedAt:new Date().toISOString()});this.update({state:'ready',loadedModel:model,error:null});await this.persistSSDTrial();return {...this.prepared};
  }
  async listModels():Promise<AvailableModel[]>{
    await this.loadImports();
    const hardware=this.status.hardware??await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});
    const free=await this.disk(this.status.modelCacheDirectory);
    return Promise.all(this.catalog().map(async spec=>{
      const artifacts=modelArtifacts(spec);let installed=true,sizeBytes=0,retainedBytes=0;const marks:FileFingerprint[]=[];
      for(const artifact of artifacts){let completeArtifact=false;try{const s=await lstat(path.join(this.status.modelCacheDirectory,artifact.filename));const regular=s.isFile()&&!s.isSymbolicLink();installed&&=regular&&s.size===artifact.sizeBytes;sizeBytes+=regular?s.size:0;completeArtifact=regular&&s.size===artifact.sizeBytes;retainedBytes+=completeArtifact?s.size:0;marks.push(fingerprint(s));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new RuntimeError('MODEL_DISCOVERY_FAILED','The model cache could not be inspected. Check its permissions and storage path.',{cause:error});installed=false;}
        try{const partial=await lstat(path.join(this.status.modelCacheDirectory,artifact.filename+'.part'));if(partial.isFile()&&!partial.isSymbolicLink()&&partial.size<=artifact.sizeBytes&&!completeArtifact)retainedBytes+=partial.size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      let fit=modelFit(spec,hardware,this.nativePlanningAvailable());const verificationError=sizeBytes>0?this.modelFailures.get(spec.id):undefined,known=this.verification.get(spec.id);
      const verified=installed&&!verificationError&&known&&known.fingerprints.length===marks.length&&marks.every((mark,i)=>same(mark,known.fingerprints[i]));
      const liveQualified=Boolean((usesQualifiedProfiles(spec.id)||isPortableModel(spec,hardware))&&verified&&this.child&&this.status.state==='ready'&&this.status.loadedModel===spec.id&&this.prepared?.sourceModel===spec.id&&this.prepared.digest===known.verified.digest&&this.prepared.profileSignature===this.status.profileSignature);
      if(liveQualified){fit={...classifyModel(spec,hardware,this.prepared!.contextTokens),fit:'recommended',fitReason:`The loaded ${this.prepared!.contextTokens/1024}K profile passed native preparation. Current memory is checked before requests and during inference; task quality requires separate checks.`};}
      const history=this.savedSSDTrials.get(spec.id),historicalBindingVerified=Boolean(verified&&this.currentSSDConsent(spec,known.verified,history));
      const liveSSD=Boolean(verified&&this.currentSSDConsent(spec,known.verified,this.status.experimentalTrial??undefined)&&this.child&&this.prepared?.sourceModel===spec.id&&this.prepared.digest===known.verified.digest&&this.prepared.profileSignature===this.status.profileSignature&&this.status.experimentalTrial?.mode==='ssd-experts'&&this.status.experimentalTrial.state==='passed'&&this.status.experimentalTrial.model===spec.id&&this.status.experimentalTrial.profileSignature===this.status.profileSignature);
      const ssdUseAllowed=this.status.memoryMode==='ssd-experts'&&(liveSSD||historicalBindingVerified);
      const platform=this.ssdPlatformSupported(hardware),supported=platform&&Boolean(spec.ssd);
      const acquisitionBlocker=!spec.repository?{code:'MODEL_DOWNLOAD_UNAVAILABLE',message:'This imported model has no catalog download.'}:free!==null&&free<Math.max(0,spec.estimatedDownloadBytes-retainedBytes)+512*1024**2?{code:'INSUFFICIENT_STORAGE',message:'There is not enough free storage to finish this model download.'}:null;
      const parityFailure=supported?this.parityBlocker(spec,verified?known.verified:undefined):null;
      const useBlocker=verificationError?{code:'MODEL_VERIFICATION_FAILED',message:verificationError}:!installed?{code:'MODEL_NOT_FOUND',message:'Download all model files before using this model.'}:qualifiedBackendBlocker(spec,hardware)?qualifiedBackendBlocker(spec,hardware):isPortableModel(spec,hardware)&&!this.nativePlanningAvailable(true)?{code:'MODEL_MEMORY_PLANNER_UNAVAILABLE',message:'This package has no verified metadata-only CPU allocation planner for the portable candidate. Import/download is available; runtime support is not established.'}:this.status.memoryMode==='ssd-experts'&&parityFailure?parityFailure:fit.fit==='insufficient'&&!ssdUseAllowed?{code:'INSUFFICIENT_MEMORY',message:fit.fitReason}:fit.fit==='slow'&&!isPortableModel(spec,hardware)&&!ssdUseAllowed&&!this.status.slowMode&&this.status.memoryMode!=='low-memory'?{code:'SLOW_MODE_REQUIRED',message:fit.fitReason}:null;
      const trialBlocker=verificationError?{code:'MODEL_VERIFICATION_FAILED',message:verificationError}:!supported?{code:'SSD_MODEL_UNSUPPORTED',message:platform?'SSD streaming currently supports the curated Gemma 26B and Qwen3-Coder-Next MoE models.':'SSD streaming requires Apple Silicon and macOS 14 or newer.'}:!installed?{code:'MODEL_NOT_FOUND',message:'Download every model shard before trying SSD streaming.'}:!this.status.ssdEngineReady?{code:'SSD_ENGINE_UNAVAILABLE',message:'The audited SSD worker is not available in this app package.'}:!this.ssdManifest?.integrity&&!this.settings.ssdTestEngine?{code:'SSD_INTEGRITY_HELPER_UNAVAILABLE',message:'The bundled uncached checksum reader is required for SSD loading. Normal inference and downloads remain available.'}:parityFailure;
      const proof=this.modelProbes.get(spec.id),trial=this.status.experimentalTrial,failedTrialBinding=(e:ModelProbeEvidence)=>e.status==='failed'&&trial?.mode==='ssd-experts'&&trial.state==='failed'&&trial.model===spec.id&&trial.digest===e.digest&&trial.templateDigest===e.templateHash&&trial.engineDigest===e.runtime&&trial.profileSignature===e.profileSignature&&trial.id===e.diagnostic?.binding.trialId&&trial.patchDigest===this.ssdManifest?.patchSha256;
      const bound=(e:ModelProbeEvidence|undefined)=>Boolean(e&&verified&&e.digest===known.verified.digest&&e.templateHash===known.verified.templateHash&&(e.profileSignature===this.status.profileSignature&&e.runtime===this.status.engineIdentity||failedTrialBinding(e)));
      return {...spec,...fit,...(isPortableModel(spec,hardware)?{preparationProfile:'portable-cpu-4k-v1' as const}:{}),artifacts,toolValidationEligible:Boolean(modelArchitectureAllowsTools(spec)&&!verificationError),toolCapable:bound(proof?.tool)&&proof?.tool.status==='passed',installed,sizeBytes,digest:verified?known.verified.digest:null,templateHash:verified?known.verified.templateHash:undefined,engineIdentity:this.child&&this.status.loadedModel===spec.id&&this.prepared?.sourceModel===spec.id?this.prepared.engineIdentity:undefined,historicalBindingVerified,needsPreparation:usesQualifiedProfiles(spec.id)||isPortableModel(spec,hardware)?!liveQualified:historicalBindingVerified&&(!this.child||this.prepared?.sourceModel!==spec.id),integrity:verificationError?'failed':verified?'verified':'unverified',blockedReason:verificationError??(fit.fit==='insufficient'&&!['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic')?fit.fitReason:null),verificationError,acquisitionBlocker,useBlocker,trialBlocker,downloadBlocker:acquisitionBlocker?.message??null,ssdEligibility:{supported,reason:trialBlocker?.message??'Selected MoE weights can be read through a bounded SSD expert cache; speed and task quality require local checks.',minimumSlotsPerLayer:spec.ssd?.minimumSlotsPerLayer??null,engineReady:Boolean(this.status.ssdEngineReady)},measuredTokensPerSecond:this.measurements.get(spec.id),chatProbe:bound(proof?.chat)?proof!.chat:{status:'unverified'},toolProbe:bound(proof?.tool)?proof!.tool:{status:'unverified'}};
    }));
  }
  async inspectModel(model:string,options:{signal?:AbortSignal;acceptNewDigest?:boolean;requireSSDIntegrity?:boolean;taskDeadline?:boolean}={}):Promise<VerifiedModel>{
    try{
      await this.loadImports();const spec=this.spec(model),artifacts=modelArtifacts(spec);throwIfAborted(options.signal);const marks:FileFingerprint[]=[],files:string[]=[];
      for(const artifact of artifacts){const file=path.join(this.status.modelCacheDirectory,artifact.filename);let info;try{info=await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new RuntimeError('MODEL_NOT_FOUND','Download or import every model shard first.');throw new RuntimeError('MODEL_ACCESS_FAILED','The local model file could not be read.',{cause:error});}if(!info.isFile()||info.isSymbolicLink()||info.size!==artifact.sizeBytes)throw new RuntimeError('MODEL_SIZE_MISMATCH','A model file does not match its pinned artifact size.');marks.push(fingerprint(info));files.push(file);}
      const requireNative=options.requireSSDIntegrity??Boolean(spec.ssd&&this.status.memoryMode==='ssd-experts'),known=this.verification.get(model);if(known&&(!requireNative||known.verified.verificationIO==='darwin-nocache'||this.settings.ssdTestEngine&&!this.ssdManifest?.integrity)&&known.fingerprints.length===marks.length&&marks.every((mark,i)=>same(mark,known.fingerprints[i]))){this.modelValidated(model);return structuredClone(known.verified);}
      const metadata:GGUFMetadata[]=[],artifactDigests:{filename:string;sha256:string;sizeBytes:number}[]=[];
      for(let i=0;i<files.length;i++){throwIfAborted(options.signal);const digest=await this.hashModelFile(spec,files[i],options.signal,requireNative,options.taskDeadline??true);if(digest!==artifacts[i].sha256)throw new RuntimeError('MODEL_DIGEST_MISMATCH','A model shard does not match its pinned SHA-256. Download the approved file again.');const item=await readGGUFMetadata(files[i],options.signal,artifacts.length>1?{split:{index:i,count:artifacts.length}}:{});if((i===0||item.architecture!=='')&&item.architecture!==spec.architecture)throw new RuntimeError('MODEL_ARCHITECTURE_MISMATCH','The model architecture does not match its catalog entry.');if(artifacts.length>1&&(item.splitNo!==i||item.splitCount!==artifacts.length))throw new RuntimeError('MODEL_SHARD_MISMATCH','The GGUF split index/count does not match the complete catalog shard set.');metadata.push(item);artifactDigests.push({filename:artifacts[i].filename,sha256:digest,sizeBytes:artifacts[i].sizeBytes});if(!same(marks[i],fingerprint(await stat(files[i]))))throw new RuntimeError('MODEL_CHANGED','A model file changed while it was being verified.');}
      for(let i=0;i<files.length;i++)if(!same(marks[i],fingerprint(await stat(files[i]))))throw new RuntimeError('MODEL_CHANGED','A model shard changed before the complete artifact set was verified.');
      validateGGUFModelSet(metadata,spec.architecture);
      const digest=artifacts.length===1?artifactDigests[0].sha256:createHash('sha256').update(JSON.stringify(artifactDigests)).digest('hex'),templateHash=createHash('sha256').update(metadata[0].chatTemplate).digest('hex'),toolCapable=this.toolsPassed.get(model)??false;
      const verified:VerifiedModel={model,digest,sizeBytes:spec.estimatedDownloadBytes,capabilities:toolCapable?['completion','tools']:['completion'],toolCapable,verifiedAt:new Date().toISOString(),verificationIO:files.every(file=>this.integrityModes.get(file)==='darwin-nocache')?'darwin-nocache':'node',templateHash,artifactDigests};this.verification.set(model,{fingerprints:marks,verified,metadata});this.modelValidated(model);return structuredClone(verified);
    }catch(error){if(options.signal?.aborted||(error instanceof Error&&error.name==='AbortError'))throw error;const failure=error instanceof RuntimeError?error:new RuntimeError((error as NodeJS.ErrnoException)?.code==='ENOENT'?'MODEL_NOT_FOUND':'MODEL_ACCESS_FAILED','The local model could not be verified. Check its permissions and storage path, or import a valid GGUF.',{cause:error});const operational=/^(?:SSD_HASH_|SSD_INTEGRITY_HELPER_|EXECUTION_TIMEOUT)/.test(failure.code);if(!operational){this.verification.delete(model);if(failure.code==='MODEL_NOT_FOUND')this.modelFailures.delete(model);else this.modelFailures.set(model,failure.message);}this.emit('status',this.getStatus());throw failure;}
  }
  private modelValidated(model:string):void {
    const cleared=this.modelFailures.delete(model);
    // A verified replacement can recover from a model failure without probing
    // or restarting the engine. Engine/transport failures need their own retry.
    const recoverable=/^(?:MODEL_(?:NOT_FOUND|NOT_ALLOWED|ACCESS_FAILED|SIZE_MISMATCH|DIGEST_MISMATCH|ARCHITECTURE_MISMATCH|CHANGED|LOAD_FAILED|LOAD_TIMEOUT)|INVALID_GGUF|INSUFFICIENT_MEMORY|SLOW_MODE_REQUIRED|ALLOCATION_FAILED)$/.test(this.status.error?.code??'');
    if(this.status.state==='ready'&&recoverable)this.update({error:null});else if(cleared)this.emit('status',this.getStatus());
  }
  async pullModel(model:string,options:{signal?:AbortSignal;onProgress?:(p:PullProgress)=>void}={}):Promise<VerifiedModel>{
    this.assertIdle();const spec=this.spec(model);if(!spec.repository)throw new RuntimeError('MODEL_DOWNLOAD_UNAVAILABLE','Imported files cannot be downloaded from the catalog.');if(this.pullController)throw new RuntimeError('DOWNLOAD_BUSY','A model download is already running.');throwIfAborted(options.signal);
    const controller=new AbortController();this.pullController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;this.update({downloadingModel:model});
    this.pullPromise=(async()=>{try{await downloadModel(spec,this.status.modelCacheDirectory,{signal,fetch:this.settings.fetch,hashFile:(file,hashSignal)=>this.hashModelFile(spec,file,hashSignal,false,false),freeDiskBytes:d=>this.disk(d),onProgress:p=>{options.onProgress?.(p);this.emit('pull-progress',p);}});this.verification.delete(model);return await this.inspectModel(model,{signal,requireSSDIntegrity:false,taskDeadline:false});}
    finally{if(this.pullController===controller)this.pullController=null;this.update({downloadingModel:null});}})().finally(()=>{this.pullPromise=null;});return this.pullPromise;
  }
  cancelPull():void{this.pullController?.abort();}
  /** Reuse a checksum-verified complete cache set before allocating any copy space. */
  private async reuseImportedModel(spec:CuratedModel,signal?:AbortSignal):Promise<VerifiedModel|null>{
    for(const artifact of modelArtifacts(spec)){try{const info=await lstat(path.join(this.status.modelCacheDirectory,artifact.filename));if(!info.isFile()||info.isSymbolicLink()||info.size!==artifact.sizeBytes)return null;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
    try{return await this.inspectModel(spec.id,{signal,requireSSDIntegrity:false,taskDeadline:false});}
    catch(error){if(signal?.aborted)throw error;if(error instanceof RuntimeError&&/^(?:MODEL_(?:SIZE_MISMATCH|DIGEST_MISMATCH|ARCHITECTURE_MISMATCH|SHARD_MISMATCH|SHARDS_REQUIRED|CHANGED)|INVALID_GGUF)$/.test(error.code))return null;throw error;}
  }
  private assertImportCanReplace(spec:CuratedModel):void{
    if(this.child&&this.prepared?.sourceModel===spec.id)throw new RuntimeError('MODEL_BUSY','Stop the loaded model before replacing its cache files. An unchanged verified model can be reused without stopping it.');
  }
  async importModel(sourcePath:string,options:{signal?:AbortSignal}={}):Promise<VerifiedModel>{
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController)throw new RuntimeError('MODEL_BUSY','Wait for other model operations to finish.');
    await this.loadImports();const selected=await resolveModelImportSource(sourcePath),split=this.catalog().find(s=>modelArtifacts(s).length>1&&modelArtifacts(s).some(a=>a.filename===path.basename(selected.path)));
    if(split){
      const artifacts=modelArtifacts(split);
      if(path.basename(selected.path)!==artifacts[0].filename)throw new RuntimeError('MODEL_SHARDS_REQUIRED',`Choose the first shard ${artifacts[0].filename}, or select all ${artifacts.length} files together.`);
      const siblings:string[]=[];
      for(const artifact of artifacts){
        const candidates=artifact.filename===artifacts[0].filename?[selected.path]:[...new Set([path.join(path.dirname(sourcePath),artifact.filename),path.join(path.dirname(selected.path),artifact.filename)])];
        let found:string|undefined;for(const candidate of candidates){try{found=(await resolveModelImportSource(candidate)).path;break;}catch(error){if(!(error instanceof RuntimeError)||error.code!=='MODEL_IMPORT_SOURCE_MISSING')throw error;}}
        if(!found)throw new RuntimeError('MODEL_SHARDS_REQUIRED',`Missing model shard ${artifact.filename}. Keep all ${artifacts.length} pinned shards together, then choose ${artifacts[0].filename} again.`);
        siblings.push(found);
      }
      return this.importModelFiles(siblings,options);
    }
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController)throw new RuntimeError('MODEL_BUSY','Wait for other model operations to finish.');
    const controller=new AbortController();this.pullController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const work=(async()=>{const source=await lstat(selected.path);if(!same(fingerprint(source),fingerprint(selected.info)))throw new RuntimeError('MODEL_CHANGED','The selected model changed before import began.');
      const named=this.catalog().find(s=>modelArtifacts(s).length===1&&s.filename===path.basename(selected.path));
      if(named&&named.estimatedDownloadBytes!==source.size)throw new RuntimeError('MODEL_SIZE_MISMATCH',`Model file ${named.filename} does not match its pinned size.`);
      if(named){try{const target=await lstat(path.join(this.status.modelCacheDirectory,named.filename));if(target.isFile()&&!target.isSymbolicLink()&&target.dev===source.dev&&target.ino===source.ino)return await this.inspectModel(named.id,{signal,requireSSDIntegrity:false,taskDeadline:false});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      const metadata=await readGGUFMetadata(selected.path,signal);if(metadata.splitCount!==null&&metadata.splitCount>1)throw new RuntimeError('MODEL_SHARDS_REQUIRED','This file is one shard of a split model. Choose the first pinned shard with its complete siblings, or select the full set.');
      const possibleSSD=this.catalog().find(s=>s.ssd&&s.estimatedDownloadBytes===source.size&&modelArtifacts(s).length===1),digest=await this.hashModelFile(possibleSSD,selected.path,signal,false,false);
      if(named&&digest!==named.sha256)throw new RuntimeError('MODEL_DIGEST_MISMATCH',`Model file ${named.filename} does not match its pinned SHA-256.`);
      if(!same(fingerprint(source),fingerprint(await lstat(selected.path))))throw new RuntimeError('MODEL_CHANGED','The source GGUF changed while being verified.');
      const curated=this.catalog().find(s=>modelArtifacts(s).length===1&&s.sha256===digest&&s.estimatedDownloadBytes===source.size);
      const spec:CuratedModel=curated??{id:`import:${digest}`,title:(metadata.name||path.basename(selected.path)).slice(0,500),description:'Imported local GGUF. Chat only until tool-call calibration succeeds.',estimatedDownloadBytes:source.size,minimumMemoryGB:Math.ceil(source.size/GIB+4),workingMemoryGB:source.size/GIB+2,license:'Imported file: verify its publisher license',sourceUrl:'',quantization:'Imported GGUF',repository:'',revision:'',filename:`import-${digest}.gguf`,sha256:digest,architecture:metadata.architecture,toolCapable:false};
      if(!curated){this.imports.set(spec.id,spec);await this.saveImports();}
      const reused=await this.reuseImportedModel(spec,signal);if(reused)return reused;this.assertImportCanReplace(spec);
      await mkdir(this.status.modelCacheDirectory,{recursive:true,mode:0o700});
      const temp=path.join(this.status.modelCacheDirectory,`.import-${randomUUID()}.gguf`);
      try{await stageModelImport(selected.path,temp,{signal,freeDiskBytes:()=>this.disk(this.status.modelCacheDirectory)});throwIfAborted(signal);await rename(temp,path.join(this.status.modelCacheDirectory,spec.filename));this.verification.delete(spec.id);return await this.inspectModel(spec.id,{signal,requireSSDIntegrity:false,taskDeadline:false});
      }finally{await rm(temp,{force:true});}
    })();this.pullPromise=work;try{return await work;}finally{if(this.pullController===controller)this.pullController=null;if(this.pullPromise===work)this.pullPromise=null;}
  }
  async importModelFiles(sourcePaths:readonly string[],options:{signal?:AbortSignal}={}):Promise<VerifiedModel>{
    if(sourcePaths.length===1)return this.importModel(sourcePaths[0],options);this.assertIdle();throwIfAborted(options.signal);if(this.pullController)throw new RuntimeError('MODEL_BUSY','Wait for other model operations to finish.');
    if(sourcePaths.length<2||sourcePaths.length>16||new Set(sourcePaths).size!==sourcePaths.length||sourcePaths.some(p=>!path.isAbsolute(p)))throw new RuntimeError('MODEL_SHARDS_REQUIRED','Select every distinct file in a supported model shard set.');
    const controller=new AbortController();this.pullController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const work=(async()=>{
      await this.loadImports();const resolved=await Promise.all(sourcePaths.map(resolveModelImportSource));
      if(new Set(resolved.map(s=>s.path)).size!==resolved.length)throw new RuntimeError('MODEL_SHARDS_REQUIRED','Each selected shortcut must resolve to a distinct model shard.');
      const selectedNames=new Set(resolved.map(s=>path.basename(s.path))),spec=this.catalog().find(s=>modelArtifacts(s).length===resolved.length&&modelArtifacts(s).every(a=>selectedNames.has(a.filename)));if(!spec)throw new RuntimeError('MODEL_SHARDS_UNSUPPORTED','Multiple-file import currently supports complete pinned catalog shard sets.');
      const artifacts=modelArtifacts(spec),sources=artifacts.map(a=>resolved.find(s=>path.basename(s.path)===a.filename)!),metadata:GGUFMetadata[]=[];
      let sameCache=true;
      for(let i=0;i<artifacts.length;i++){throwIfAborted(signal);const source=sources[i];if(source.info.size!==artifacts[i].sizeBytes)throw new RuntimeError('MODEL_SIZE_MISMATCH',`Model shard ${artifacts[i].filename} does not match its pinned file size.`);try{const target=await lstat(path.join(this.status.modelCacheDirectory,artifacts[i].filename));sameCache&&=target.isFile()&&!target.isSymbolicLink()&&target.dev===source.info.dev&&target.ino===source.info.ino;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;sameCache=false;}}
      if(sameCache)return this.inspectModel(spec.id,{signal,requireSSDIntegrity:false,taskDeadline:false});
      for(let i=0;i<artifacts.length;i++){throwIfAborted(signal);const source=sources[i];if(await this.hashModelFile(spec,source.path,signal,false,false)!==artifacts[i].sha256)throw new RuntimeError('MODEL_DIGEST_MISMATCH',`Model shard ${artifacts[i].filename} does not match its pinned SHA-256. Keep the correct complete shard set together.`);metadata.push(await readGGUFMetadata(source.path,signal,{split:{index:i,count:artifacts.length}}));if(!same(fingerprint(source.info),fingerprint(await lstat(source.path))))throw new RuntimeError('MODEL_CHANGED',`Model shard ${artifacts[i].filename} changed during verification.`);}
      validateGGUFModelSet(metadata,spec.architecture);const reused=await this.reuseImportedModel(spec,signal);if(reused)return reused;this.assertImportCanReplace(spec);
      await mkdir(this.status.modelCacheDirectory,{recursive:true,mode:0o700});
      const tempDirectory=path.join(this.status.modelCacheDirectory,'.import-'+randomUUID());await mkdir(tempDirectory,{mode:0o700});
      try{
        for(let i=0;i<artifacts.length;i++){throwIfAborted(signal);if(!same(fingerprint(sources[i].info),fingerprint(await lstat(sources[i].path))))throw new RuntimeError('MODEL_CHANGED',`Model shard ${artifacts[i].filename} changed before import.`);await stageModelImport(sources[i].path,path.join(tempDirectory,artifacts[i].filename),{signal,freeDiskBytes:()=>this.disk(this.status.modelCacheDirectory)});}
        for(const artifact of artifacts){throwIfAborted(signal);await rename(path.join(tempDirectory,artifact.filename),path.join(this.status.modelCacheDirectory,artifact.filename));}
        // rename is a no-op when a retained cache shard and staged hard link
        // already share an inode. Remove any remaining staging links before
        // recording ctime fingerprints for the final complete cache set.
        await rm(tempDirectory,{recursive:true,force:true});this.verification.delete(spec.id);return await this.inspectModel(spec.id,{signal,requireSSDIntegrity:false,taskDeadline:false});
      }finally{await rm(tempDirectory,{recursive:true,force:true});}
    })();this.pullPromise=work;try{return await work;}finally{if(this.pullController===controller)this.pullController=null;if(this.pullPromise===work)this.pullPromise=null;}
  }
  async prepareModel(model:string,options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(options.signal);if(this.pullController&&this.status.downloadingModel===model)throw new RuntimeError('DOWNLOAD_BUSY','Wait for this model download to finish.');
    if(this.status.memoryMode==='ssd-experts'&&(!this.child||this.prepared?.sourceModel!==model)){
      const saved=this.savedSSDTrials.get(model);if(!saved)throw new RuntimeError('SSD_TRIAL_REQUIRED','Choose Try from SSD before using this model.');const verified=await this.inspectModel(model,options);const parityFailure=this.parityBlocker(this.spec(model),verified);if(parityFailure)throw new RuntimeError(parityFailure.code,parityFailure.message);if(!this.currentSSDConsent(this.spec(model),verified,saved))throw new RuntimeError('SSD_TRIAL_REQUIRED','The saved SSD profile no longer matches this model, template or worker. Run a fresh trial.');return this.startModelTrial(model,'ssd-experts',options);
    }
    if(['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic')){
      const verified=await this.inspectModel(model,options),trial=this.status.experimentalTrial;
      if(this.status.memoryMode==='ssd-experts'){const failure=this.parityBlocker(this.spec(model),verified);if(failure)throw new RuntimeError(failure.code,failure.message);if(!this.settings.qaSSDBackend&&!this.currentSSDConsent(this.spec(model),verified,trial??undefined))throw new RuntimeError('SSD_PARITY_UNVERIFIED','The active SSD trial no longer matches its bundled numerical report and CPU configuration.');}
      if(!this.child||!this.prepared||this.prepared.sourceModel!==model||this.prepared.digest!==verified.digest||trial?.state!=='passed'||!trial.probePassed||trial.digest!==verified.digest||!this.status.profileSignature||trial.profileSignature!==this.status.profileSignature||this.prepared.profileSignature!==this.status.profileSignature)throw new RuntimeError('EXPERIMENTAL_TRIAL_REQUIRED','Run Try Experimental disk mode for this exact model and profile before using it.');
      return {...this.prepared};
    }
    const controller=new AbortController();this.loadController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;if(this.prepared?.sourceModel!==model)this.profileIndex=0;this.update({portableAdmissionDiagnostic:undefined});
    this.preparePromise=this.prepareInternal(model,signal,true).catch(error=>{if(!this.child){this.update({state:this.engine.length?'ready':'stopped',baseUrl:null,loadedModel:null,profile:null,error:signal.aborted?null:{code:error instanceof RuntimeError?error.code:'MODEL_LOAD_FAILED',message:error instanceof Error?error.message:'Model loading failed.'}});}throw error;}).finally(()=>{this.preparePromise=null;this.loadController=null;});return this.preparePromise;
  }
  private profiles(spec:CuratedModel):InferenceProfile[]{if(isPortableModel(spec,this.status.hardware))return [{...PORTABLE_CPU_PROFILE,index:0}];if(usesQualifiedProfiles(spec.id)){if(!this.status.hardware?.gpus.some(g=>g.backend==='metal')||!this.engine.some(b=>b.id==='metal'))throw new RuntimeError('MODEL_BACKEND_UNSUPPORTED','These qualified coding profiles require Metal. No CPU or 4K fallback is used.');const generationPolicy=generationPolicyForModel(spec.id);const lowMemory:InferenceProfile={contextTokens:16384,outputTokens:4096,batchTokens:64,microBatchTokens:16,backend:'metal',generationPolicy,cacheTypeK:'q8_0',cacheTypeV:'q8_0',flashAttention:'on',index:0};const q3Variant=spec.id==='qwen3.8:27b-q3-k-m'||spec.id==='muse-glimmer:30b-q3-k-m';if(q3Variant){lowMemory.batchTokens=128;lowMemory.microBatchTokens=32;}if(this.status.memoryMode==='low-memory'||q3Variant){if(q3Variant&&!this.nativePlanningAvailable())throw new RuntimeError('MODEL_MEMORY_PLANNER_UNAVAILABLE','Q3 coding candidates require a verified native memory plan before use.');if(this.nativePlanningAvailable()&&['qwen35','muse-glimmer'].includes(spec.architecture)){const metadata=this.verification.get(spec.id)?.metadata;if(q3Variant&&(metadata?.length!==1||metadata[0].architecture!==spec.architecture))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Q3 coding placement requires one complete SHA-verified header.');lowMemory.metalResidency='disabled';lowMemory.nativePlacement=spec.architecture==='qwen35'?{gpuLayers:spec.id==='qwen3.8:27b-q3-k-m'?42:64,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true,...(spec.id==='qwen3.8:27b-q3-k-m'?{outputNormOnCPU:true}:{})}:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,...(spec.id==='muse-glimmer:30b-q3-k-m'?museQ3CPUPlacement(metadata![0]):{outputOnCPU:false,cpuBlockIndices:[0,1,10,11,12,13]})};if(spec.id==='qwen3.8:27b-q3-k-m')lowMemory.recurrentCheckpoint={...QWEN_Q3_CHECKPOINT_POLICY};if(q3Variant)nativeMappedPlacement(metadata![0],lowMemory,spec.id);}else if(q3Variant)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Q3 coding candidates require their supported pinned architecture.');return [lowMemory];}if(this.nativePlanningAvailable()){const small={contextTokens:16384,outputTokens:4096,batchTokens:64,microBatchTokens:16,backend:'metal',generationPolicy,cacheTypeK:'f16' as const,cacheTypeV:'f16' as const,flashAttention:'on' as const};const entries:Omit<InferenceProfile,'index'>[]=this.status.hardware!.totalMemoryBytes<=24*GIB?[small]:[{...small,contextTokens:32768,outputTokens:8192,batchTokens:128,microBatchTokens:32},small];entries.push({...small,cacheTypeK:'q8_0',cacheTypeV:'q8_0'});return entries.map((profile,index)=>({...profile,index}));}return [{contextTokens:32768,outputTokens:8192,batchTokens:128,microBatchTokens:32,backend:'metal',index:0,generationPolicy},{contextTokens:16384,outputTokens:4096,batchTokens:64,microBatchTokens:16,backend:'metal',index:1,generationPolicy}];}const available=this.status.hardware?.gpus.some(g=>g.backend===this.engine[0]?.id);const backend=available?this.engine[0].id:'cpu';if(this.status.memoryMode==='low-memory')return [{contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32,backend,index:0},{contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,backend,index:1},{contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,backend:'cpu',index:2}];return [
    {contextTokens:8192,outputTokens:2048,batchTokens:512,microBatchTokens:128,backend,index:0},
    {contextTokens:8192,outputTokens:2048,batchTokens:256,microBatchTokens:64,backend,index:1},
    {contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32,backend:'cpu',index:2}];}
  private async prepareInternal(model:string,signal:AbortSignal,verify:boolean):Promise<PreparedModel>{
    if(!this.engine.length)await this.start({signal});const spec=this.spec(model),portable=isPortableModel(spec,this.status.hardware);
    const unsupported=this.status.hardware&&qualifiedBackendBlocker(spec,this.status.hardware);if(unsupported)throw new RuntimeError(unsupported.code,unsupported.message);
    const verified=await this.inspectModel(model,{signal});throwIfAborted(signal);
    if(verify&&this.prepared?.sourceModel===model&&this.child&&this.status.state==='ready'&&this.prepared.digest===verified.digest){
      if(portable||usesQualifiedProfiles(model)&&(!this.settings.hardware||this.settings.resourceProbe)){
        const owned=this.child;try{this.prepared={...this.prepared,calibrationMeasurements:await this.checkQualifiedResources(owned)};}catch(error){await this.stopQualifiedExecution(owned,model,error);throw error;}
      }
      return {...this.prepared};
    }
    await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;
    const qualified=usesQualifiedProfiles(spec.id),nativePlanning=qualified&&this.nativePlanningAvailable();
    if(portable&&!this.nativePlanningAvailable(true))throw new RuntimeError('MODEL_MEMORY_PLANNER_UNAVAILABLE','This portable CPU candidate requires the pinned metadata-only CPU allocation planner and app-owned process sampler. This package has no verified CPU planner for this platform; downloading or importing does not establish support.');
    if(qualified&&!nativePlanning&&!this.settings.executablePath)throw new RuntimeError('MODEL_MEMORY_PLANNER_UNAVAILABLE','Install the pinned native allocation planner and owned process sampler before preparing this coding model.');
    if(portable){this.profileIndex=0;this.update({memoryMode:'low-memory',executionRoute:'normal'});}
    if((qualified||portable)&&(this.settings.refreshHardware||!this.settings.hardware)){const hardware=await this.measureCurrentHardware(signal,!portable);this.update({hardware,recommendation:this.hardwareRecommendation(hardware)});}
    else if(!this.settings.hardware){const hardware=await probeHardware(this.settings.dataDirectory,{totalMemoryBytes:this.settings.totalMemoryBytes,availableMemoryBytes:this.settings.availableMemoryBytes,freeDiskBytes:d=>this.disk(d)});hardware.gpus=this.status.hardware?.gpus??[];this.update({hardware,recommendation:this.hardwareRecommendation(hardware)});}
    let hardware=this.status.hardware!;const fit=classifyModel(spec,portable?{...hardware,gpus:[]}:hardware,portable?4096:qualified?16384:32768);
    if(!nativePlanning&&!portable&&fit.fit==='insufficient')throw new RuntimeError('INSUFFICIENT_MEMORY',fit.fitReason);
    if(!portable&&!qualified&&verify&&fit.fit==='slow'&&!this.status.slowMode&&this.status.memoryMode!=='low-memory')throw new RuntimeError('SLOW_MODE_REQUIRED','This model requires Slow mode on the detected hardware. Enable it explicitly or choose a recommended model.');
    const profiles=this.profiles(spec);if(!portable&&(this.status.slowMode&&!qualified||qualified&&!nativePlanning&&this.status.memoryMode==='low-memory'&&profiles.length>1))this.profileIndex=Math.max(this.profileIndex,1);const startingProfileIndex=this.profileIndex;
    for(;this.profileIndex<profiles.length;this.profileIndex++){
      const profile=profiles[this.profileIndex];this.nativeMemoryPlan=null;this.portableMemoryPlan=null;this.update({state:'loading',profile,loadedModel:null,error:null,preparationStage:nativePlanning||portable?'planning':'loading'});
      if(qualified&&!nativePlanning){
        if(this.profileIndex>startingProfileIndex&&(this.settings.refreshHardware||!this.settings.hardware)){hardware=await this.measureCurrentHardware(signal);this.update({hardware,recommendation:this.hardwareRecommendation(hardware)});}
        const profileFit=classifyModel(spec,hardware,profile.contextTokens),required=profileFit.workingMemoryGB*GIB,metal=hardware.gpus.find(g=>g.backend==='metal');
        if(profileFit.fit==='insufficient'||hardware.availableMemoryBytes<required+512*1024**2||!metal||metal.freeMemoryBytes<required){if(this.profileIndex<profiles.length-1)continue;throw new RuntimeError('INSUFFICIENT_MEMORY','Neither the 32K nor 16K coding profile fits current available memory after the OS reserve. Close memory-heavy applications and refresh hardware.');}
      }
      try{
        if(portable){
          const plan=await this.planNativeResources(spec,verified,profile,signal,true);throwIfAborted(signal);this.update({portableAdmissionDiagnostic:pendingPortableCPUAdmissionDiagnostic(plan,hardware)});hardware=await this.measureCurrentHardware(signal,false);const initial=await this.resourceSample(null);hardware.availableMemoryBytes=initial.availableMemoryBytes;
          // Retain the exact bounded plan/sample before a rejected admission can
          // throw and owned teardown clears the admitted-plan readiness fields.
          assertPortableCPUAdmission(plan,hardware,initial,diagnostic=>this.update({hardware,profile,portableAdmissionDiagnostic:diagnostic}));
          this.portableMemoryPlan=plan;this.update({hardware,profile,preparationStage:'loading'});
        }else if(nativePlanning){
          this.emit('log','Planning exact mapped-weight allocations without loading model payloads.\n');const plan=await this.planNativeResources(spec,verified,profile,signal);throwIfAborted(signal);hardware=await this.measureCurrentHardware(signal);const initial=await this.resourceSample(null);hardware.availableMemoryBytes=initial.availableMemoryBytes;assertNativeMemoryAdmission(plan,hardware,initial);this.nativeMemoryPlan=plan;this.update({hardware,profile,preparationStage:'loading'});
        }
        if(profile.backend==='cpu'&&!portable){const cpuFit=classifyModel(spec,{...hardware,gpus:[]});if(cpuFit.fit==='insufficient')throw new RuntimeError('INSUFFICIENT_MEMORY',`CPU fallback cannot fit this model in system memory without exceeding the safe budget. ${cpuFit.fitReason}`);}
        const prepared=await this.loadModel(spec,verified,profile,signal);this.prepared=prepared;this.update({state:'ready',loadedModel:model,error:null});if((nativePlanning||portable)&&this.child)this.startQualifiedResourceWatchdog(this.child,model);return {...prepared};
      }catch(error){
        await this.terminateChild();if(signal.aborted){this.update({state:'ready',loadedModel:null,baseUrl:null,profile:null,error:null});throw abortError();}
        const allocationRecovery=isAllocationFailure(error)&&(!nativePlanning||!(error instanceof RuntimeError)||['ALLOCATION_FAILED','MODEL_LOAD_FAILED','INFERENCE_API_ERROR'].includes(error.code));
        if(!(allocationRecovery||nativePlanning&&error instanceof RuntimeError&&error.code==='INSUFFICIENT_MEMORY'||qualified&&error instanceof RuntimeError&&['MODEL_PROFILE_MISMATCH',...(!nativePlanning?['MODEL_MEMORY_CALIBRATION_FAILED']:[])].includes(error.code))||this.profileIndex===profiles.length-1){const failure=error instanceof RuntimeError?error:new RuntimeError('MODEL_LOAD_FAILED',error instanceof Error?error.message:'The model could not load.',{cause:error});this.update({state:'error',baseUrl:null,loadedModel:null,error:{code:failure.code,message:failure.message}});throw failure;}
        this.emit('log','Memory calibration or context check failed; trying the next explicit inference profile.\n');
      }
    }
    throw new RuntimeError('INSUFFICIENT_MEMORY','All bounded inference profiles exhausted available memory.');
  }
  private async loadModel(spec:CuratedModel,verified:VerifiedModel,profile:InferenceProfile,signal:AbortSignal,experimental=false):Promise<PreparedModel>{
    const ssd=experimental&&this.status.memoryMode==='ssd-experts',portable=isPortableModel(spec,this.status.hardware)&&Boolean(this.portableMemoryPlan);const backends=ssd?this.ssdEngine:this.engine;const backend=backends.find(b=>b.id===profile.backend)??backends.find(b=>b.id==='cpu')!;const executable=ssd?this.ssdBinary(backend):this.binary(backend);const port=await reservePort(this.settings.port);throwIfAborted(signal);this.apiKey=randomBytes(32).toString('hex');const authFile=path.join(this.settings.dataDirectory,`.inference-key-${randomUUID()}`);await writeFile(authFile,this.apiKey,{mode:0o600,flag:'wx'});
    assertNativeCheckpointProfile(profile,spec.id);const alias=`local-agent-${spec.id.replace(/[^a-z0-9]/g,'-')}`;this.chatProbeResults.delete(alias);const args=[...(ssd?this.ssdBackendArguments(backend):backend.arguments??[]),'--model',path.join(this.status.modelCacheDirectory,spec.filename),'--alias',alias,'--host','127.0.0.1','--port',String(port),'--api-key-file',authFile,'--offline','--no-agent','--no-webui','--no-ui-mcp-proxy','--parallel','1','--jinja','--ctx-size',String(profile.contextTokens),'--predict',String(profile.outputTokens),'--batch-size',String(profile.batchTokens),'--ubatch-size',String(profile.microBatchTokens),'--cache-ram','0','--no-cache-prompt','--no-cache-idle-slots','--ctx-checkpoints',String(profile.recurrentCheckpoint?.maxCheckpoints??0),'--no-context-shift','--no-warmup','--flash-attn','auto','--reasoning','auto','--reasoning-format','deepseek','--reasoning-budget',String(Math.min(1024,Math.floor(profile.outputTokens/2))),'--load-mode',ssd?'none':'mmap','--fit',experimental?'off':'on',...(ssd?['--cache-type-k','f16','--cache-type-v','f16','--ssd-require-streaming','--ssd-expert-cache-bytes',String(this.ssdBinding!.cacheBytes),'--ssd-budget-bytes',String(this.ssdBinding!.allocationBudgetBytes),'--ssd-resident-limit-bytes',String(this.status.experimentalTrial!.resourceBudgetBytes),'--moe-stream-io-threads','2','--ssd-deadline-ms',String(this.settings.ssdLoadTimeoutMs??1800000)]:experimental?['--lazy-mode','on','--cache-type-k','f16','--cache-type-v','f16','--no-op-offload']:['--fit-target','1024'])];
    // Pinned common/log.cpp maps GGML INFO startup allocation/configuration to
    // verbosity4; prompt-token debug output requires5. Keep exact evidence on.
    if(usesQualifiedProfiles(spec.id)){args.splice(args.indexOf('--reasoning-budget'),2);args[args.indexOf('--fit')+1]='off';args.splice(args.indexOf('--fit-target'),2);args.push('--log-verbosity','4',...nativePlacementArguments(profile),'--cache-type-k',profile.cacheTypeK??'f16','--cache-type-v',profile.cacheTypeV??'f16');if(profile.flashAttention)args[args.indexOf('--flash-attn')+1]=profile.flashAttention;}
    if(portable){args[args.indexOf('--fit')+1]='off';args.splice(args.indexOf('--fit-target'),2);args[args.indexOf('--flash-attn')+1]='off';args.push('--log-verbosity','4',...PORTABLE_CPU_ARGUMENTS,'--cache-type-k','f16','--cache-type-v','f16');}
    args.push(...qwen80SSDArguments(spec,ssd));
    if(profile.recurrentCheckpoint)args.push('--checkpoint-min-step',String(profile.recurrentCheckpoint.minimumStepTokens));
    const qwenNativeLog=ssd&&exactQwen80Source(spec)?new Qwen80NativeStartupLog():null,ownedQwenSSDTrialId=qwenNativeLog?this.status.experimentalTrial?.id:undefined;
    const portableProfileLog=portable?new PortableCPUStartupLog():null;
    const nativeProfileLog=this.nativeMemoryPlan?new NativeProfileLog():null;this.lastLog='';this.update({baseUrl:`http://127.0.0.1:${port}`,executablePath:executable,engineIdentity:ssd?this.ssdBinding?.engineDigest:this.nativeMemoryPlan?.engineDigest??this.portableMemoryPlan?.engineDigest??this.manifest?.files.find(f=>f.path===backend.executable)?.sha256??ENGINE_COMMIT});let child:ChildProcess;try{throwIfAborted(signal);if(this.nativeMemoryPlan)await this.assertNativeModelUnchanged(this.nativeMemoryPlan);if(this.portableMemoryPlan)await this.assertNativeModelUnchanged(this.portableMemoryPlan);if(ssd&&exactQwen80Source(spec))assertQwen80SSDMemory(spec,await this.resourceSample(null));throwIfAborted(signal);child=(this.settings.spawn??spawn)(executable,args,{env:{...this.childEnvironment(backend,ssd?this.ssdRoot??undefined:this.settings.resourcesDirectory),...nativeEnvironmentOverrides(profile)},cwd:this.settings.dataDirectory,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});}catch(error){await rm(authFile,{force:true});throw error;}this.child=child;if(ssd)this.ssdSpawnedAt=Date.now();const launch:{error?:Error}={};
    child.once('error',e=>{launch.error=e;});this.childExit=new Promise(resolve=>child.once('close',(code,exitSignal)=>{if(this.child===child){this.child=null;this.stopResourceWatchdog();if(!this.suppressExit&&this.status.state!=='stopping'&&this.status.state!=='stopped'){if(ssd)this.notifyExecutionStopped('SSD_RUNTIME_EXITED','The app-owned SSD inference process exited unexpectedly.');else if(usesQualifiedProfiles(spec.id)||portable)this.emit('executionStopped',{model:spec.id,code:'RUNTIME_EXITED',message:'The app-owned coding model process exited unexpectedly.'} satisfies ExecutionStoppedEvent);if(experimental)this.updateTrial({state:'failed',probePassed:false,toolProbePassed:false,error:{code:'RUNTIME_EXITED',message:'The experimental model process stopped.'},finishedAt:new Date().toISOString()});this.update({state:'error',loadedModel:null,baseUrl:null,error:{code:'RUNTIME_EXITED',message:`The local inference engine stopped (${exitSignal??code}). ${this.lastLog.slice(-1000)}`}});}}resolve();}));
    if(experimental){this.memoryLog=ssd?null:new EngineMemoryLog();this.ssdPartialLog='';this.startResourceWatchdog(child);}
    else if(portable||usesQualifiedProfiles(spec.id)&&(!this.settings.hardware||this.settings.resourceProbe)){this.qualifiedResourceFailure=null;this.startQualifiedResourceWatchdog(child,spec.id);}
    for(const stream of [child.stdout,child.stderr])stream?.on('data',(b:Buffer)=>{const text=b.toString();if(qwenNativeLog&&!this.captureOwnedQwen80SSDStatus(child,ownedQwenSSDTrialId,text))return;if(stream===child.stderr)qwenNativeLog?.append(text);nativeProfileLog?.push(text);portableProfileLog?.push(text);if(nativeProfileLog&&!nativeProfileLog.checkpointBoundsValid(profile)&&this.child===child)void this.stopQualifiedExecution(child,spec.id,new RuntimeError('MODEL_PROFILE_MISMATCH','The app-owned recurrent checkpoint exceeded its bound or changed its admitted layout.'));this.lastLog=(this.lastLog+text).slice(-8000);if(ssd&&!qwenNativeLog){this.captureSSDStatus(text);}if(experimental){this.memoryLog?.push(text);this.updateTrial({...this.memoryLog?.values(this.status.experimentalTrial?.state==='calibrating'||this.status.experimentalTrial?.state==='passed')});}this.emit('log',text.replaceAll(this.apiKey,'[internal token]'));});
    const cancel=()=>child.kill('SIGTERM');signal.addEventListener('abort',cancel,{once:true});
    const loadingMs=ssd?(this.settings.ssdLoadTimeoutMs??1800000):experimental?(this.settings.experimentalLoadTimeoutMs??600000):(this.settings.startupTimeoutMs??180000),loadingController=new AbortController(),loadingSignal=AbortSignal.any([signal,loadingController.signal]);
    const loadingTimer=setTimeout(()=>loadingController.abort(),loadingMs);
    let qualifiedCalibrationDeadline:AbortSignal|undefined;
    try{const deadline=Date.now()+loadingMs;let healthy=false;
      while(Date.now()<deadline){throwIfAborted(loadingSignal);if(launch.error||this.child!==child||child.exitCode!==null||child.signalCode!==null)throw new RuntimeError(/address already in use/i.test(this.lastLog)?'PORT_IN_USE':isAllocationFailure(this.lastLog)?'ALLOCATION_FAILED':'MODEL_LOAD_FAILED',launch.error?.message??(this.lastLog.slice(-4000)||'The inference engine stopped before readiness.'));
        try{const health=await this.requestJson<{status:string}>('/health',undefined,loadingSignal,1500);if(health.status==='ok'){healthy=true;break;}}catch(error){if(loadingSignal.aborted)throw error;}
        await new Promise(resolve=>setTimeout(resolve,100));}
      if(!healthy)throw new RuntimeError(experimental?'EXPERIMENTAL_LOAD_TIMEOUT':'MODEL_LOAD_TIMEOUT','The model did not become ready in time.');
      await new Promise(resolve=>setTimeout(resolve,100));throwIfAborted(loadingSignal);if(this.child!==child||child.exitCode!==null||child.signalCode!==null)throw new RuntimeError('MODEL_LOAD_FAILED',this.lastLog.slice(-2000));
      const props=await this.requestJson<{total_slots:number;default_generation_settings:{n_ctx:number;n_predict?:number};build_info:string;ui:boolean;cors_proxy_enabled:boolean;chat_template_caps:Record<string,unknown>}>('/props',undefined,loadingSignal);
      const actualContext=props.default_generation_settings?.n_ctx;
      if(usesQualifiedProfiles(spec.id)&&actualContext!==profile.contextTokens)throw new RuntimeError('MODEL_PROFILE_MISMATCH','The engine reduced the requested coding context. The next explicit profile must be calibrated before use.');
      if(props.total_slots!==1||!Number.isInteger(actualContext)||actualContext<512||actualContext>profile.contextTokens||props.ui!==false||props.cors_proxy_enabled!==false||!String(props.build_info).includes('d812350'))throw new RuntimeError('INVALID_ENGINE_PROPERTIES','The local service did not confirm the app-owned bounded engine configuration.');
      if(this.nativeMemoryPlan)await this.assertNativeModelUnchanged(this.nativeMemoryPlan);
      if(this.portableMemoryPlan)await this.assertNativeModelUnchanged(this.portableMemoryPlan);
      // Pinned /props exposes n_ctx and params, not the CLI --predict limit.
      // Output1024 is bound by our owned argv/profile and request gateway. Never
      // substitute nested default params.n_predict (-1) for a native cap proof.
      if(portable&&props.default_generation_settings.n_predict!==undefined&&props.default_generation_settings.n_predict!==profile.outputTokens)throw new RuntimeError('MODEL_PROFILE_MISMATCH','The service reported an output budget conflicting with the owned portable profile.');
      if(portableProfileLog&&!portableProfileLog.matches({contextTokens:actualContext,outputTokensFromOwnedArguments:Number(args[args.indexOf('--predict')+1]),slots:props.total_slots,maximumMappedBytes:this.portableMemoryPlan!.modelBytes}))throw new RuntimeError('MODEL_PROFILE_MISMATCH','Native startup did not confirm the CPU-only4K/F16/4-thread profile or its bound owned output arguments. No task readiness was established.');
      if(nativeProfileLog&&!nativeProfileLog.matches(profile,this.nativeMemoryPlan?.mappedPlacement))throw new RuntimeError('MODEL_PROFILE_MISMATCH','Native initialization did not confirm the planned K/V precision, flash attention, any explicit mixed weight placement and Metal residency setting.');
      if(this.nativeMemoryPlan)this.update({preparationStage:'probing'});
      if(ssd&&actualContext!==ssdProfileContract(spec).profile.contextTokens)throw new RuntimeError('SSD_PARITY_UNVERIFIED','The SSD worker did not confirm the exact context covered by its model-bound numerical report.');
      if(qwenNativeLog&&!qwenNativeLog.confirmed(props))throw new RuntimeError('SSD_PARITY_UNVERIFIED','Current native startup and service properties did not confirm exact Qwen8K unified F16 layout with zero rollback and checkpoints.');
      clearTimeout(loadingTimer);
      const outputTokens=Math.min(profile.outputTokens,Math.max(64,Math.floor(actualContext/4)));
      if(actualContext!==profile.contextTokens)this.update({profile:{...profile,contextTokens:actualContext,outputTokens}});
      // A supported imported template is eligible for an actual calibration,
      // never trusted merely because its architecture can represent tools.
      const toolEligible=props.chat_template_caps?.supports_tool_calls===true&&(spec.toolCapable||modelArchitectureAllowsTools(spec));
      let toolCapable=this.settings.skipCalibration?props.chat_template_caps?.supports_tool_calls===true&&(this.toolsPassed.get(spec.id)??spec.toolCapable):toolEligible;
      let measuredTokensPerSecond:number|undefined;
      if(experimental){
        this.updateTrial({state:'calibrating',profileSignature:this.status.profileSignature!,...(ssd?{progress:{stage:'probing' as const,message:'Running local Chat and tool-format probes.'}}:{}),...this.memoryLog?.values(true)});
        if(ssd){const streaming=validateSSDStreamingStatus(await this.requestJson<SSDStreamingStatus>('/ssd/status',undefined,signal,3000),this.ssdBinding!);this.ssdStatus=streaming;this.updateTrial({streaming});if(exactQwen80Source(spec))await this.checkQwen80SSDRequestResources(child,this.status.experimentalTrial!.id,spec);}
        const calibrationMs=ssd?(this.settings.ssdCalibrationTimeoutMs??1800000):(this.settings.experimentalCalibrationTimeoutMs??300000),calibrationDeadline=AbortSignal.timeout(calibrationMs),probeSignal=AbortSignal.any([signal,calibrationDeadline]);
        try{
          measuredTokensPerSecond=await this.measureChat(alias,probeSignal,calibrationMs,true);
          toolCapable=props.chat_template_caps?.supports_tool_calls===true&&(spec.toolCapable||modelArchitectureAllowsTools(spec));
          if(toolCapable){try{const speed=await this.calibrate(alias,probeSignal,calibrationMs);if(speed!==undefined)measuredTokensPerSecond=speed;}catch(error){if(probeSignal.aborted||isAllocationFailure(error))throw error;toolCapable=false;this.emit('log','Experimental model tool validation failed; the successfully probed model remains chat-only.\n');}}
          this.toolsPassed.set(spec.id,toolCapable);
        }catch(error){if(calibrationDeadline.aborted&&!signal.aborted)throw new RuntimeError('EXPERIMENTAL_CALIBRATION_TIMEOUT',ssd?'The SSD Chat and tool probes exceeded their shared thirty-minute deadline.':'The experimental chat and tool probes exceeded their shared five-minute deadline.',{cause:error});throw error;}
      }
      qualifiedCalibrationDeadline=usesQualifiedProfiles(spec.id)||portable?AbortSignal.timeout(300000):undefined;
      const qualifiedProbeSignal=qualifiedCalibrationDeadline?AbortSignal.any([signal,qualifiedCalibrationDeadline]):signal;
      if(!experimental&&(usesQualifiedProfiles(spec.id)||portable)&&!this.settings.skipCalibration)measuredTokensPerSecond=await this.measureChat(alias,qualifiedProbeSignal,300000,true);
      if(!experimental&&toolCapable&&!this.settings.skipCalibration){try{measuredTokensPerSecond=await this.calibrate(alias,qualifiedProbeSignal,usesQualifiedProfiles(spec.id)||portable?300000:120000);this.toolsPassed.set(spec.id,true);}catch(error){if(qualifiedProbeSignal.aborted||isAllocationFailure(error))throw error;toolCapable=false;this.toolsPassed.set(spec.id,false);this.emit('log','Tool calibration did not pass; this model remains available for chat with tools disabled.\n');}}
      if(!experimental&&!usesQualifiedProfiles(spec.id)&&!portable&&!toolCapable&&!this.settings.skipCalibration){try{measuredTokensPerSecond=await this.measureChat(alias,signal);}catch(error){if(signal.aborted||isAllocationFailure(error))throw error;this.emit('log','Chat speed measurement unavailable; this model remains chat-only.\n');}}
      if(!toolCapable)this.toolsPassed.set(spec.id,false);if((this.nativeMemoryPlan||this.portableMemoryPlan)&&!toolCapable)throw new RuntimeError('MODEL_CALIBRATION_FAILED','The planned coding profile did not pass its exact tool call and real tool-result continuation. No readiness was established.');
      let calibrationMeasurements:ResourceMeasurements|undefined;
      if(portable||usesQualifiedProfiles(spec.id)&&(!this.settings.hardware||this.settings.resourceProbe)){
        calibrationMeasurements=await this.checkQualifiedResources(child);throwIfAborted(signal);
      }
      if(profile.recurrentCheckpoint&&(!nativeProfileLog?.matches(profile,this.nativeMemoryPlan?.mappedPlacement)||!nativeProfileLog.checkpointBoundsValid(profile,!this.settings.skipCalibration)))throw new RuntimeError('MODEL_PROFILE_MISMATCH','Fixed calibration did not confirm the bounded one-checkpoint recurrent allocation.');
      const record=this.verification.get(spec.id);if(record){record.verified.toolCapable=toolCapable;record.verified.capabilities=toolCapable?['completion','tools']:['completion'];}
      if(measuredTokensPerSecond!==undefined)this.measurements.set(spec.id,measuredTokensPerSecond);
      const evidence={digest:verified.digest,templateHash:verified.templateHash,runtime:this.status.engineIdentity??ENGINE_COMMIT,profileSignature:this.status.profileSignature??undefined};
      const previousProbe=this.modelProbes.get(spec.id),sameProbe=(probe:ModelProbeEvidence|undefined)=>probe?.digest===evidence.digest&&probe?.templateHash===evidence.templateHash&&probe?.runtime===evidence.runtime&&probe?.profileSignature===evidence.profileSignature;
      const chatStatus=experimental?'passed':this.chatProbeResults.has(alias)?this.chatProbeResults.get(alias)?'passed':'failed':'unverified';
      this.modelProbes.set(spec.id,{chat:{...(chatStatus!=='unverified'&&sameProbe(previousProbe?.chat)?previousProbe?.chat:{}),...evidence,status:chatStatus},tool:{...(sameProbe(previousProbe?.tool)?previousProbe?.tool:{}),...evidence,status:toolCapable?'passed':'failed'}});
      return {...verified,...(usesQualifiedProfiles(spec.id)||exactQwen80Source(spec)?{generationPolicy:generationPolicyForModel(spec.id)}:{}),...(calibrationMeasurements?{calibrationMeasurements}:{}),...(this.nativeMemoryPlan?{nativeMemoryPlan:this.nativeMemoryPlan}:{}),...(this.portableMemoryPlan?{portableMemoryPlan:this.portableMemoryPlan}:{}),engineIdentity:this.status.engineIdentity??ENGINE_COMMIT,executionRoute:this.status.memoryMode==='ssd-experts'?'ssd-experts':'normal',capabilities:toolCapable?['completion','tools']:['completion'],model:alias,sourceModel:spec.id,baseUrl:this.status.baseUrl!,apiKey:this.apiKey,contextTokens:actualContext,outputTokens,toolCapable,measuredTokensPerSecond,memoryMode:this.status.memoryMode??'automatic',profileSignature:this.status.profileSignature??inferenceProfileSignature({...profile,contextTokens:actualContext,outputTokens},this.status.memoryMode??'automatic')};
    }catch(error){if(this.qualifiedResourceFailure&&(usesQualifiedProfiles(spec.id)||portable))throw this.qualifiedResourceFailure;if(qualifiedCalibrationDeadline?.aborted&&!signal.aborted)throw new RuntimeError('MODEL_CALIBRATION_TIMEOUT','The fixed Chat and tool-result checks exceeded their shared five-minute deadline. No task readiness was established.',{cause:error});if(loadingController.signal.aborted&&!signal.aborted)throw new RuntimeError(experimental?'EXPERIMENTAL_LOAD_TIMEOUT':'MODEL_LOAD_TIMEOUT','The model did not become ready in time.',{cause:error});throw error;}
    finally{clearTimeout(loadingTimer);signal.removeEventListener('abort',cancel);await rm(authFile,{force:true});}
  }
  private probeBinding(modelAlias:string):FixedProbeDiagnostic['binding']{
    const source=this.catalog().find(spec=>`local-agent-${spec.id.replace(/[^a-z0-9]/g,'-')}`===modelAlias)?.id??this.prepared?.sourceModel??modelAlias,verified=this.verification.get(source)?.verified,trial=this.status.experimentalTrial;
    return {model:source,digest:verified?.digest,templateHash:verified?.templateHash,runtime:this.status.engineIdentity,profileSignature:this.status.profileSignature??undefined,...(trial?.model===source&&this.status.memoryMode==='ssd-experts'?{trialId:trial.id}:{})};
  }
  private recordFixedProbe(probe:FixedProbeDiagnostic,ownedChild:ChildProcess|null):void{
    if(this.child!==ownedChild||probe.binding.trialId&&this.status.experimentalTrial?.id!==probe.binding.trialId)return;
    const binding=probe.binding,previous=this.modelProbes.get(binding.model),entry:ModelProbeEvidence={status:probe.passed?'passed':'failed',digest:binding.digest,templateHash:binding.templateHash,runtime:binding.runtime,profileSignature:binding.profileSignature,diagnostic:probe,...(!probe.passed?{detail:probeFailureDetail(probe)}:{})};
    this.modelProbes.set(binding.model,{chat:probe.kind==='chat'?entry:previous?.chat??{status:'unverified'},tool:probe.kind==='tools'?entry:previous?.tool??{status:'unverified'}});
    const trial=this.status.experimentalTrial;if(trial?.model===binding.model&&trial.profileSignature===binding.profileSignature)this.updateTrial({probes:{...trial.probes,[probe.kind]:probe}});
    this.emit('probe-diagnostic',structuredClone(probe));
  }
  private async calibrate(model:string,signal:AbortSignal,timeoutMs=120000):Promise<number|undefined>{
    const tool={type:'function',function:{name:'local_probe',description:'Return the supplied word.',parameters:{type:'object',properties:{word:{type:'string'}},required:['word'],additionalProperties:false}}};
    const binding=this.probeBinding(model),policy=generationPolicyForModel(binding.model),qualified=policy.kind!=='default'||isPortableModel(this.spec(binding.model),this.status.hardware),owned=this.child;
    const body={model,messages:[{role:'user',content:qualified?'Call local_probe with word OK. After its result, reply with exactly OK and no other text.':'Call local_probe with word OK.'}],tools:[tool],tool_choice:'required',parallel_tool_calls:false,max_tokens:qualified?(this.status.profile?.outputTokens??4096):96,...modelGenerationOptions(policy,'probe'),cache_prompt:false};
    await this.requestJson('/v1/chat/completions/input_tokens',body,signal);
    const result=await this.requestJson<FixedProbeResponse>('/v1/chat/completions',body,signal,timeoutMs);
    const message=result.choices?.[0]?.message,toolCalls=message?.tool_calls,call=toolCalls?.[0]?.function;let argumentsValid=false;try{const args=typeof call?.arguments==='string'?JSON.parse(call.arguments):null;argumentsValid=args?.word==='OK'&&(!qualified||Object.keys(args).length===1);}catch{}
    let passed=call?.name==='local_probe'&&argumentsValid&&(!qualified||toolCalls?.length===1&&typeof toolCalls[0].id==='string'&&Boolean(toolCalls[0].id)&&result.choices?.[0]?.finish_reason!=='length');
    let continuationDetail='';
    if(passed&&qualified){const continuation={...body,tools:undefined,tool_choice:'none',messages:[...body.messages,{role:'assistant',...message},{role:'tool',tool_call_id:toolCalls![0].id,content:'OK'}]};
      await this.requestJson('/v1/chat/completions/input_tokens',continuation,signal);
      const reply=await this.requestJson<FixedProbeResponse>('/v1/chat/completions',continuation,signal,timeoutMs),final=reply.choices?.[0];
      passed=typeof final?.message?.content==='string'&&final.message.content.trim()==='OK'&&!final.message.tool_calls?.length&&final.finish_reason!=='length';
      if(!passed)continuationDetail=` Tool-result continuation failed: ${probeFailureDetail(fixedProbeDiagnostic('chat',reply,body.max_tokens,false,binding,!policy.alwaysThinking))}`;
    }
    const probe=fixedProbeDiagnostic('tools',result,body.max_tokens,passed,binding,!policy.alwaysThinking);this.recordFixedProbe(probe,owned);
    if(!passed)throw new RuntimeError('MODEL_CALIBRATION_FAILED',`The model did not pass its exact local tool-call probe; tools remain disabled. ${probeFailureDetail(probe)}${continuationDetail}`);
    const speed=result.timings?.predicted_per_second;return typeof speed==='number'&&Number.isFinite(speed)&&speed>0?speed:undefined;
  }
  private async measureChat(model:string,signal:AbortSignal,timeoutMs=120000,requireProbe=false):Promise<number|undefined>{
    const binding=this.probeBinding(model),policy=generationPolicyForModel(binding.model),owned=this.child;
    const body={model,messages:[{role:'user',content:'Reply with exactly the two letters OK. Do not include punctuation, formatting, or any other text.'}],max_tokens:policy.kind==='default'?16:(this.status.profile?.outputTokens??4096),...modelGenerationOptions(policy,'probe'),cache_prompt:false};
    await this.requestJson('/v1/chat/completions/input_tokens',body,signal);
    const result=await this.requestJson<FixedProbeResponse>('/v1/chat/completions',body,signal,timeoutMs),choice=result.choices?.[0],content=choice?.message?.content,passed=typeof content==='string'&&content.trim()==='OK'&&(policy.kind==='default'||choice?.finish_reason!=='length'&&!choice?.message?.tool_calls?.length);
    this.chatProbeResults.set(model,passed);const probe=fixedProbeDiagnostic('chat',result,body.max_tokens,passed,binding,!policy.alwaysThinking);this.recordFixedProbe(probe,owned);
    if(requireProbe&&!passed)throw new RuntimeError('EXPERIMENTAL_CHAT_PROBE_FAILED',`The experimental model did not return exactly OK in its fixed local Chat probe. ${probeFailureDetail(probe)}`);
    const speed=result.timings?.predicted_per_second;return typeof content==='string'&&typeof speed==='number'&&Number.isFinite(speed)&&speed>0?speed:undefined;
  }
  calibrateModel(model:string,options:{signal?:AbortSignal}={}):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(options.signal);const spec=this.spec(model);
    if(model.startsWith('import:')&&!modelArchitectureAllowsTools(spec)){this.toolsPassed.set(model,false);this.emit('log','This imported architecture remains chat-only; checking local chat speed without enabling agent tools.\n');return this.prepareModel(model,options);}
    const controller=new AbortController();this.calibrationController=controller;const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const loading=this.prepareModel(model,{signal});this.calibrationPromise=(async()=>{const prepared=await loading;throwIfAborted(signal);const owned=this.child;if(!owned||this.stopPromise)throw abortError();
    try{const props=await this.requestJson<{chat_template_caps?:{supports_tool_calls?:boolean}}>('/props',undefined,signal);
    if(props.chat_template_caps?.supports_tool_calls!==true)throw new RuntimeError('MODEL_TOOL_TEMPLATE_UNSUPPORTED','This model template does not support native tool calls. Chat remains available.');
    const qualified=usesQualifiedProfiles(model),probeSignal=qualified?AbortSignal.any([signal,AbortSignal.timeout(300000)]):signal;const speed=await this.calibrate(prepared.model,probeSignal,qualified?300000:120000);throwIfAborted(probeSignal);if(this.child!==owned||this.prepared?.sourceModel!==model||this.stopPromise)throw abortError();this.toolsPassed.set(model,true);if(speed)this.measurements.set(model,speed);const record=this.verification.get(model);if(record){record.verified.toolCapable=true;record.verified.capabilities=['completion','tools'];}this.prepared={...prepared,toolCapable:true,capabilities:['completion','tools'],measuredTokensPerSecond:speed};this.modelProbes.set(model,{chat:this.modelProbes.get(model)?.chat??{status:'unverified'},tool:{...this.modelProbes.get(model)?.tool,status:'passed',digest:prepared.digest,templateHash:prepared.templateHash,runtime:prepared.engineIdentity,profileSignature:prepared.profileSignature}});this.syncExperimentalToolProbe(this.prepared,true);return {...this.prepared};}
    catch(error){if(!signal.aborted){this.toolsPassed.set(model,false);if(this.prepared)this.prepared={...this.prepared,toolCapable:false,capabilities:['completion']};this.modelProbes.set(model,{chat:this.modelProbes.get(model)?.chat??{status:'unverified'},tool:{...this.modelProbes.get(model)?.tool,status:'failed',digest:prepared.digest,templateHash:prepared.templateHash,runtime:prepared.engineIdentity,profileSignature:prepared.profileSignature}});this.syncExperimentalToolProbe(prepared,false);const record=this.verification.get(model);if(record){record.verified.toolCapable=false;record.verified.capabilities=['completion'];}}throw error;}
    })().finally(()=>{this.calibrationPromise=null;this.calibrationController=null;});return this.calibrationPromise;
  }
  async restartLowerProfile(signal?:AbortSignal):Promise<PreparedModel>{
    this.assertIdle();throwIfAborted(signal);if(!this.prepared)throw new RuntimeError('MODEL_NOT_LOADED','Load a verified model before changing its profile.');
    if(['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic'))throw new RuntimeError('EXPERIMENTAL_RECOVERY_DISABLED','Experimental disk mode does not restart inference automatically. Run a new explicit trial after reviewing the failure.');
    if(this.profileIndex>=this.profiles(this.spec(this.prepared.sourceModel)).length-1)throw new RuntimeError('PROFILE_EXHAUSTED','The smallest bounded profile is already in use.');const model=this.prepared.sourceModel;this.profileIndex++;const controller=new AbortController();this.loadController=controller;const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    this.preparePromise=this.prepareInternal(model,combined,false).finally(()=>{this.preparePromise=null;this.loadController=null;});return this.preparePromise;
  }
  async requestStream(pathname:string,body:object,signal?:AbortSignal):Promise<Response>{return this.request(pathname,body,signal,pathname==='/v1/chat/completions'?(this.settings.requestTimeoutMs??this.executionRequestTimeoutMs):15000);}
  async requestJson<T=Record<string,unknown>>(pathname:string,body?:object,signal?:AbortSignal,timeoutMs?:number):Promise<T>{return (await this.request(pathname,body,signal,timeoutMs)).json() as Promise<T>;}
  private async request(pathname:string,body?:object,signal?:AbortSignal,timeoutMs=pathname==='/v1/chat/completions'?(this.settings.requestTimeoutMs??this.executionRequestTimeoutMs):15000):Promise<Response>{
    throwIfAborted(signal);if(!this.child||!this.status.baseUrl||!this.apiKey)throw new RuntimeError('RUNTIME_NOT_READY','Load a local model first.');
    if(pathname==='/v1/chat/completions'&&this.remainingExecutionMs){const remaining=Math.floor(this.remainingExecutionMs());if(!Number.isSafeInteger(remaining)||remaining<=0)throw new RuntimeError('EXECUTION_TIMEOUT','The active execution deadline expired before local inference. Continue explicitly from retained evidence.');timeoutMs=Math.min(timeoutMs,remaining);}
    const ownedChild=this.child,ownedTrialId=this.status.experimentalTrial?.id,ssdInference=pathname==='/v1/chat/completions'&&this.status.memoryMode==='ssd-experts';
    if(pathname==='/v1/chat/completions'&&this.prepared&&(this.portableMemoryPlan||usesQualifiedProfiles(this.prepared.sourceModel)&&(!this.settings.hardware||this.settings.resourceProbe))){
      const model=this.prepared.sourceModel;try{const sample=await this.checkQualifiedResources(ownedChild);if(this.child===ownedChild&&this.prepared?.sourceModel===model)this.prepared={...this.prepared,calibrationMeasurements:sample};}catch(error){await this.stopQualifiedExecution(ownedChild,model,error);throw error;}
    }
    if(ssdInference){const spec=this.spec(this.status.experimentalTrial!.model);if(exactQwen80Source(spec)){if(!ownedTrialId)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The current Qwen80 SSD trial identity is unavailable.');await this.checkQwen80SSDRequestResources(ownedChild,ownedTrialId,spec);throwIfAborted(signal);}await this.request('/ssd/control',{deadlineMs:Math.min(28800000,timeoutMs)},signal,3000);}
    if(this.child!==ownedChild||ssdInference&&this.status.experimentalTrial?.id!==ownedTrialId)throw abortError();
    if(!/^\/[a-z0-9_\/-]+$/i.test(pathname))throw new RuntimeError('INVALID_INFERENCE_PATH','Use a local inference API path.');
    const signals=[signal,['experimental-disk','ssd-experts'].includes(this.status.memoryMode??'automatic')?this.trialController?.signal:undefined,timeoutMs>0?AbortSignal.timeout(timeoutMs):undefined].filter((v):v is AbortSignal=>Boolean(v));let response:Response;try{response=await (this.settings.fetch??loopbackFetch)(`${this.status.baseUrl}${pathname}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.apiKey}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:signals.length?AbortSignal.any(signals):undefined,redirect:'error',credentials:'omit'});}catch(error){if(ssdInference)await this.stopInterruptedSSDInference(ownedChild,ownedTrialId);throw error;}
    if(ssdInference&&response.body)response=this.ssdControlledResponse(response,ownedChild,ownedTrialId);
    if(!response.ok){const raw=(await response.text()).slice(0,4000);let message=raw;try{const error=JSON.parse(raw).error;message=typeof error==='string'?error:error?.message??raw;}catch{}throw new RuntimeError(isAllocationFailure(message)?'ALLOCATION_FAILED':'INFERENCE_API_ERROR',`Local inference HTTP ${response.status}: ${message}`);}return response;
  }
  private async stopInterruptedSSDInference(ownedChild:ChildProcess,ownedTrialId:string|undefined):Promise<void>{
    if(this.child!==ownedChild||this.status.experimentalTrial?.id!==ownedTrialId)return;
    // Abort pending tool approvals immediately, before any control or shutdown wait.
    this.notifyExecutionStopped('SSD_INFERENCE_INTERRUPTED','SSD inference was interrupted; pending actions must be cancelled.');
    await this.request('/ssd/control',{cancel:true},undefined,3000).catch(()=>{});
    if(this.child!==ownedChild||this.status.experimentalTrial?.id!==ownedTrialId)return;
    const failure=this.status.experimentalTrial?.state==='failed'?this.status.experimentalTrial.error:null;
    await this.terminateChild();if(this.status.experimentalTrial?.id!==ownedTrialId||this.child&&this.child!==ownedChild)return;this.prepared=null;if(!failure)this.updateTrial({state:'cancelled',probePassed:false,toolProbePassed:false,error:null,finishedAt:new Date().toISOString()});
    this.update({state:'ready',loadedModel:null,profile:null,error:failure});
  }
  private ssdControlledResponse(response:Response,ownedChild:ChildProcess,ownedTrialId:string|undefined):Response{
    const reader=response.body!.getReader();let settled=false;
    const settle=async(cancel:boolean)=>{
      if(settled)return;settled=true;if(this.child!==ownedChild||this.status.experimentalTrial?.id!==ownedTrialId)return;
      if(cancel){await this.stopInterruptedSSDInference(ownedChild,ownedTrialId);return;}
      try{await this.request('/ssd/control',{idle:true},undefined,3000);}
      catch(error){await this.stopInterruptedSSDInference(ownedChild,ownedTrialId);throw new RuntimeError('SSD_CONTROL_FAILED','The SSD worker did not settle its execution deadline after inference.',{cause:error});}
    };
    const body=new ReadableStream<Uint8Array>({
      pull:async controller=>{try{const value=await reader.read();if(value.done){await settle(false);controller.close();reader.releaseLock();}else controller.enqueue(value.value);}catch(error){await settle(true).catch(()=>{});controller.error(error);}},
      cancel:async reason=>{const settling=settle(true);await reader.cancel(reason).catch(()=>{});await settling;},
    });return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  stop():Promise<void>{if(this.stopPromise)return this.stopPromise;if(this.status.memoryMode==='ssd-experts')this.notifyExecutionStopped('SSD_STOPPED','The app-owned SSD runtime stopped.');for(const controller of this.integrityControllers)controller.abort();this.startController?.abort();this.loadController?.abort();this.calibrationController?.abort();this.trialController?.abort();this.stopResourceWatchdog();this.cancelPull();this.update({state:'stopping'});
    this.stopPromise=(async()=>{await this.terminateChild();await this.preparePromise?.catch(()=>{});await this.calibrationPromise?.catch(()=>{});await this.trialPromise?.catch(()=>{});await this.settingsPromise?.catch(()=>{});await this.startPromise?.catch(()=>{});await this.pullPromise?.catch(()=>{});await this.integrityWork;await this.terminateChild();this.prepared=null;this.nativeMemoryPlan=null;this.apiKey='';this.invalidateTrial();this.update({state:'stopped',baseUrl:null,loadedModel:null,profile:null,downloadingModel:null,error:null,engineIdentity:undefined});await this.historyReady;await this.historyWrites;})().finally(()=>{this.stopPromise=null;});return this.stopPromise;}
  private async terminateChild():Promise<void>{this.stopResourceWatchdog();this.portableMemoryPlan=null;const child=this.child,exited=this.childExit;if(!child||!exited){this.update({baseUrl:null});return;}this.suppressExit=true;child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{const graceful=await Promise.race([exited.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),this.settings.stopTimeoutMs??3000);})]);if(!graceful&&this.child===child){child.kill('SIGKILL');await exited;}}finally{if(timer)clearTimeout(timer);if(this.child===child)this.child=null;this.suppressExit=false;if(!this.child)this.update({baseUrl:null});}}
}
