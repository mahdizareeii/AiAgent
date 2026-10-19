/** Validation-only filesystem adapter. Mutable state never uses the host share. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,lstat,stat,realpath,mkdtemp,mkdir,readdir,open,writeFile} from 'node:fs/promises';

const execute=promisify(execFile);
export interface GuestWorkRoot {schemaVersion:1;root:string;runDirectory:string;profileDirectory:string;createdAt:string;identity:{device:number;inode:number;uid:number;mode:number};filesystem:{source:string;mountPoint:string;type:'apfs';local:true;readOnly:false;mountRow:string};}
export function parseLocalAPFS(df:string,mounts:string):GuestWorkRoot['filesystem']{
  const rows=df.trim().split('\n');if(rows.length!==2)throw new Error('Expected one actual df row for the owned local work root.');
  const fields=rows[1].match(/^(\S+)\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);if(!fields||!/^\/dev\/disk[0-9]+(?:s[0-9]+)+$/.test(fields[1]))throw new Error('Mutable validation storage must be on an actual guest block device.');
  const prefix=`${fields[1]} on ${fields[2]} (`;const matching=mounts.split('\n').filter(row=>row.startsWith(prefix)&&row.endsWith(')'));if(matching.length!==1)throw new Error('The owned work volume did not have one matching mount identity.');
  const flags=matching[0].slice(prefix.length,-1).split(',').map(value=>value.trim());if(flags[0]!=='apfs'||!flags.includes('local')||flags.includes('read-only'))throw new Error('Mutable validation storage requires actual writable guest-local APFS.');
  return {source:fields[1],mountPoint:fields[2],type:'apfs',local:true,readOnly:false,mountRow:matching[0]};
}
export async function createGuestWorkRoot(runId:string):Promise<GuestWorkRoot>{
  if(process.platform!=='darwin'||process.arch!=='arm64'||!/^[a-f0-9-]{36}$/.test(runId))throw new Error('A real darwin/arm64 validation run identity is required.');
  const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'eightgb-real-'));await chmod(root,0o700);
  const [df,mounts]=await Promise.all([execute('/bin/df',['-P',root],{timeout:5000,maxBuffer:32*1024}),execute('/sbin/mount',[],{timeout:5000,maxBuffer:256*1024})]);
  const filesystem=parseLocalAPFS(df.stdout,mounts.stdout),info=await lstat(root),volume=await stat(filesystem.mountPoint);
  if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==volume.dev||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('Owned work root did not match its actual APFS volume/owner.');
  const profileDirectory=path.join(root,'eightgb-real-profile'),runDirectory=path.join(root,'run');await mkdir(profileDirectory,{mode:0o700});await mkdir(runDirectory,{mode:0o700});
  const value:GuestWorkRoot={schemaVersion:1,root,runDirectory,profileDirectory,createdAt:new Date().toISOString(),identity:{device:info.dev,inode:info.ino,uid:info.uid,mode:info.mode&0o777},filesystem};
  await writeFile(path.join(root,'owned-work-root.json'),JSON.stringify({...value,runId},null,2)+'\n',{flag:'wx',mode:0o600});return value;
}
export async function assertGuestWorkRoot(value:GuestWorkRoot):Promise<void>{
  const root=await realpath(value.root),info=await lstat(root);
  if(root!==value.root||!info.isDirectory()||info.isSymbolicLink()||info.dev!==value.identity.device||info.ino!==value.identity.inode||info.uid!==value.identity.uid||(info.mode&0o077)!==0||value.runDirectory!==path.join(root,'run')||value.profileDirectory!==path.join(root,'eightgb-real-profile'))throw new Error('Owned local work root changed before evidence export.');
  for(const directory of [value.runDirectory,value.profileDirectory]){const child=await lstat(directory);if(!child.isDirectory()||child.isSymbolicLink()||await realpath(directory)!==directory||child.dev!==info.dev||child.uid!==info.uid)throw new Error('Local app/work directory escaped its owned volume.');}
}
interface FileRow {relative:string;bytes:number;sha256:string;}
const limits={maximumFiles:4096,maximumFileBytes:16*1024**2,maximumTotalBytes:256*1024**2,maximumRawBytes:128*1024**2};
async function canonicalDirectory(directory:string){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw new Error('Evidence directory has a symlink ancestor or is not ordinary.');}
async function exportDirectory(root:string,directory:string){await canonicalDirectory(root);const relative=path.relative(root,directory);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Export directory escapes its owned destination.');let current=root;for(const name of relative.split(path.sep).filter(Boolean)){current=path.join(current,name);try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}await canonicalDirectory(current);}}
async function fileDigest(file:string,maximum:number){
  if(await realpath(file)!==file)throw new Error('Evidence hash has a symlink ancestor.');
  const input=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');let bytes=0;
  try{const initial=await input.stat();if(!initial.isFile()||initial.size>maximum)throw new Error('Evidence hash requires a bounded ordinary file.');const buffer=Buffer.alloc(64*1024);while(true){const read=await input.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>maximum||bytes>initial.size)throw new Error('Evidence grew while hashing.');hash.update(buffer.subarray(0,read.bytesRead));}const final=await input.stat();if(bytes!==initial.size||initial.size!==final.size||initial.mtimeMs!==final.mtimeMs||initial.ctimeMs!==final.ctimeMs)throw new Error('Evidence changed while hashing.');return {bytes,sha256:hash.digest('hex')};}finally{await input.close();}
}
export async function verifyExportedFile(file:string,expected:{bytes:number;sha256:string},maximum=limits.maximumFileBytes){
  const actual=await fileDigest(file,maximum);if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw new Error('Independently reopened exported bytes/digest differ from the source.');return actual;
}
async function writeVerifiedJSON(file:string,value:unknown,root:string){await exportDirectory(root,path.dirname(file));const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(file,bytes,{flag:'wx',mode:0o600});await verifyExportedFile(file,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
async function copyOrdinary(source:string,target:string,maximum:number,root:string){
  if(await realpath(source)!==source)throw new Error('Evidence source has a symlink ancestor.');
  const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);let output:Awaited<ReturnType<typeof open>>|undefined;let bytes=0;const hash=createHash('sha256');
  try{const initial=await input.stat();if(!initial.isFile()||initial.size>maximum)throw new Error('Evidence copy requires a bounded ordinary file.');await exportDirectory(root,path.dirname(target));output=await open(target,'wx',0o600);const buffer=Buffer.alloc(64*1024);while(true){const read=await input.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>initial.size||bytes>maximum)throw new Error('Evidence grew while copying.');const part=buffer.subarray(0,read.bytesRead);hash.update(part);let written=0;while(written<part.length){const result=await output.write(part,written,part.length-written);if(!result.bytesWritten)throw new Error('Evidence write made no progress.');written+=result.bytesWritten;}}const final=await input.stat();if(bytes!==initial.size||initial.size!==final.size||initial.mtimeMs!==final.mtimeMs||initial.ctimeMs!==final.ctimeMs)throw new Error('Evidence changed during export.');await output.sync();}finally{await input.close();await output?.close();}
  const expected={bytes,sha256:hash.digest('hex')};await verifyExportedFile(target,expected,maximum);return expected;
}
async function walkFiles(root:string,callback:(file:string,relative:string)=>Promise<void>,prefix='',budget={entries:0}){
  if(++budget.entries>8192||prefix.split(path.sep).length>64)throw new Error('Evidence traversal exceeded its directory bound.');
  const item=await lstat(root);if(item.isSymbolicLink()||!item.isDirectory()&&!item.isFile())throw new Error('Nonordinary evidence path cannot be exported.');
  if(await realpath(root)!==root)throw new Error('Evidence traversal has a symlink ancestor.');
  if(item.isDirectory()){for(const name of (await readdir(root)).sort())await walkFiles(path.join(root,name),callback,path.join(prefix,name),budget);}else await callback(root,prefix);
}

/** Deliberately narrow: no runtime model/key tree, browser stores, Goose configs
 * or SQLite payloads. All originals remain in the private guest-local root. */
export async function captureProfileEvidence(value:GuestWorkRoot,drained:boolean){
  if(!drained)throw new Error('Profile capture requires actual owned final drain.');await assertGuestWorkRoot(value);
  const destination=path.join(value.runDirectory,'profile-artifacts');await mkdir(destination,{mode:0o700});const rows:FileRow[]=[];let totalBytes=0;
  async function optional(source:string,relative:string){try{await lstat(source);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    await walkFiles(source,async(file,child)=>{const name=path.join(relative,child);if(/\.gguf(?:\.|$)/i.test(name)||/(?:^|\/)\.inference-key/i.test(name))throw new Error('Model/key path reached the profile export allowlist.');const size=(await lstat(file)).size;if(rows.length>=4096||size>8*1024**2||totalBytes+size>32*1024**2)throw new Error('Profile evidence exceeded its bounded allowlist.');const copied=await copyOrdinary(file,path.join(destination,name),8*1024**2,destination);totalBytes+=copied.bytes;rows.push({relative:name,...copied});});}
  for(const name of ['chats.json','staged-work','edit-history'])await optional(path.join(value.profileDirectory,name),name);
  const turns=path.join(value.profileDirectory,'turns');let names:string[]=[];try{await canonicalDirectory(turns);names=(await readdir(turns)).sort();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(names.length>1024)throw new Error('Turn count exceeds the bounded profile export.');
  for(const name of names){if(!/^[a-f0-9-]{36}$/.test(name))throw new Error('Unexpected local turn identity.');await optional(path.join(turns,name,'state/logs/cli'),path.join('turns',name,'state/logs/cli'));}
  const manifest={schemaVersion:1,complete:true,capturedAt:new Date().toISOString(),localRoot:value,files:rows,totalBytes,excluded:['gguf-runtime (models and inference keys)','browser stores/caches','Goose configs and SQLite payloads'],originalsRetainedLocally:true};await writeVerifiedJSON(path.join(destination,'manifest.json'),manifest,destination);return manifest;
}

/** Existing shared raw mirror is verified exactly; all other files are write-once.
 * report.json is installed last, after its expected digest/export manifest. */
export async function exportRunEvidence(value:GuestWorkRoot,sharedDirectory:string,drained:boolean){
  if(!drained)throw new Error('Run export requires actual owned final drain.');await assertGuestWorkRoot(value);const source=value.runDirectory,rows:FileRow[]=[];let totalBytes=0,report:{file:string;relative:string}|undefined;
  await walkFiles(source,async(file,relative)=>{if(rows.length>=limits.maximumFiles)throw new Error('Run export file count exceeded.');if(relative==='report.json'){report={file,relative};return;}if(/\.gguf(?:\.|$)/i.test(relative)||/(?:^|\/)\.inference-key/i.test(relative))throw new Error('Model/key path reached the run export.');const maximum=relative==='raw-events.jsonl'?limits.maximumRawBytes:limits.maximumFileBytes,size=(await lstat(file)).size;if(size>maximum||totalBytes+size>limits.maximumTotalBytes)throw new Error('Run export byte bound exceeded.');let copied;
    if(relative==='raw-events.jsonl'){copied=await fileDigest(file,maximum);const mirror=await fileDigest(path.join(sharedDirectory,relative),maximum);if(copied.bytes!==mirror.bytes||copied.sha256!==mirror.sha256)throw new Error('Shared raw mirror differs from the final local raw log.');}
    else copied=await copyOrdinary(file,path.join(sharedDirectory,relative),maximum,sharedDirectory);totalBytes+=copied.bytes;rows.push({relative,...copied});});
  if(!report)throw new Error('A local final report is required for terminal export.');const finalReport=report as {file:string;relative:string};const reportDigest=await fileDigest(finalReport.file,limits.maximumFileBytes);if(rows.length>=limits.maximumFiles||totalBytes+reportDigest.bytes>limits.maximumTotalBytes)throw new Error('Final report exceeds bounded export.');rows.push({relative:'report.json',...reportDigest});totalBytes+=reportDigest.bytes;
  await assertGuestWorkRoot(value);const manifest={schemaVersion:1,complete:true,exportedAt:new Date().toISOString(),localRoot:value,sharedDirectory,limits,files:rows,totalBytes,rawMirrorExact:true,reportInstalledLast:true,originalsRetainedLocally:true};
  await writeVerifiedJSON(path.join(sharedDirectory,'post-drain-export.json'),manifest,sharedDirectory);const actualReport=await copyOrdinary(finalReport.file,path.join(sharedDirectory,'report.json'),limits.maximumFileBytes,sharedDirectory);if(actualReport.bytes!==reportDigest.bytes||actualReport.sha256!==reportDigest.sha256)throw new Error('Final report changed after export manifest.');return manifest;
}
