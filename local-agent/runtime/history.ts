import {constants,type Stats} from 'node:fs';
import {lstat,mkdir,open,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExperimentalTrial,ResourceMeasurements} from './memory.ts';
import type {FixedProbeDiagnostic} from './probes.ts';

export const SSD_HISTORY_MAX_BYTES=1024**2;
export interface SSDTrialHistoryEntry {
  id:string;mode:'ssd-experts';model:string;state:ExperimentalTrial['state']|'incomplete';startedAt:string;finishedAt?:string;
  profileSignature:string;artifactSetDigest?:string;templateDigest?:string;engineDigest?:string;patchDigest?:string;
  parityReportDigest?:string;backendValidation?:ExperimentalTrial['backendValidation'];
  checks:{chat:'passed'|'failed'|'unverified';tools:'passed'|'failed'|'unverified'};
  error:{code:string;message:string}|null;progress?:ExperimentalTrial['progress'];probes?:ExperimentalTrial['probes'];
  resources?:{residentBudgetBytes:number|null;allocationBudgetBytes?:number;measurements?:ResourceMeasurements|null;streaming?:{expectedGroups:number;streamedGroups:number;cacheSlotsPerLayer:number;expertCacheBytes:number;bytesRead?:number;cacheMisses?:number;waves?:number;cpuKernel?:'unknown'|'standard'|'default';useExtraBufts?:boolean|null;cpuRepackTensorCount?:number|null;decodeThreads?:number|null;batchThreads?:number|null}};
}
export interface SSDTrialHistoryError {code:string;message:string;}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const timestamp=(value:unknown)=>text(value,64)&&Number.isFinite(Date.parse(value as string));
const optionalDigest=(value:unknown)=>value===undefined||typeof value==='string'&&sha.test(value);
const keys=(value:unknown,allowed:string[])=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key)));
function validProbe(probe:FixedProbeDiagnostic|undefined,entry:SSDTrialHistoryEntry,kind:'chat'|'tools'):boolean{
  if(probe===undefined)return true;const binding=probe?.binding;
  return Boolean(keys(probe,['kind','passed','requestedOutputTokens','thinkingDisabled','finishReason','content','reasoning','outputTokens','reasoningTokens','toolCalls','toolCallCount','truncated','binding'])&&probe.kind===kind&&typeof probe.passed==='boolean'&&integer(probe.requestedOutputTokens)&&probe.requestedOutputTokens>=1&&probe.requestedOutputTokens<=1024&&probe.thinkingDisabled===true&&[probe.finishReason,probe.content,probe.reasoning].every((v,i)=>v===null||text(v,i===0?64:512))&&[probe.outputTokens,probe.reasoningTokens].every(v=>v===null||integer(v))&&integer(probe.toolCallCount)&&probe.toolCallCount<=128&&Array.isArray(probe.toolCalls)&&probe.toolCalls.length<=2&&probe.toolCalls.length<=probe.toolCallCount&&probe.toolCalls.every(c=>keys(c,['name','arguments'])&&[c.name,c.arguments].every((v,i)=>v===null||text(v,i===0?128:512)))&&typeof probe.truncated==='boolean'&&keys(binding,['model','digest','templateHash','runtime','profileSignature','trialId'])&&binding.model===entry.model&&binding.trialId===entry.id&&binding.digest===entry.artifactSetDigest&&binding.templateHash===entry.templateDigest&&binding.runtime===entry.engineDigest&&binding.profileSignature===entry.profileSignature);
}
function validEntry(value:unknown):value is SSDTrialHistoryEntry{
  const e=value as SSDTrialHistoryEntry,r=e?.resources,m=r?.measurements,s=r?.streaming;
  if(!keys(e,['id','mode','model','state','startedAt','finishedAt','profileSignature','artifactSetDigest','templateDigest','engineDigest','patchDigest','parityReportDigest','backendValidation','checks','error','progress','probes','resources'])||!text(e.id,36)||!uuid.test(e.id)||e.mode!=='ssd-experts'||!text(e.model,256)||!e.model||!['loading','calibrating','passed','failed','cancelled','stopped','incomplete'].includes(e.state)||!timestamp(e.startedAt)||e.finishedAt!==undefined&&!timestamp(e.finishedAt)||!text(e.profileSignature,8192)||![e.artifactSetDigest,e.templateDigest,e.engineDigest,e.patchDigest,e.parityReportDigest].every(optionalDigest)||e.backendValidation!==undefined&&!['cpu-baseline','validated','qa-unvalidated'].includes(e.backendValidation)||!keys(e.checks,['chat','tools'])||!['passed','failed','unverified'].includes(e.checks.chat)||!['passed','failed','unverified'].includes(e.checks.tools)||e.error!==null&&(!keys(e.error,['code','message'])||!text(e.error.code,128)||!text(e.error.message,4096)))return false;
  if(e.progress!==undefined&&(!keys(e.progress,['stage','message','completedBytes','totalBytes'])||!['verifying','planning','loading','probing'].includes(e.progress.stage)||e.progress.message!==undefined&&!text(e.progress.message,512)||[e.progress.completedBytes,e.progress.totalBytes].some(v=>v!==undefined&&!integer(v))||e.progress.completedBytes!==undefined&&e.progress.totalBytes!==undefined&&e.progress.completedBytes>e.progress.totalBytes))return false;
  if(e.probes!==undefined&&!keys(e.probes,['chat','tools']))return false;
  if(!validProbe(e.probes?.chat,e,'chat')||!validProbe(e.probes?.tools,e,'tools'))return false;
  for(const kind of ['chat','tools'] as const){const probe=e.probes?.[kind];if(e.checks[kind]!==(!probe?'unverified':probe.passed?'passed':'failed'))return false;}
  if(r!==undefined&&(!keys(r,['residentBudgetBytes','allocationBudgetBytes','measurements','streaming'])||r.residentBudgetBytes!==null&&!integer(r.residentBudgetBytes)||r.allocationBudgetBytes!==undefined&&!integer(r.allocationBudgetBytes)))return false;
  if(m&&(!keys(m,['sampledAt','residentBytes','availableMemoryBytes','pressure','rssBytes','physicalFootprintBytes'])||!timestamp(m.sampledAt)||!integer(m.residentBytes)||!integer(m.availableMemoryBytes)||!['normal','warning','critical'].includes(m.pressure)||m.rssBytes!==undefined&&!integer(m.rssBytes)||m.physicalFootprintBytes!==undefined&&m.physicalFootprintBytes!==null&&!integer(m.physicalFootprintBytes)))return false;
  if(s&&(!keys(s,['expectedGroups','streamedGroups','cacheSlotsPerLayer','expertCacheBytes','bytesRead','cacheMisses','waves','cpuKernel','useExtraBufts','cpuRepackTensorCount','decodeThreads','batchThreads'])||![s.expectedGroups,s.streamedGroups,s.cacheSlotsPerLayer,s.expertCacheBytes].every(integer)||[s.bytesRead,s.cacheMisses,s.waves].some(v=>v!==undefined&&!integer(v))||s.cpuKernel!==undefined&&!['unknown','standard','default'].includes(s.cpuKernel)||s.useExtraBufts!==undefined&&s.useExtraBufts!==null&&typeof s.useExtraBufts!=='boolean'||[s.cpuRepackTensorCount,s.decodeThreads,s.batchThreads].some(v=>v!==undefined&&v!==null&&(!integer(v)||v>1000000))))return false;
  return true;
}
export function trialHistoryEntry(trial:ExperimentalTrial):SSDTrialHistoryEntry|null{
  if(trial.mode!=='ssd-experts')return null;const probeStatus=(probe:FixedProbeDiagnostic|undefined)=>probe?probe.passed?'passed' as const:'failed' as const:'unverified' as const;
  const s=trial.streaming;
  return {id:trial.id,mode:'ssd-experts',model:trial.model,state:trial.state,startedAt:trial.startedAt,...(trial.finishedAt?{finishedAt:trial.finishedAt}:{}),profileSignature:trial.profileSignature,...(trial.artifactSetDigest?{artifactSetDigest:trial.artifactSetDigest}:{}),...(trial.templateDigest?{templateDigest:trial.templateDigest}:{}),...(trial.engineDigest?{engineDigest:trial.engineDigest}:{}),...(trial.patchDigest?{patchDigest:trial.patchDigest}:{}),...(trial.parityReportDigest?{parityReportDigest:trial.parityReportDigest}:{}),...(trial.backendValidation?{backendValidation:trial.backendValidation}:{}),checks:{chat:probeStatus(trial.probes?.chat),tools:probeStatus(trial.probes?.tools)},error:trial.error?{code:trial.error.code.slice(0,128),message:trial.error.message.slice(0,4096)}:null,...(trial.progress?{progress:structuredClone(trial.progress)}:{}),...(trial.probes?{probes:structuredClone(trial.probes)}:{}),resources:{residentBudgetBytes:trial.resourceBudgetBytes,...(trial.allocationBudgetBytes!==undefined?{allocationBudgetBytes:trial.allocationBudgetBytes}:{}),measurements:trial.measurements,...(s?{streaming:{expectedGroups:s.expectedGroups,streamedGroups:s.streamedGroups,cacheSlotsPerLayer:s.cacheSlotsPerLayer,expertCacheBytes:s.expertCacheBytes,...(s.bytesRead!==undefined?{bytesRead:s.bytesRead}:{}),...(s.cacheMisses!==undefined?{cacheMisses:s.cacheMisses}:{}),...(s.waves!==undefined?{waves:s.waves}:{}),...(s.cpuKernel!==undefined?{cpuKernel:s.cpuKernel}:{}),...(s.useExtraBufts!==undefined?{useExtraBufts:s.useExtraBufts}:{}),...(s.cpuRepackTensorCount!==undefined?{cpuRepackTensorCount:s.cpuRepackTensorCount}:{}),...(s.decodeThreads!==undefined?{decodeThreads:s.decodeThreads}:{}),...(s.batchThreads!==undefined?{batchThreads:s.batchThreads}:{})}}:{})}};
}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
/** Historical diagnostics only. This store has no activation, readiness or model-selection API. */
export class SSDTrialHistory {
  private entries:SSDTrialHistoryEntry[]=[];private queue:Promise<void>=Promise.resolve();private blocked=false;
  private directory:string;private limits:{maxEntries:number;maxBytes:number};
  error:SSDTrialHistoryError|null=null;
  readonly file:string;
  constructor(directory:string,limits={maxEntries:100,maxBytes:SSD_HISTORY_MAX_BYTES}){if(!path.isAbsolute(directory)||!Number.isSafeInteger(limits.maxEntries)||limits.maxEntries<1||limits.maxEntries>100||!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1024||limits.maxBytes>SSD_HISTORY_MAX_BYTES)throw new Error('Use a private absolute history directory and bounded storage.');this.directory=directory;this.limits=limits;this.file=path.join(directory,'ssd-trial-history.json');}
  snapshot():SSDTrialHistoryEntry[]{return structuredClone(this.entries);}
  private fail(code:string,message:string){this.error={code,message};}
  private async inspectFile():Promise<Stats|null>{try{const s=await lstat(this.file);if(!s.isFile()||s.isSymbolicLink()||s.size>this.limits.maxBytes||process.platform!=='win32'&&(s.mode&0o077)!==0)throw new Error('Historical diagnostics must be a bounded private regular file.');return s;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  async load():Promise<void>{
    await this.queue;this.error=null;this.blocked=false;this.entries=[];let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{const before=await this.inspectFile();if(!before)return;handle=await open(this.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));if(!same(before,await handle.stat()))throw new Error('History changed before reading.');
      const buffer=Buffer.alloc(before.size+1);let read=0;while(read<buffer.length){const result=await handle.read(buffer,read,buffer.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}if(read!==before.size||!same(before,await handle.stat()))throw new Error('History changed during reading.');
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,read))) as {schemaVersion:number;entries:unknown[]};if(!keys(data,['schemaVersion','entries'])||data?.schemaVersion!==1||!Array.isArray(data.entries)||data.entries.length>this.limits.maxEntries||!data.entries.every(validEntry)||new Set(data.entries.map(e=>(e as SSDTrialHistoryEntry).id)).size!==data.entries.length)throw new Error('Invalid historical diagnostic schema.');
      this.entries=(data.entries as SSDTrialHistoryEntry[]).map(entry=>['loading','calibrating'].includes(entry.state)?{...entry,state:'incomplete',finishedAt:new Date().toISOString(),error:{code:'SSD_TRIAL_INTERRUPTED',message:'The app closed before this trial finished. Recorded evidence is historical; preparation requires a new explicit attempt.'}}:entry);
      if(data.entries.some(entry=>['loading','calibrating'].includes((entry as SSDTrialHistoryEntry).state)))await this.save();
    }catch{this.blocked=true;this.fail('SSD_HISTORY_UNAVAILABLE','Historical trial diagnostics could not be read safely and were left unchanged. Inference and model activation do not use this file.');}
    finally{await handle?.close().catch(()=>{});}
  }
  record(trial:ExperimentalTrial):Promise<void>{
    const entry=trialHistoryEntry(trial);if(!entry)return Promise.resolve();if(!validEntry(entry)){this.fail('SSD_HISTORY_INVALID','The trial diagnostics did not match the bounded history schema.');return Promise.resolve();}
    this.entries=[entry,...this.entries.filter(previous=>previous.id!==entry.id)].slice(0,this.limits.maxEntries);
    return this.save();
  }
  private save():Promise<void>{
    let serialized=JSON.stringify({schemaVersion:1,entries:this.entries});while(Buffer.byteLength(serialized)>this.limits.maxBytes&&this.entries.length>1){this.entries.pop();serialized=JSON.stringify({schemaVersion:1,entries:this.entries});}
    if(Buffer.byteLength(serialized)>this.limits.maxBytes){this.fail('SSD_HISTORY_INVALID','The bounded trial diagnostic exceeds its history storage limit.');return Promise.resolve();}
    const work=this.queue.then(async()=>{if(this.blocked)return;const temp=this.file+'.'+randomUUID()+'.tmp';let handle:Awaited<ReturnType<typeof open>>|undefined;
      try{await mkdir(this.directory,{recursive:true,mode:0o700});await this.inspectFile();handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);await handle.writeFile(serialized,'utf8');await handle.sync();await handle.close();handle=undefined;await this.inspectFile();await rename(temp,this.file);this.error=null;}
      catch{this.fail('SSD_HISTORY_UNAVAILABLE','Historical trial diagnostics could not be saved. Check the profile folder permissions and available storage.');}
      finally{await handle?.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
    });this.queue=work.catch(()=>{});return work;
  }
  async drain():Promise<void>{await this.queue;}
}
