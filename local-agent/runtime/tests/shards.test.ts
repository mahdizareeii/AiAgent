import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test,type TestContext} from 'node:test';
import {LocalInferenceRuntime,type CuratedModel,type HardwareInfo} from '../index.ts';
import {GIB} from '../hardware.ts';

const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str=(s:string)=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const string=(key:string,value:string)=>Buffer.concat([str(key),u32(8),str(value)]);
const number=(key:string,value:number)=>Buffer.concat([str(key),u32(4),u32(value)]);
function shard(index:number,split=index,extra:Buffer[]=[]){
  const metadata=[...(index===0?[string('general.architecture','qwen3next')]:[]),number('split.no',split),number('split.count',2),number('split.tensors.count',2),...(index===0?[string('tokenizer.chat_template','{{ messages | tojson }}')]:[]),...extra];
  const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(metadata.length),...metadata,str(`blk.${index}.fixture.weight`),u32(2),u64(8),u64(1),u32(0),u64(0)]);
  return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32,index)]);
}
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'Fixture',cpuCores:8,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,freeDiskBytes:100*GIB,gpus:[]};
async function fixture(t:TestContext,second=shard(1)){
  const root=await mkdtemp(path.join(tmpdir(),'local-agent-shards-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'models'));
  const first=shard(0),artifacts=[first,second].map((bytes,i)=>({filename:`fixture-0000${i+1}-of-00002.gguf`,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
  const spec:CuratedModel={id:'fixture:split',title:'Split fixture',description:'Two shards',estimatedDownloadBytes:first.length+second.length,minimumMemoryGB:8,workingMemoryGB:4,license:'Apache-2.0',sourceUrl:'',quantization:'F32',repository:'example/split',revision:'a'.repeat(40),filename:artifacts[0].filename,sha256:artifacts[0].sha256,architecture:'qwen3next',toolCapable:true,artifacts};
  await writeFile(path.join(root,'models',artifacts[0].filename),first);await writeFile(path.join(root,'models',artifacts[1].filename),second);
  const runtime=new LocalInferenceRuntime({dataDirectory:root,catalog:[spec],hardware});return {runtime,spec,root,first,second};
}

test('complete split GGUF verification binds all actual shard digests and first-shard template',async t=>{
  const {runtime,spec}=await fixture(t);assert.equal((await runtime.listModels())[0].digest,null);
  const verified=await runtime.inspectModel(spec.id);assert.equal(verified.sizeBytes,spec.estimatedDownloadBytes);assert.equal(verified.artifactDigests?.length,2);assert.notEqual(verified.digest,spec.sha256,'The first shard is not a complete model identity.');assert.match(verified.templateHash!,/^[a-f0-9]{64}$/);
  assert.equal((await runtime.listModels())[0].digest,verified.digest);assert.equal((await runtime.listModels())[0].integrity,'verified');
});

test('one missing shard invalidates complete installation without deleting retained bytes',async t=>{
  const {runtime,spec,root,first}=await fixture(t);await runtime.inspectModel(spec.id);await rm(path.join(root,'models',spec.artifacts![1].filename));
  assert.equal((await runtime.listModels())[0].installed,false);assert.equal((await runtime.listModels())[0].digest,null);await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_NOT_FOUND'});assert.deepEqual(await readFile(path.join(root,'models',spec.filename)),first);
});

test('same-sized corruption in any shard invalidates complete verified identity',async t=>{
  const {runtime,spec,root,second}=await fixture(t);await runtime.inspectModel(spec.id);const corrupt=Buffer.from(second);corrupt[corrupt.length-1]^=1;await writeFile(path.join(root,'models',spec.artifacts![1].filename),corrupt);
  assert.equal((await runtime.listModels())[0].digest,null);await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_DIGEST_MISMATCH'});const row=(await runtime.listModels())[0];assert.equal(row.integrity,'failed');assert.equal(row.trialBlocker?.code,'MODEL_VERIFICATION_FAILED');
});

test('even correctly hashed files must have complete matching GGUF split identities',async t=>{
  const {runtime,spec}=await fixture(t,shard(1,0));await assert.rejects(runtime.inspectModel(spec.id),{code:'MODEL_SHARD_MISMATCH'});
});

test('verified secondary shared metadata remains bound to the first shard and catalog',async t=>{
  const architecture=await fixture(t,shard(1,1,[string('general.architecture','llama')]));await assert.rejects(architecture.runtime.inspectModel(architecture.spec.id),{code:'MODEL_ARCHITECTURE_MISMATCH'});
  const template=await fixture(t,shard(1,1,[string('tokenizer.chat_template','different template')]));await assert.rejects(template.runtime.inspectModel(template.spec.id),{code:'MODEL_SHARD_MISMATCH'});
});

test('group import uses only explicitly selected complete files and verifies its copied identity',async t=>{
  const {runtime,spec,root,first,second}=await fixture(t);const picked=path.join(root,'selected');await mkdir(picked);
  const sources=spec.artifacts!.map(a=>path.join(picked,a.filename));await writeFile(sources[0],first);await writeFile(sources[1],second);await rm(path.join(root,'models'),{recursive:true});
  await assert.rejects(runtime.importModel(sources[0]),{code:'MODEL_SHARDS_REQUIRED'});await assert.rejects(runtime.importModel(sources[1]),{code:'MODEL_SHARDS_REQUIRED'});assert.equal((await runtime.listModels())[0].installed,false);
  const imported=await runtime.importModelFiles([...sources].reverse());assert.equal(imported.model,spec.id);assert.equal(imported.artifactDigests?.length,2);assert.equal((await runtime.listModels())[0].integrity,'verified');assert.deepEqual(await readFile(sources[0]),first);assert.deepEqual(await readFile(sources[1]),second);
});

test('corrupt selected group import fails before copying and preserves source files',async t=>{
  const {runtime,spec,root,first,second}=await fixture(t);const picked=path.join(root,'selected');await mkdir(picked);const sources=spec.artifacts!.map(a=>path.join(picked,a.filename));const corrupt=Buffer.from(second);corrupt[corrupt.length-1]^=1;
  await writeFile(sources[0],first);await writeFile(sources[1],corrupt);await rm(path.join(root,'models'),{recursive:true});
  await assert.rejects(runtime.importModelFiles(sources),{code:'MODEL_DIGEST_MISMATCH'});assert.equal((await runtime.listModels())[0].installed,false);assert.deepEqual(await readFile(sources[1]),corrupt);
});

test('split SSD identity requires native uncached complete checksums for every pinned shard',async t=>{
  const {spec,root,first,second}=await fixture(t),fake=fileURLToPath(new URL('./fake-engine.cjs',import.meta.url)),hashes:string[]=[];
  const runtime=new LocalInferenceRuntime({dataDirectory:root,catalog:[{...spec,ssd:{expectedLayers:2,minimumSlotsPerLayer:30,expertsPerLayer:512,activeExperts:10}}],executablePath:process.execPath,hardware:{...hardware,osRelease:'25.0.0'},ssdTestEngine:{executablePath:process.execPath,patchDigest:'d'.repeat(64),integrityPath:process.execPath,integritySourceDigest:'e'.repeat(64)},resourceProbe:async()=>({sampledAt:new Date().toISOString(),residentBytes:0,availableMemoryBytes:20*GIB,pressure:'normal'}),spawn:(_command,args,options)=>{if(args.includes('--file'))hashes.push(path.basename(args[args.indexOf('--file')+1]));return spawn(process.execPath,[fake,...args],options);}});t.after(()=>runtime.stop());await runtime.start();
  const verified=await runtime.inspectModel(spec.id,{requireSSDIntegrity:true});assert.equal(verified.verificationIO,'darwin-nocache');assert.deepEqual(hashes,spec.artifacts!.map(a=>a.filename));assert.deepEqual(verified.artifactDigests!.map(a=>a.sha256),[first,second].map(b=>createHash('sha256').update(b).digest('hex')));assert.notEqual(verified.digest,spec.sha256);
});
