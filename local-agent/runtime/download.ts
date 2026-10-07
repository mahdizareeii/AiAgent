import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CuratedModel } from './catalog.ts';
import { abortError, RuntimeError, throwIfAborted } from './errors.ts';
import { sha256File, readGGUFMetadata } from './gguf.ts';
export interface PullProgress {model:string;status:string;digest?:string;total?:number;completed?:number;percent?:number;}
const safeHost=(host:string)=>host==='huggingface.co'||host.endsWith('.huggingface.co')||host==='cdn-lfs.hf.co'||host.endsWith('.hf.co')||host.endsWith('.xethub.hf.co');
export async function fetchArtifact(url:string,init:RequestInit,fetcher:typeof fetch=fetch):Promise<Response>{
  for(let i=0;i<8;i++){const target=new URL(url);if(target.protocol!=='https:'||!safeHost(target.hostname)||target.username||target.password)throw new RuntimeError('INVALID_DOWNLOAD_HOST','The model download redirected outside its approved artifact hosts.');
    const response=await fetcher(target.href,{...init,redirect:'manual',credentials:'omit'});if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new RuntimeError('DOWNLOAD_FAILED','The model publisher returned a redirect without a destination.');url=new URL(location,target).href;
  }throw new RuntimeError('DOWNLOAD_FAILED','Too many model download redirects.');
}
export async function downloadModel(spec:CuratedModel,directory:string,options:{fetch?:typeof fetch;signal?:AbortSignal;onProgress?:(p:PullProgress)=>void;freeDiskBytes?:(directory:string)=>Promise<number|null>}={}):Promise<string>{
  const {signal}=options;throwIfAborted(signal);await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,spec.filename),partial=`${file}.part`;
  const report=(status:string,completed?:number)=>options.onProgress?.({model:spec.id,status,total:spec.estimatedDownloadBytes,completed,percent:completed===undefined?undefined:Math.min(100,completed/spec.estimatedDownloadBytes*100)});
  let offset=0;try{const s=await lstat(partial);if(!s.isFile()||s.isSymbolicLink())throw new RuntimeError('INVALID_DOWNLOAD_FILE','The partial model download is not a regular file.');offset=s.size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(offset>spec.estimatedDownloadBytes){await rm(partial);offset=0;}
  const free=await options.freeDiskBytes?.(directory);if(free!==null&&free!==undefined&&free<spec.estimatedDownloadBytes-offset+512*1024**2)throw new RuntimeError('INSUFFICIENT_STORAGE','There is not enough free disk space for this model download.');
  if(offset<spec.estimatedDownloadBytes){
    const url=`https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${encodeURIComponent(spec.filename)}`;
    const response=await fetchArtifact(url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal},options.fetch);
    if(response.status===401||response.status===403)throw new RuntimeError('MODEL_DOWNLOAD_UNAVAILABLE','The publisher did not provide public access to this pinned model file.');
    if(response.status!==200&&response.status!==206)throw new RuntimeError('DOWNLOAD_FAILED',`The model download returned HTTP ${response.status}. Retry to resume.`);
    if(response.status===206){const match=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);if(!match||Number(match[1])!==offset||Number(match[3])!==spec.estimatedDownloadBytes)throw new RuntimeError('INVALID_DOWNLOAD_RANGE','The resumed model response does not match the expected byte range.');}
    else offset=0;
    if(!response.body)throw new RuntimeError('DOWNLOAD_FAILED','The model download returned no file data.');
    const handle=await open(partial,offset?'a':'w',0o600);const reader=response.body.getReader();let lastReport=0;
    try{report('downloading',offset);while(true){throwIfAborted(signal);const {value,done}=await reader.read();if(done)break;if(offset+value.length>spec.estimatedDownloadBytes)throw new RuntimeError('DOWNLOAD_SIZE_MISMATCH','The download exceeds its pinned size.');await handle.writeFile(value);offset+=value.length;if(Date.now()-lastReport>150){report('downloading',offset);lastReport=Date.now();}}await handle.sync();}
    catch(error){if(signal?.aborted)throw abortError();throw error;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();await handle.close();}
  }
  throwIfAborted(signal);if(offset!==spec.estimatedDownloadBytes)throw new RuntimeError('DOWNLOAD_INTERRUPTED','The model download was interrupted. Retry to resume its verified revision.');
  report('verifying',offset);const digest=await sha256File(partial,signal);if(digest!==spec.sha256){await rm(partial,{force:true});throw new RuntimeError('MODEL_DIGEST_MISMATCH','The model SHA-256 does not match its pinned publisher artifact. Download it again.');}
  await readGGUFMetadata(partial,signal);throwIfAborted(signal);await rename(partial,file);report('success',offset);return file;
}
