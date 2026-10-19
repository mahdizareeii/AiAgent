import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { link, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RuntimeError, throwIfAborted } from './errors.ts';

/** A user-selected Finder/desktop link grants its resolved regular file, not a cache symlink. */
export async function resolveModelImportSource(selected:string):Promise<{path:string;info:Stats}>{
  if(!path.isAbsolute(selected))throw new RuntimeError('INVALID_GGUF','Choose an absolute local GGUF file path.');
  let resolved:string,info:Stats;
  try{resolved=await realpath(selected);info=await lstat(resolved);}catch(error){throw new RuntimeError('MODEL_IMPORT_SOURCE_MISSING',`The selected model file is unavailable: ${path.basename(selected)}. Check its shortcut target.`,{cause:error});}
  if(!info.isFile()||info.isSymbolicLink()||info.size<24||info.size>128*1024**3)throw new RuntimeError('INVALID_GGUF','Import a regular GGUF file no larger than 128 GiB.');
  return {path:resolved,info};
}

/** Stage a regular cache file without duplicating multi-GB weights on the same filesystem.
 * The caller must checksum/validate the resulting complete cache set before publishing it.
 * Hard links remain subject to the ordinary inode/ctime/mtime integrity checks on every use.
 */
export async function stageModelImport(source:string,target:string,options:{signal?:AbortSignal;freeDiskBytes:()=>Promise<number|null>;linkFile?:typeof link}):Promise<'linked'|'copied'>{
  throwIfAborted(options.signal);const before=await lstat(source);
  if(!before.isFile()||before.isSymbolicLink())throw new RuntimeError('MODEL_CHANGED','The selected model is no longer a regular file.');
  let method:'linked'|'copied'='linked';
  try{await (options.linkFile??link)(source,target);}catch(error){
    if(!['EXDEV','EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))throw error;
    throwIfAborted(options.signal);const free=await options.freeDiskBytes();
    if(free!==null&&free<before.size+512*1024**2)throw new RuntimeError('INSUFFICIENT_STORAGE','This filesystem cannot link the model. There is not enough free storage to copy it into the app cache.');
    method='copied';
    try{await pipeline(createReadStream(source,{end:before.size-1}),createWriteStream(target,{flags:'wx',mode:0o600}),{signal:options.signal});}
    catch(error){await rm(target,{force:true});throw error;}
  }
  throwIfAborted(options.signal);const [after,staged]=await Promise.all([lstat(source),lstat(target)]);
  const unchanged=after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&(method==='linked'||before.ctimeMs===after.ctimeMs);
  if(!unchanged||!staged.isFile()||staged.isSymbolicLink()||staged.size!==before.size||method==='linked'&&(staged.dev!==after.dev||staged.ino!==after.ino))throw new RuntimeError('MODEL_CHANGED','The selected model changed while being imported.');
  return method;
}
