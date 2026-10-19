import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LocalInferenceRuntime, type CuratedModel } from '../index.ts';
import { stageModelImport } from '../import-files.ts';

const u32=(v:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;};
const u64=(v:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
const str=(v:string)=>Buffer.concat([u64(Buffer.byteLength(v)),Buffer.from(v)]);
const entry=(k:string,v:string)=>Buffer.concat([str(k),u32(8),str(v)]);
const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(3),entry('general.architecture','llama'),entry('general.name','Import fixture'),entry('tokenizer.chat_template','{{messages|tojson}}'),str('token_embd.weight'),u32(2),u64(8),u64(1),u32(0),u64(0)]);
const bytes=Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32)]);
const spec:CuratedModel={id:'fixture:import',title:'Import fixture',description:'Synthetic import only',estimatedDownloadBytes:bytes.length,minimumMemoryGB:8,workingMemoryGB:4,license:'fixture',sourceUrl:'',quantization:'F32',repository:'fixture/import',revision:'a'.repeat(40),filename:'fixture.gguf',sha256:createHash('sha256').update(bytes).digest('hex'),architecture:'llama',toolCapable:false};
async function fixture(t:TestContext,freeDiskBytes?:()=>Promise<number|null>){const root=await mkdtemp(path.join(tmpdir(),'model-import-'));t.after(()=>rm(root,{recursive:true,force:true}));const runtime=new LocalInferenceRuntime({dataDirectory:root,catalog:[spec],freeDiskBytes,spawn:()=>{throw Error('No engine or model may launch in import tests.');}});await mkdir(path.join(root,'models'));return {runtime,root,target:path.join(root,'models',spec.filename)};}

test('a Desktop symlink to the verified cache reuses the regular inode without requesting copy space',async t=>{
  const {runtime,root,target}=await fixture(t,async()=>{throw Error('Reuse must not request copy space.');});await writeFile(target,bytes);const verified=await runtime.inspectModel(spec.id);const before=await lstat(target);
  const desktop=path.join(root,'Desktop models');await mkdir(desktop);const alias=path.join(desktop,'Pick this model.gguf');await symlink(target,alias);
  const imported=await runtime.importModel(alias);assert.equal(imported.digest,verified.digest);const after=await lstat(target);assert.equal(after.isSymbolicLink(),false);assert.equal(after.ino,before.ino);assert.equal(after.ctimeMs,before.ctimeMs);
});

test('new same-filesystem imports hardlink regular verified weights without full-copy headroom',async t=>{
  const {runtime,root,target}=await fixture(t,async()=>0);const source=path.join(root,'selected.gguf');await writeFile(source,bytes);
  const imported=await runtime.importModel(source);assert.equal(imported.model,spec.id);const [a,b]=await Promise.all([lstat(source),lstat(target)]);assert.equal(b.isSymbolicLink(),false);assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);
  const changed=Buffer.from(bytes);changed[changed.length-1]=1;await writeFile(source,changed);await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});
});

test('a separate selected duplicate reuses the verified destination and preserves its inode',async t=>{
  const {runtime,root,target}=await fixture(t,async()=>0);await writeFile(target,bytes);await runtime.inspectModel(spec.id);const before=await lstat(target);const source=path.join(root,'another-copy.gguf');await writeFile(source,bytes);
  assert.equal((await runtime.importModel(source)).model,spec.id);assert.equal((await lstat(target)).ino,before.ino);assert.notEqual((await lstat(source)).ino,before.ino);
});

test('a named pinned source with changed payload cannot become an untrusted generic import or replace the cache',async t=>{
  const {runtime,root,target}=await fixture(t);await writeFile(target,bytes);const selected=path.join(root,'selected');await mkdir(selected);const source=path.join(selected,spec.filename);const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]=1;await writeFile(source,corrupt);
  await assert.rejects(runtime.importModel(source),{code:'MODEL_DIGEST_MISMATCH'});assert.deepEqual(await readFile(target),bytes);assert.equal((await runtime.listModels()).length,1);
});

test('cross-filesystem link failure copies only with enough headroom and leaves a regular independent file',async t=>{
  const {root}=await fixture(t);const source=path.join(root,'source.gguf'),target=path.join(root,'copied.gguf');await writeFile(source,bytes);
  const linkFile=async()=>{throw Object.assign(Error('cross-device'),{code:'EXDEV'});};
  assert.equal(await stageModelImport(source,target,{freeDiskBytes:async()=>2**30,linkFile}),'copied');assert.deepEqual(await readFile(target),bytes);assert.notEqual((await lstat(target)).ino,(await lstat(source)).ino);
  const blocked=path.join(root,'blocked.gguf');await assert.rejects(stageModelImport(source,blocked,{freeDiskBytes:async()=>0,linkFile}),{code:'INSUFFICIENT_STORAGE'});await assert.rejects(lstat(blocked),{code:'ENOENT'});
});

test('unexpected link errors and pre-aborted imports do not silently copy or create destinations',async t=>{
  const {root}=await fixture(t);const source=path.join(root,'source.gguf'),target=path.join(root,'target.gguf');await writeFile(source,bytes);
  await assert.rejects(stageModelImport(source,target,{freeDiskBytes:async()=>{throw Error('No fallback');},linkFile:async()=>{throw Object.assign(Error('I/O'),{code:'EIO'});}}),{code:'EIO'});
  const controller=new AbortController();controller.abort();await assert.rejects(stageModelImport(source,target,{signal:controller.signal,freeDiskBytes:async()=>2**30}),{name:'AbortError'});await assert.rejects(lstat(target),{code:'ENOENT'});
});
