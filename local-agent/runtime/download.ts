import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {modelArtifacts,type CuratedModel,type ModelArtifact} from './catalog.ts';
import { abortError, RuntimeError, throwIfAborted } from './errors.ts';
import { sha256File, readGGUFMetadata, validateGGUFModelSet } from './gguf.ts';
export interface PullProgress {model:string;status:string;digest?:string;total?:number;completed?:number;percent?:number;artifact?:string;artifactIndex?:number;artifactCount?:number;retryAttempt?:number;}
export interface DownloadOptions {fetch?:typeof fetch;signal?:AbortSignal;onProgress?:(p:PullProgress)=>void;freeDiskBytes?:(directory:string)=>Promise<number|null>;
  /** Trusted bounded fixtures; the renderer cannot choose transfer limits. */
  rangeWindowBytes?:number;retryDelayMs?:number;maxConsecutiveRetries?:number;rangeTimeoutMs?:number;
  /** App-owned integrity reader; never supplied through renderer IPC. */
  hashFile?:(file:string,signal?:AbortSignal)=>Promise<string>;
}
const safeHost=(host:string)=>host==='huggingface.co'||host.endsWith('.huggingface.co')||host==='cdn-lfs.hf.co'||host.endsWith('.hf.co')||host.endsWith('.xethub.hf.co');
export async function fetchArtifact(url:string,init:RequestInit,fetcher:typeof fetch=fetch):Promise<Response>{
  for(let i=0;i<8;i++){const target=new URL(url);if(target.protocol!=='https:'||!safeHost(target.hostname)||target.username||target.password)throw new RuntimeError('INVALID_DOWNLOAD_HOST','The model download redirected outside its approved artifact hosts.');
    const response=await fetcher(target.href,{...init,redirect:'manual',credentials:'omit'});if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new RuntimeError('DOWNLOAD_FAILED','The model publisher returned a redirect without a destination.');url=new URL(location,target).href;
  }throw new RuntimeError('DOWNLOAD_FAILED','Too many model download redirects.');
}
async function downloadArtifact(spec:CuratedModel,artifact:ModelArtifact,directory:string,options:DownloadOptions={}):Promise<string>{
  const {signal}=options,artifacts=modelArtifacts(spec),artifactIndex=artifacts.findIndex(a=>a.filename===artifact.filename),metadataOptions=artifacts.length>1?{split:{index:artifactIndex,count:artifacts.length}}:{};throwIfAborted(signal);await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,artifact.filename),partial=`${file}.part`;
  // A previously completed shard remains reusable after interruption of another.
  try {const existing=await lstat(file);if(existing.isFile()&&!existing.isSymbolicLink()&&existing.size===artifact.sizeBytes&&await (options.hashFile??sha256File)(file,signal)===artifact.sha256){await readGGUFMetadata(file,signal,metadataOptions);return file;}}catch(error){if(signal?.aborted)throw abortError();if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof RuntimeError&&error.code==='INVALID_GGUF'))throw error;}
  const report=(status:string,completed?:number)=>options.onProgress?.({model:spec.id,status,total:artifact.sizeBytes,completed,percent:completed===undefined?undefined:Math.min(100,completed/artifact.sizeBytes*100)});
  let offset=0;try{const s=await lstat(partial);if(!s.isFile()||s.isSymbolicLink())throw new RuntimeError('INVALID_DOWNLOAD_FILE','The partial model download is not a regular file.');offset=s.size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(offset>artifact.sizeBytes){await rm(partial);offset=0;}
  const free=await options.freeDiskBytes?.(directory);if(free!==null&&free!==undefined&&free<artifact.sizeBytes-offset+512*1024**2)throw new RuntimeError('INSUFFICIENT_STORAGE','There is not enough free disk space for this model download.');
  const windowed=artifact.sizeBytes>=64*1024**2||options.rangeWindowBytes!==undefined;
  const windowBytes=options.rangeWindowBytes??32*1024**2;
  if(!Number.isSafeInteger(windowBytes)||windowBytes<1||windowBytes>32*1024**2)throw new RuntimeError('INVALID_DOWNLOAD_WINDOW','Use a bounded model transfer window.');
  const maximumRequests=(Math.ceil(artifact.sizeBytes/windowBytes)+1)*8;let requests=0,failures=0;
  const transient=new Set(['DOWNLOAD_INTERRUPTED','DOWNLOAD_RETRYABLE_HTTP']);
  const wait=async(ms:number)=>{throwIfAborted(signal);if(ms<=0)return;await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(abortError());},timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();});};
  while(offset<artifact.sizeBytes){
    throwIfAborted(signal);if(++requests>maximumRequests)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The publisher repeatedly returned very short ranges. Download paused with its pinned partial bytes preserved.');
    const before=offset,requestedEnd=windowed?Math.min(artifact.sizeBytes-1,offset+windowBytes-1):artifact.sizeBytes-1;
    const rangeDeadline=windowed?AbortSignal.timeout(options.rangeTimeoutMs??300000):undefined,requestSignal=rangeDeadline?signal?AbortSignal.any([signal,rangeDeadline]):rangeDeadline:signal;
    try{
      const url=`https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${(artifact.remotePath??artifact.filename).split('/').map(encodeURIComponent).join('/')}`;
      const headers:Record<string,string>=windowed?{Range:`bytes=${offset}-${requestedEnd}`,'Accept-Encoding':'identity'}:offset?{Range:`bytes=${offset}-`}:{};
      const response=await fetchArtifact(url,{headers,signal:requestSignal},options.fetch);
      if(response.status===401||response.status===403){await response.body?.cancel();throw new RuntimeError('MODEL_DOWNLOAD_UNAVAILABLE','The publisher did not provide public access to this pinned model file.');}
      if(response.status===408||response.status===429||response.status>=500){await response.body?.cancel();throw new RuntimeError('DOWNLOAD_RETRYABLE_HTTP',`The pinned model publisher returned HTTP ${response.status}.`);}
      if(response.status!==200&&response.status!==206){await response.body?.cancel();throw new RuntimeError('DOWNLOAD_FAILED',`The model download returned HTTP ${response.status}. Retry to resume.`);}
      let advertisedEnd=artifact.sizeBytes-1;
      if(response.status===206){const match=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);if(!match||Number(match[1])!==offset||Number(match[3])!==artifact.sizeBytes||Number(match[2])<offset||Number(match[2])>=artifact.sizeBytes){await response.body?.cancel();throw new RuntimeError('INVALID_DOWNLOAD_RANGE','The resumed model response does not match the expected byte range.');}advertisedEnd=Number(match[2]);}
      else if(windowed&&offset>0){await response.body?.cancel();throw new RuntimeError('INVALID_DOWNLOAD_RANGE','The publisher ignored the requested resume range. The existing pinned partial file was preserved.');}
      else offset=0;
      const encoding=response.headers.get('content-encoding');if(encoding&&encoding!=='identity'){await response.body?.cancel();throw new RuntimeError('INVALID_DOWNLOAD_RANGE','Compressed transfer encodings cannot safely resume exact model byte ranges.');}
      const contentLength=response.headers.get('content-length');if(contentLength!==null&&(!/^\d+$/.test(contentLength)||Number(contentLength)!==advertisedEnd-offset+1)){await response.body?.cancel();throw new RuntimeError('INVALID_DOWNLOAD_RANGE','The pinned range response has inconsistent byte-length headers.');}
      if(!response.body)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The model download returned no file data.');
      const end=windowed&&response.status===206?Math.min(requestedEnd,advertisedEnd):advertisedEnd;
      const handle=await open(partial,offset?'a':'w',0o600),reader=response.body.getReader();let lastReport=0;const cancel=()=>{void reader.cancel(requestSignal?.reason).catch(()=>{});};requestSignal?.addEventListener('abort',cancel,{once:true});
      try{
        report('downloading',offset);while(offset<=end){throwIfAborted(requestSignal);const {value,done}=await reader.read();if(done)break;const length=Math.min(value.length,end-offset+1);if(!windowed&&length<value.length)throw new RuntimeError('DOWNLOAD_SIZE_MISMATCH','The download exceeds its pinned size.');if(length){await handle.writeFile(value.subarray(0,length));offset+=length;}if(Date.now()-lastReport>150){report('downloading',offset);lastReport=Date.now();}}
        throwIfAborted(requestSignal);await handle.sync();
      }finally{requestSignal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();await handle.close();}
      if(offset<=end)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The pinned model response ended before its advertised range completed.');
      if(!windowed&&offset!==artifact.sizeBytes)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The model download was interrupted. Retry to resume its verified revision.');failures=0;
    }catch(error){
      if(signal?.aborted)throw abortError();if(['ENOSPC','EDQUOT','EACCES','EPERM','EROFS','EIO'].includes((error as NodeJS.ErrnoException)?.code??''))throw new RuntimeError('DOWNLOAD_STORAGE_FAILED','The model download could not write its partial file. Check available storage and folder permissions, then resume.',{cause:error});const retryable=windowed&&(error instanceof RuntimeError?transient.has(error.code):error instanceof TypeError||error instanceof Error&&['TimeoutError','AbortError'].includes(error.name));if(!retryable)throw error;
      failures=offset>before?0:failures+1;if(failures>(options.maxConsecutiveRetries??5))throw new RuntimeError('DOWNLOAD_INTERRUPTED','The pinned model download repeatedly disconnected. Its partial files were preserved for a later resume.',{cause:error});
      options.onProgress?.({model:spec.id,status:'retrying',total:artifact.sizeBytes,completed:offset,percent:offset/artifact.sizeBytes*100,retryAttempt:failures+1});
      await wait((options.retryDelayMs??500)*2**Math.min(failures,4));
    }
  }
  throwIfAborted(signal);if(offset!==artifact.sizeBytes)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The model download was interrupted. Retry to resume its verified revision.');
  report('verifying',offset);const digest=await (options.hashFile??sha256File)(partial,signal);if(digest!==artifact.sha256){await rm(partial,{force:true});throw new RuntimeError('MODEL_DIGEST_MISMATCH','The model SHA-256 does not match its pinned publisher artifact. Download it again.');}
  await readGGUFMetadata(partial,signal,metadataOptions);throwIfAborted(signal);await rename(partial,file);report('success',offset);return file;
}

/** A group is usable only after every pinned artifact is complete and verified. */
export async function downloadModel(spec:CuratedModel,directory:string,options:DownloadOptions={}):Promise<string>{
  throwIfAborted(options.signal);await mkdir(directory,{recursive:true,mode:0o700});const artifacts=modelArtifacts(spec);
  let retained=0;
  for(const artifact of artifacts){for(const suffix of ['', '.part']){try{const entry=await lstat(path.join(directory,artifact.filename+suffix));if(!entry.isFile()||entry.isSymbolicLink())throw new RuntimeError('INVALID_DOWNLOAD_FILE','The model download is not a regular app-owned file.');if(entry.size<=artifact.sizeBytes){retained+=entry.size;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
  const free=await options.freeDiskBytes?.(directory);if(free!==null&&free!==undefined&&free<spec.estimatedDownloadBytes-retained+512*1024**2)throw new RuntimeError('INSUFFICIENT_STORAGE','There is not enough free storage to finish all model shards.');
  const controller=new AbortController(),signal=artifacts.length===1?options.signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  const completed=artifacts.map(()=>0),files=artifacts.map(()=>''),aggregate=()=>completed.reduce((n,b)=>n+b,0);let next=0,firstFailure:unknown;
  const worker=async()=>{
    while(next<artifacts.length&&!signal?.aborted){const index=next++,artifact=artifacts[index];
      try{files[index]=await downloadArtifact(spec,artifact,directory,{...options,signal,onProgress:event=>{completed[index]=event.completed??completed[index];const count=aggregate();options.onProgress?.({...event,artifact:artifact.filename,artifactIndex:index+1,artifactCount:artifacts.length,total:spec.estimatedDownloadBytes,completed:count,percent:Math.min(100,count/spec.estimatedDownloadBytes*100),status:event.status==='success'?'verifying':event.status});}});completed[index]=artifact.sizeBytes;}
      catch(error){firstFailure??=error;controller.abort(error);return;}
    }
  };
  // Each independent pinned shard owns one bounded stream. Failure/cancellation
  // aborts and drains the group; completed and partial files remain resumable.
  await Promise.all(Array.from({length:Math.min(4,artifacts.length)},()=>worker()));
  throwIfAborted(options.signal);if(firstFailure)throw firstFailure;if(files.some(file=>!file))throw new RuntimeError('DOWNLOAD_INTERRUPTED','The complete model shard group was interrupted. Retry to resume.');
  const metadata=[];for(let i=0;i<files.length;i++)metadata.push(await readGGUFMetadata(files[i],options.signal,artifacts.length>1?{split:{index:i,count:artifacts.length}}:{}));validateGGUFModelSet(metadata,spec.architecture);
  options.onProgress?.({model:spec.id,status:'success',completed:aggregate(),total:spec.estimatedDownloadBytes,percent:100,artifactCount:artifacts.length});return files[0];
}
