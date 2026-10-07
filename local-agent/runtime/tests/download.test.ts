import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CuratedModel } from '../catalog.ts';
import { downloadModel, type PullProgress } from '../download.ts';
import { readGGUFMetadata } from '../gguf.ts';

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
