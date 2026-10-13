import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CuratedModel } from '../catalog.ts';
import { downloadModel, type PullProgress } from '../download.ts';
import { readGGUFMetadata } from '../gguf.ts';
import { RuntimeError } from '../errors.ts';

const uint32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const uint64 = (value: number | bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const ggufString = (value: string) => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([uint64(bytes.length), bytes]); };
const stringMetadata = (key: string, value: string) => Buffer.concat([ggufString(key), uint32(8), ggufString(value)]);

// A structurally valid GGUF v3 file with a tiny F32 tensor. It has enough chat
// metadata to exercise artifact validation without downloading model weights.
function fixture() {
  const header = Buffer.concat([
    Buffer.from('GGUF'), uint32(3), uint64(1), uint64(4),
    stringMetadata('general.architecture', 'llama'),
    stringMetadata('general.name', 'دانلود آزمایشی'),
    stringMetadata('tokenizer.chat_template', '{{ messages | tojson }}'),
    ggufString('llama.context_length'), uint32(4), uint32(2048),
    ggufString('token_embd.weight'), uint32(2), uint64(8), uint64(1), uint32(0), uint64(0),
  ]);
  const data = Buffer.alloc(8 * 4);
  for (let i = 0; i < 8; i++) data.writeFloatLE(i / 8, i * 4);
  return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), data]);
}

const bytes = fixture();
const spec: CuratedModel = {
  id: 'test:tiny', title: 'Tiny GGUF fixture', description: 'Offline download tests only',
  estimatedDownloadBytes: bytes.length, minimumMemoryGB: 1, workingMemoryGB: 1,
  license: 'Apache-2.0', sourceUrl: 'https://huggingface.co/local-agent/download-fixture',
  quantization: 'F32', repository: 'local-agent/download-fixture', revision: 'a'.repeat(40),
  filename: 'tiny agent.gguf', sha256: createHash('sha256').update(bytes).digest('hex'),
  architecture: 'llama', toolCapable: true,
};
const pinnedUrl = `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/tiny%20agent.gguf`;

async function directory(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'local-agent-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function response(data: Uint8Array, status = 200, headers?: HeadersInit) {
  const chunks = [data.subarray(0, 41), data.subarray(41, 97), data.subarray(97)].filter(chunk => chunk.length);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { status, headers });
}

test('streams a pinned HTTPS artifact and verifies its SHA and GGUF before publishing it', async t => {
  const root = await directory(t);
  const progress: PullProgress[] = [];
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), pinnedUrl);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('range'), null);
    return response(bytes);
  };
  const file = await downloadModel(spec, root, { fetch: fetcher, onProgress: event => progress.push(event) });
  assert.equal(requests, 1);
  assert.equal(file, path.join(root, spec.filename));
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(root), [spec.filename]);
  assert.equal(progress.at(-1)?.status, 'success');
  assert.equal(progress.at(-1)?.completed, bytes.length);
  assert(progress.some(event => event.status === 'verifying'));
  const metadata = await readGGUFMetadata(file);
  assert.equal(metadata.architecture, 'llama');
  assert.equal(metadata.name, 'دانلود آزمایشی');
  assert.equal(metadata.contextLength, 2048);
  assert.equal(metadata.tensorCount, 1);
});

test('app-owned checksum readers verify completed downloads and reused artifacts without changing pinned identity',async t=>{
  const root=await directory(t),files:string[]=[];const hashFile=async(file:string)=>{files.push(path.basename(file));return createHash('sha256').update(await readFile(file)).digest('hex');};
  await downloadModel(spec,root,{fetch:async()=>new Response(bytes),hashFile});await downloadModel(spec,root,{fetch:async()=>{throw new Error('The verified file should be reused.');},hashFile});assert.deepEqual(files,[spec.filename+'.part',spec.filename]);
});

test('an operational checksum-reader failure preserves a completed shard without redownloading it',async t=>{
  const root=await directory(t);await writeFile(path.join(root,spec.filename),bytes);let contacted=false;
  await assert.rejects(downloadModel(spec,root,{fetch:async()=>{contacted=true;return new Response(bytes);},hashFile:async()=>{throw new RuntimeError('SSD_HASH_RESOURCE_UNAVAILABLE','Not enough current headroom.');}}),{code:'SSD_HASH_RESOURCE_UNAVAILABLE'});
  assert.equal(contacted,false);assert.deepEqual(await readFile(path.join(root,spec.filename)),bytes);assert.deepEqual(await readdir(root),[spec.filename]);
});

test('resumes a pinned partial file using Range and appends exactly the missing bytes', async t => {
  const root = await directory(t);
  const offset = 97;
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, offset));
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), pinnedUrl);
    assert.equal(new Headers(init?.headers).get('range'), `bytes=${offset}-`);
    return response(bytes.subarray(offset), 206, { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` });
  };
  const file = await downloadModel(spec, root, { fetch: fetcher });
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(root), [spec.filename]);
});

test('a publisher that ignores Range restarts from byte zero without duplicating the partial', async t => {
  const root = await directory(t);
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, 97));
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=97-');
    return response(bytes, 200);
  };
  const file = await downloadModel(spec, root, { fetch: fetcher });
  assert.deepEqual(await readFile(file), bytes);
});

test('cancellation retains the partial and a later call resumes the same pinned revision', async t => {
  const root = await directory(t);
  const controller = new AbortController();
  let streamCancelled = false;
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(bytes.subarray(0, 41)); },
      cancel() { streamCancelled = true; },
    }));
  };
  await assert.rejects(downloadModel(spec, root, {
    fetch: fetcher, signal: controller.signal,
    onProgress(event) { if (event.status === 'downloading' && (event.completed ?? 0) > 0) controller.abort(); },
  }), { name: 'AbortError' });
  assert(streamCancelled);
  assert.deepEqual(await readdir(root), [`${spec.filename}.part`]);
  assert.deepEqual(await readFile(path.join(root, `${spec.filename}.part`)), bytes.subarray(0, 41));
  const resume: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=41-');
    return response(bytes.subarray(41), 206, { 'Content-Range': `bytes 41-${bytes.length - 1}/${bytes.length}` });
  };
  assert.deepEqual(await readFile(await downloadModel(spec, root, { fetch: resume })), bytes);
});

test('a bad publisher SHA rejects and removes the artifact before it becomes available', async t => {
  const root = await directory(t);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  const fetcher: typeof fetch = async () => response(changed);
  await assert.rejects(downloadModel(spec, root, { fetch: fetcher }), { code: 'MODEL_DIGEST_MISMATCH' });
  assert.deepEqual(await readdir(root), []);
});

test('rejects an attacker redirect before contacting its host and cancels the redirect body', async t => {
  const root = await directory(t);
  const visited: string[] = [];
  let cancelled = false;
  const fetcher: typeof fetch = async input => {
    visited.push(String(input));
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }), { status: 302, headers: { Location: 'https://huggingface.co.attacker.example/stolen.gguf' } });
  };
  await assert.rejects(downloadModel(spec, root, { fetch: fetcher }), { code: 'INVALID_DOWNLOAD_HOST' });
  assert.deepEqual(visited, [pinnedUrl]);
  assert(cancelled);
  assert.deepEqual(await readdir(root), []);
});

test('allows the publisher CDN redirect while retaining Range and omitting credentials', async t => {
  const root = await directory(t);
  const offset = 41;
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, offset));
  const visited: string[] = [];
  const cdn = 'https://cdn-lfs.hf.co/test-pinned.gguf?signature=fixture';
  const fetcher: typeof fetch = async (input, init) => {
    visited.push(String(input));
    assert.equal(new Headers(init?.headers).get('range'), `bytes=${offset}-`);
    assert.equal(init?.credentials, 'omit');
    if (visited.length === 1) return new Response(null, { status: 307, headers: { Location: cdn } });
    assert.equal(String(input), cdn);
    return response(bytes.subarray(offset), 206, { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` });
  };
  assert.deepEqual(await readFile(await downloadModel(spec, root, { fetch: fetcher })), bytes);
  assert.deepEqual(visited, [pinnedUrl, cdn]);
});

test('an incorrect resumed range preserves the original partial and rejects the response', async t => {
  const root = await directory(t);
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, 97));
  const fetcher: typeof fetch = async () => response(bytes.subarray(0), 206, { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` });
  await assert.rejects(downloadModel(spec, root, { fetch: fetcher }), { code: 'INVALID_DOWNLOAD_RANGE' });
  assert.deepEqual(await readFile(path.join(root, `${spec.filename}.part`)), bytes.subarray(0, 97));
  assert.deepEqual(await readdir(root), [`${spec.filename}.part`]);
});

test('an interrupted stream retains bytes for retry instead of publishing an incomplete model', async t => {
  const root = await directory(t);
  const fetcher: typeof fetch = async () => response(bytes.subarray(0, 97));
  await assert.rejects(downloadModel(spec, root, { fetch: fetcher }), { code: 'DOWNLOAD_INTERRUPTED' });
  assert.deepEqual(await readFile(path.join(root, `${spec.filename}.part`)), bytes.subarray(0, 97));
  assert.deepEqual(await readdir(root), [`${spec.filename}.part`]);
});

function downloadSplit(index:number,count:number,extra:Buffer[]=[],includeShared=index===0):Buffer{
  const number=(key:string,value:number)=>Buffer.concat([ggufString(key),uint32(4),uint32(value)]);
  const records=[...(includeShared?[stringMetadata('general.architecture','llama'),stringMetadata('tokenizer.chat_template','{{ messages | tojson }}')]:[]),number('split.no',index),number('split.count',count),number('split.tensors.count',count),...extra];
  const header=Buffer.concat([Buffer.from('GGUF'),uint32(3),uint64(1),uint64(records.length),...records,ggufString(`fixture.${index}.weight`),uint32(2),uint64(8),uint64(1),uint32(0),uint64(0)]);
  return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32,index)]);
}
function groupedSpec(count=2,prefix='group'):CuratedModel {
  const artifacts=Array.from({length:count},(_,index)=>{const payload=downloadSplit(index,count),filename=`${prefix}-${String(index+1).padStart(5,'0')}-of-${String(count).padStart(5,'0')}.gguf`;return {filename,remotePath:`${prefix}/${filename}`,sizeBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};});
  return {...spec,filename:artifacts[0].filename,sha256:artifacts[0].sha256,estimatedDownloadBytes:artifacts.reduce((n,a)=>n+a.sizeBytes,0),artifacts};
}
const groupData=(group:CuratedModel,index:number)=>downloadSplit(index,group.artifacts!.length);
const requestedArtifact=(group:CuratedModel,input:string|URL|Request)=>{const name=decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);const index=group.artifacts!.findIndex(a=>a.filename===name);assert(index>=0);return index;};

test('grouped downloads accept metadata-only secondary shards and resume only the interrupted shard',async t=>{
  const root=await directory(t),group=groupedSpec(),events:PullProgress[]=[],first=groupData(group,0),second=groupData(group,1);await writeFile(path.join(root,group.artifacts![0].filename),first);
  const fetcher:typeof fetch=async(input)=>{assert.equal(requestedArtifact(group,input),1);return response(second.subarray(0,97));};
  await assert.rejects(downloadModel(group,root,{fetch:fetcher,onProgress:p=>events.push(p)}),{code:'DOWNLOAD_INTERRUPTED'});
  assert.deepEqual(await readdir(root),[group.artifacts![0].filename,group.artifacts![1].filename+'.part']);assert(!events.some(e=>e.status==='success'));
  let resumed=0;const retry:typeof fetch=async(input,init)=>{resumed++;assert.equal(requestedArtifact(group,input),1);assert.equal(new Headers(init?.headers).get('range'),'bytes=97-');return response(second.subarray(97),206,{'Content-Range':`bytes 97-${second.length-1}/${second.length}`});};
  await downloadModel(group,root,{fetch:retry,onProgress:p=>events.push(p)});assert.equal(resumed,1);assert.equal(events.at(-1)?.status,'success');assert.equal(events.at(-1)?.completed,group.estimatedDownloadBytes);
  assert.deepEqual(await readFile(path.join(root,group.artifacts![0].filename)),first);assert.deepEqual(await readFile(path.join(root,group.artifacts![1].filename)),second);
});

test('shared metadata can be omitted only by the exact expected secondary split',async t=>{
  const root=await directory(t),secondary=path.join(root,'secondary.gguf'),missingFirst=path.join(root,'first.gguf'),unsplit=path.join(root,'unsplit.gguf');await writeFile(secondary,downloadSplit(1,2));await writeFile(missingFirst,downloadSplit(0,2,[],false));
  const header=Buffer.concat([Buffer.from('GGUF'),uint32(3),uint64(1),uint64(0),ggufString('fixture.weight'),uint32(2),uint64(8),uint64(1),uint32(0),uint64(0)]);await writeFile(unsplit,Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(32)]));
  await assert.rejects(readGGUFMetadata(secondary),{code:'INVALID_GGUF'});await assert.rejects(readGGUFMetadata(secondary,undefined,{split:{index:0,count:2}}),{code:'MODEL_SHARD_MISMATCH'});await assert.rejects(readGGUFMetadata(missingFirst,undefined,{split:{index:0,count:2}}),{code:'INVALID_GGUF'});
  await assert.rejects(readGGUFMetadata(unsplit),{code:'INVALID_GGUF'});await assert.rejects(readGGUFMetadata(unsplit,undefined,{split:{index:1,count:2}}),{code:'MODEL_SHARD_MISMATCH'});const parsed=await readGGUFMetadata(secondary,undefined,{split:{index:1,count:2}});assert.equal(parsed.architecture,'');assert.equal(parsed.chatTemplate,'');
});

test('complete pinned shards cannot publish success when declared shared metadata contradicts the first shard',async t=>{
  for(const extra of [[stringMetadata('general.architecture','different')],[stringMetadata('tokenizer.chat_template','different template')]]){const root=await directory(t),group=groupedSpec(),payloads=[groupData(group,0),downloadSplit(1,2,extra)],artifacts=group.artifacts!.map((a,i)=>({...a,sizeBytes:payloads[i].length,sha256:createHash('sha256').update(payloads[i]).digest('hex')})),events:PullProgress[]=[];const invalid={...group,artifacts,estimatedDownloadBytes:payloads.reduce((n,p)=>n+p.length,0)};
    await assert.rejects(downloadModel(invalid,root,{fetch:async input=>response(payloads[requestedArtifact(invalid,input)]),onProgress:p=>events.push(p)}),{code:'MODEL_SHARD_MISMATCH'});assert(!events.some(e=>e.status==='success'));
  }
});

test('a corrupt later shard cannot become ready and preserves unrelated verified shard bytes',async t=>{
  const root=await directory(t),group=groupedSpec(),first=groupData(group,0),corrupt=groupData(group,1);await writeFile(path.join(root,group.artifacts![0].filename),first);corrupt[corrupt.length-1]^=1;
  await assert.rejects(downloadModel(group,root,{fetch:async(input)=>{assert.equal(requestedArtifact(group,input),1);return response(corrupt);}}),{code:'MODEL_DIGEST_MISMATCH'});
  assert.deepEqual(await readdir(root),[group.artifacts![0].filename]);assert.deepEqual(await readFile(path.join(root,group.artifacts![0].filename)),first);
});

test('group acquisition reserves remaining disk for every shard before making a request',async t=>{
  const root=await directory(t),group=groupedSpec();let requests=0;
  await assert.rejects(downloadModel(group,root,{freeDiskBytes:async()=>512*1024**2+group.artifacts![0].sizeBytes,fetch:async()=>{requests++;return response(bytes);}}),{code:'INSUFFICIENT_STORAGE'});assert.equal(requests,0);assert.deepEqual(await readdir(root),[]);
});

test('independent shard downloads use at most four streams and publish one complete group',async t=>{
  const root=await directory(t),group=groupedSpec(6,'parallel'),initial:{stream:ReadableStreamDefaultController<Uint8Array>;payload:Buffer}[]=[];let active=0,maximum=0,requests=0;
  const fetcher:typeof fetch=async input=>{active++;maximum=Math.max(maximum,active);requests++;const payload=groupData(group,requestedArtifact(group,input));return new Response(new ReadableStream<Uint8Array>({start(stream){const finish=()=>{stream.enqueue(payload);stream.close();active--;};if(requests<=4){initial.push({stream,payload});if(initial.length===4)setTimeout(()=>{for(const selected of initial){selected.stream.enqueue(selected.payload);selected.stream.close();active--;}},20);}else setTimeout(finish,20);}}));};
  const events:PullProgress[]=[];await downloadModel(group,root,{fetch:fetcher,onProgress:p=>events.push(p)});assert.equal(maximum,4);assert.equal(requests,6);assert.equal(events.filter(e=>e.status==='success').length,1);assert.equal(events.at(-1)?.completed,group.estimatedDownloadBytes);for(let i=0;i<group.artifacts!.length;i++)assert.deepEqual(await readFile(path.join(root,group.artifacts![i].filename)),groupData(group,i));
});

test('cancelling a parallel group drains all four streams and resumes their exact pinned ranges',async t=>{
  const root=await directory(t),group=groupedSpec(4,'parallel'),controller=new AbortController();let cancelled=0,requested=0;
  const fetcher:typeof fetch=async input=>{requested++;const payload=groupData(group,requestedArtifact(group,input));return new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(payload.subarray(0,41));},cancel(){cancelled++;}}));};
  await assert.rejects(downloadModel(group,root,{fetch:fetcher,signal:controller.signal,onProgress:p=>{if(p.status==='downloading'&&(p.completed??0)>=4*41)controller.abort();}}),{name:'AbortError'});assert.equal(requested,4);assert.equal(cancelled,4);
  for(let i=0;i<group.artifacts!.length;i++)assert.deepEqual(await readFile(path.join(root,group.artifacts![i].filename+'.part')),groupData(group,i).subarray(0,41));
  let resumed=0;await downloadModel(group,root,{fetch:async(input,init)=>{resumed++;const payload=groupData(group,requestedArtifact(group,input));assert.equal(new Headers(init?.headers).get('range'),'bytes=41-');return response(payload.subarray(41),206,{'Content-Range':`bytes 41-${payload.length-1}/${payload.length}`});}});assert.equal(resumed,4);assert.equal((await readdir(root)).filter(name=>name.endsWith('.part')).length,0);
});

function requestedRange(init:RequestInit|undefined){const match=new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);assert(match);return [Number(match[1]),Number(match[2])];}

test('bounded ranges continue valid shorter 206 replies until the complete pinned hash verifies',async t=>{
  const root=await directory(t),requests:number[][]=[];const fetcher:typeof fetch=async(_input,init)=>{const [start,end]=requestedRange(init);requests.push([start,end]);const actualEnd=Math.min(end,start+47);return response(bytes.subarray(start,actualEnd+1),206,{'Content-Range':`bytes ${start}-${actualEnd}/${bytes.length}`,'Content-Length':String(actualEnd-start+1)});};
  const file=await downloadModel(spec,root,{fetch:fetcher,rangeWindowBytes:64,retryDelayMs:0});assert.deepEqual(await readFile(file),bytes);assert(requests.length>Math.ceil(bytes.length/64));assert(requests.every(([start,end])=>end-start+1<=64));
});

test('truncated bounded responses resume their written prefix automatically without replaying bytes',async t=>{
  const root=await directory(t),ranges:number[][]=[],events:PullProgress[]=[];let first=true;
  const fetcher:typeof fetch=async(_input,init)=>{const [start,end]=requestedRange(init);ranges.push([start,end]);const body=bytes.subarray(start,first?start+23:end+1);first=false;return response(body,206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)});};
  const file=await downloadModel(spec,root,{fetch:fetcher,rangeWindowBytes:64,retryDelayMs:0,onProgress:p=>events.push(p)});assert.deepEqual(await readFile(file),bytes);assert.equal(ranges[1][0],23);assert(events.some(e=>e.status==='retrying'&&e.completed===23));
});

test('network retries are bounded and never hide integrity or invalid-range failures',async t=>{
  const root=await directory(t);let requests=0;
  await assert.rejects(downloadModel(spec,root,{rangeWindowBytes:64,retryDelayMs:0,maxConsecutiveRetries:2,fetch:async()=>{requests++;throw new TypeError('network disconnected');}}),{code:'DOWNLOAD_INTERRUPTED'});assert.equal(requests,3);
  requests=0;await assert.rejects(downloadModel(spec,root,{rangeWindowBytes:64,retryDelayMs:0,fetch:async()=>{requests++;return response(bytes.subarray(0,64),206,{'Content-Range':`bytes 1-64/${bytes.length}`});}}),{code:'INVALID_DOWNLOAD_RANGE'});assert.equal(requests,1);
});

test('a ranged publisher cannot reset an existing large-transfer prefix by ignoring Range',async t=>{
  const root=await directory(t),prefix=bytes.subarray(0,23);await writeFile(path.join(root,spec.filename+'.part'),prefix);
  await assert.rejects(downloadModel(spec,root,{rangeWindowBytes:64,retryDelayMs:0,fetch:async()=>response(bytes,200)}),{code:'INVALID_DOWNLOAD_RANGE'});assert.deepEqual(await readFile(path.join(root,spec.filename+'.part')),prefix);
});

test('cancellation interrupts bounded retry backoff and retains the exact prefix',async t=>{
  const root=await directory(t),controller=new AbortController();let requested=0;
  const fetcher:typeof fetch=async(_input,init)=>{requested++;const [start,end]=requestedRange(init);return response(bytes.subarray(start,start+23),206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`});};
  await assert.rejects(downloadModel(spec,root,{fetch:fetcher,signal:controller.signal,rangeWindowBytes:64,retryDelayMs:1000,onProgress:p=>{if(p.status==='retrying')controller.abort();}}),{name:'AbortError'});assert.equal(requested,1);assert.deepEqual(await readFile(path.join(root,spec.filename+'.part')),bytes.subarray(0,23));
});

function tensorDescriptor(name: string, dimensions: Array<number | bigint>, type = 0, offset: number | bigint = 0) {
  return Buffer.concat([ggufString(name), uint32(dimensions.length), ...dimensions.map(uint64), uint32(type), uint64(offset)]);
}

function tensorFixture(descriptors: Buffer[], data: Buffer, extra: Buffer[] = [], alignment = 32) {
  const records = [
    stringMetadata('general.architecture', 'llama'),
    stringMetadata('tokenizer.chat_template', '{{ messages | tojson }}'),
    ...extra,
    ...(alignment === 32 ? [] : [Buffer.concat([ggufString('general.alignment'), uint32(4), uint32(alignment)])]),
  ];
  const header = Buffer.concat([Buffer.from('GGUF'), uint32(3), uint64(descriptors.length), uint64(records.length), ...records, ...descriptors]);
  const headerPadding = (alignment - header.length % alignment) % alignment;
  return { file: Buffer.concat([header, Buffer.alloc(headerPadding), data]), headerEnd: header.length, dataStart: header.length + headerPadding };
}

function metadataFixture(extra: Buffer) {
  return tensorFixture([tensorDescriptor('fixture.weight', [8, 1])], Buffer.alloc(32), [extra]).file;
}

test('GGUF skipped metadata is bounded by the actual file, including its final value', async t => {
  const root = await directory(t);
  const malformed = [
    Buffer.concat([ggufString('unused.string'), uint32(8), uint64(1000)]),
    Buffer.concat([ggufString('unused.integer'), uint32(10)]),
    Buffer.concat([ggufString('unused.array'), uint32(9), uint32(0), uint64(1000)]),
    Buffer.concat([ggufString('unused.strings'), uint32(9), uint32(8), uint64(1000)]),
  ];
  for (let i = 0; i < malformed.length; i++) {
    const file = path.join(root, `truncated-${i}.gguf`);
    await writeFile(file, metadataFixture(malformed[i]));
    await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
  }
});

test('large numeric tokenizer arrays are skipped without walking every element', { timeout: 2000 }, async t => {
  const root = await directory(t);
  const file = path.join(root, 'numeric-array.gguf');
  const count = 12_000_000;
  await writeFile(file, metadataFixture(Buffer.concat([
    ggufString('tokenizer.scores'), uint32(9), uint32(0), uint64(count), Buffer.alloc(count),
  ])));
  const metadata = await readGGUFMetadata(file);
  assert.equal(metadata.architecture, 'llama');
  assert.equal(metadata.tensorCount, 1);
});

test('GGUF variable tokenizer arrays remain cancellable and close their file', async t => {
  const root = await directory(t);
  const file = path.join(root, 'string-array.gguf');
  const count = 65_536;
  await writeFile(file, metadataFixture(Buffer.concat([
    ggufString('tokenizer.tokens'), uint32(9), uint32(8), uint64(count), Buffer.alloc(count * 8),
  ])));
  const controller = new AbortController();
  const pending = readGGUFMetadata(file, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  // Removing it also exercises handle cleanup on platforms that lock open files.
  await rm(file);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(readGGUFMetadata(file, aborted.signal), { name: 'AbortError' });
});

test('GGUF metadata rejects arrays with unknown element types even when empty', async t => {
  const root = await directory(t);
  const file = path.join(root, 'unknown-array.gguf');
  await writeFile(file, metadataFixture(Buffer.concat([
    ggufString('unused.array'), uint32(9), uint32(999), uint64(0),
  ])));
  await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
});

test('GGUF validates mixed F32/F16/Q4_0/Q4_K/Q6_K storage using the pinned block sizes', async t => {
  const root = await directory(t);
  const file = path.join(root, 'mixed-types.gguf');
  const tensors = [
    { type: 0, width: 8, rows: 1, bytes: 32 },
    { type: 1, width: 8, rows: 1, bytes: 16 },
    { type: 2, width: 32, rows: 2, bytes: 36 },
    { type: 12, width: 256, rows: 2, bytes: 288 },
    { type: 14, width: 256, rows: 2, bytes: 420 },
  ];
  const descriptors: Buffer[] = [], payload: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < tensors.length; i++) {
    const tensor = tensors[i];
    descriptors.push(tensorDescriptor(`fixture.${i}.weight`, [tensor.width, tensor.rows], tensor.type, offset));
    const padded = Math.ceil(tensor.bytes / 32) * 32;
    payload.push(Buffer.alloc(padded));
    offset += padded;
  }
  await writeFile(file, tensorFixture(descriptors, Buffer.concat(payload)).file);
  assert.equal((await readGGUFMetadata(file)).tensorCount, tensors.length);
});

test('GGUF rejects the missing final byte of the last tensor payload', async t => {
  const root = await directory(t);
  const file = path.join(root, 'truncated-payload.gguf');
  const good = tensorFixture([
    tensorDescriptor('first.weight', [8, 1]), tensorDescriptor('last.weight', [8, 1], 0, 32),
  ], Buffer.alloc(64)).file;
  await writeFile(file, good.subarray(0, good.length - 1));
  await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
});

test('GGUF rejects a truncated last tensor descriptor despite complete chat metadata', async t => {
  const root = await directory(t);
  const file = path.join(root, 'truncated-descriptor.gguf');
  const good = tensorFixture([
    tensorDescriptor('first.weight', [8, 1]), tensorDescriptor('last.weight', [8, 1], 0, 32),
  ], Buffer.alloc(64));
  await writeFile(file, good.file.subarray(0, good.headerEnd - 4));
  await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
});

test('GGUF rejects overlapping tensor ranges and descriptors that extend beyond the payload', async t => {
  const root = await directory(t);
  const overlap = path.join(root, 'overlap.gguf');
  await writeFile(overlap, tensorFixture([
    tensorDescriptor('first.weight', [8, 1]), tensorDescriptor('last.weight', [8, 1], 0, 0),
  ], Buffer.alloc(64)).file);
  await assert.rejects(readGGUFMetadata(overlap), { code: 'INVALID_GGUF' });
  const outside = path.join(root, 'outside.gguf');
  await writeFile(outside, tensorFixture([
    tensorDescriptor('first.weight', [8, 1]), tensorDescriptor('last.weight', [16, 1], 0, 32),
  ], Buffer.alloc(64)).file);
  await assert.rejects(readGGUFMetadata(outside), { code: 'INVALID_GGUF' });
});

test('GGUF tensor offsets larger than the metadata cap remain valid', async t => {
  const root = await directory(t);
  const file = path.join(root, 'large-offset.gguf');
  const firstBytes = 64 * 1024 ** 2 + 32;
  const good = tensorFixture([
    tensorDescriptor('first.weight', [firstBytes / 4, 1]),
    tensorDescriptor('last.weight', [8, 1], 0, firstBytes),
  ], Buffer.alloc(0));
  await writeFile(file, good.file);
  // Sparse zero-filled weights avoid loading or allocating a large test model.
  await truncate(file, good.dataStart + firstBytes + 32);
  assert.equal((await readGGUFMetadata(file)).tensorCount, 2);
});

test('GGUF rejects invalid dimensions, removed types, unsafe integers and quantized row sizes', async t => {
  const root = await directory(t);
  const descriptors = [
    tensorDescriptor('weight', [], 0),
    tensorDescriptor('weight', [8, 1, 1, 1, 1], 0),
    tensorDescriptor('weight', [0, 1], 0),
    tensorDescriptor('weight', [8, 1], 4), // Removed Q4_2, not a guessed block size.
    tensorDescriptor('weight', [8, 1], 999),
    tensorDescriptor('weight', [31, 1], 2), // Q4_0 rows require multiples of 32.
    tensorDescriptor('weight', [BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1], 0),
    tensorDescriptor('weight', [8, 1], 0, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
  ];
  for (let i = 0; i < descriptors.length; i++) {
    const file = path.join(root, `invalid-tensor-${i}.gguf`);
    await writeFile(file, tensorFixture([descriptors[i]], Buffer.alloc(32)).file);
    await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
  }
});

test('GGUF honors bounded custom alignment and rejects misaligned offsets or metadata', async t => {
  const root = await directory(t);
  const valid = path.join(root, 'aligned.gguf');
  await writeFile(valid, tensorFixture([tensorDescriptor('weight', [8, 1])], Buffer.alloc(32), [], 4096).file);
  assert.equal((await readGGUFMetadata(valid)).tensorCount, 1);
  for (const alignment of [0, 3, 8192]) {
    const file = path.join(root, `alignment-${alignment}.gguf`);
    const record = Buffer.concat([ggufString('general.alignment'), uint32(4), uint32(alignment)]);
    await writeFile(file, tensorFixture([tensorDescriptor('weight', [8, 1])], Buffer.alloc(32), [record]).file);
    await assert.rejects(readGGUFMetadata(file), { code: 'INVALID_GGUF' });
  }
  const wrongType = path.join(root, 'alignment-type.gguf');
  await writeFile(wrongType, tensorFixture([tensorDescriptor('weight', [8, 1])], Buffer.alloc(32), [
    Buffer.concat([ggufString('general.alignment'), uint32(5), uint32(32)]),
  ]).file);
  await assert.rejects(readGGUFMetadata(wrongType), { code: 'INVALID_GGUF' });
  const offset = path.join(root, 'misaligned-offset.gguf');
  await writeFile(offset, tensorFixture([tensorDescriptor('weight', [8, 1], 0, 1)], Buffer.alloc(64)).file);
  await assert.rejects(readGGUFMetadata(offset), { code: 'INVALID_GGUF' });
});

test('GGUF rejects duplicate metadata/tensor names and oversized retained strings', async t => {
  const root = await directory(t);
  const duplicates = path.join(root, 'duplicate-metadata.gguf');
  await writeFile(duplicates, tensorFixture([tensorDescriptor('weight', [8, 1])], Buffer.alloc(32), [
    stringMetadata('general.architecture', 'different'),
  ]).file);
  await assert.rejects(readGGUFMetadata(duplicates), { code: 'INVALID_GGUF' });
  const tensorNames = path.join(root, 'duplicate-tensors.gguf');
  await writeFile(tensorNames, tensorFixture([
    tensorDescriptor('same.weight', [8, 1]), tensorDescriptor('same.weight', [8, 1], 0, 32),
  ], Buffer.alloc(64)).file);
  await assert.rejects(readGGUFMetadata(tensorNames), { code: 'INVALID_GGUF' });
  const oversized = path.join(root, 'oversized-name.gguf');
  await writeFile(oversized, tensorFixture([tensorDescriptor('weight', [8, 1])], Buffer.alloc(32), [
    stringMetadata('general.name', 'x'.repeat(4097)),
  ]).file);
  await assert.rejects(readGGUFMetadata(oversized), { code: 'INVALID_GGUF' });
});
