import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { MODEL_CATALOG, type CuratedModel } from '../catalog.ts';
import { acquireCodingDownloadLock } from '../../../scripts/download-coding-models.ts';
import { assertPublicLargeModelPin, downloadLargeModel, LARGE_MODEL_ID, parseLargeModelDownloadOptions } from '../../../scripts/download-large-model.ts';

const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const str = (value: string) => { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]); };
function shard(index: number) {
  const number = (key: string, value: number) => Buffer.concat([str(key), u32(4), u32(value)]);
  const text = (key: string, value: string) => Buffer.concat([str(key), u32(8), str(value)]);
  const records = [...(index === 0 ? [text('general.architecture', 'llama'), text('tokenizer.chat_template', '{{ messages | tojson }}')] : []),
    number('split.no', index), number('split.count', 4), number('split.tensors.count', 4)];
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(records.length), ...records,
    str(`fixture.${index}.weight`), u32(1), u64(8), u32(0), u64(0)]);
  return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), Buffer.alloc(32, index)]);
}
const payloads = Array.from({ length: 4 }, (_, index) => shard(index));
const artifacts = payloads.map((payload, index) => ({ filename: `tiny-${index}.gguf`, remotePath: `nested/tiny-${index}.gguf`,
  sizeBytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }));
const spec: CuratedModel = { id: 'test:large-wrapper', title: 'Four tiny offline shards', description: 'No real model weights',
  repository: 'local-agent/offline-fixture', revision: 'a'.repeat(40), license: 'Apache-2.0', sourceUrl: 'https://huggingface.co/local-agent/offline-fixture',
  quantization: 'F32', architecture: 'llama', toolCapable: true, minimumMemoryGB: 1, workingMemoryGB: 1,
  filename: artifacts[0].filename, sha256: artifacts[0].sha256, artifacts, estimatedDownloadBytes: artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) };
async function directory(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'large-model-download-test-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), index = artifacts.findIndex(artifact => url.pathname.endsWith('/' + artifact.remotePath));
  assert(index >= 0); assert.equal(url.origin, 'https://huggingface.co');
  const [, start, finish] = new Headers(init?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
  const from = Number(start), end = Number(finish), payload = payloads[index];
  return new Response(payload.subarray(from, end + 1), { status: 206,
    headers: { 'Content-Range': `bytes ${from}-${end}/${payload.length}`, 'Content-Length': String(end - from + 1) } });
};

test('large-model CLI permits only the independently pinned official four-shard conversion', () => {
  const official = MODEL_CATALOG.find(item => item.id === LARGE_MODEL_ID)!;
  assertPublicLargeModelPin(official);
  assert.equal(official.artifacts!.reduce((total, artifact) => total + artifact.sizeBytes, 0), 48410992032);
  for (const altered of [{ ...official, revision: 'b'.repeat(40) }, { ...official, license: 'unknown' },
    { ...official, artifacts: official.artifacts!.map((artifact, index) => index ? artifact : { ...artifact, remotePath: artifact.filename }) },
    { ...official, artifacts: official.artifacts!.map((artifact, index) => index ? artifact : { ...artifact, sha256: '0'.repeat(64) }) }]) {
    assert.throws(() => assertPublicLargeModelPin(altered), /official public shard pins/);
  }
  assert.deepEqual(parseLargeModelDownloadOptions([]), { transport: 'http2' });
  assert.deepEqual(parseLargeModelDownloadOptions(['--transport', 'fetch']), { transport: 'fetch' });
  for (const args of [['other:model'], ['--transport', 'cloud'], ['--directory', '/tmp'], ['--transport']]) assert.throws(() => parseLargeModelDownloadOptions(args));
});

test('large-model wrapper publishes one isolated manifest only after every production SHA and shard-set check', async t => {
  const root = await directory(t), originalManifest = path.join(root, 'coding-downloads.json');
  await writeFile(originalManifest, 'keep original Qwen3.8 and Muse records');
  await writeFile(path.join(root, artifacts[0].filename), payloads[0]);
  await writeFile(path.join(root, artifacts[1].filename + '.part'), payloads[1].subarray(0, 97));
  const result = await downloadLargeModel(spec, root, { fetch: fetcher, rangeWindowBytes: 64 });
  assert.equal(result.manifest, path.join(root, 'downloads.json'));
  assert.equal(result.record.complete, true); assert.equal(result.record.nativeReadiness, false); assert.equal(result.record.codingQualification, false);
  assert.equal(result.record.chatTemplateSha256, createHash('sha256').update('{{ messages | tojson }}').digest('hex'));
  for (let index = 0; index < artifacts.length; index++) assert.deepEqual(await readFile(result.record.files[index].file), payloads[index]);
  assert.equal(await readFile(originalManifest, 'utf8'), 'keep original Qwen3.8 and Muse records');
  await assert.rejects(lstat(path.join(root, '.download-lock.json')), { code: 'ENOENT' });
  const previous = await readFile(result.manifest, 'utf8');
  await downloadLargeModel(spec, root, { fetch: async () => { throw new Error('Verified shards must be reused.'); } });
  assert.equal(await readFile(result.manifest, 'utf8'), previous);
});

test('insufficient disk or an existing downloader prevents acquisition without publishing completion', async t => {
  const root = await directory(t); let calls = 0;
  await assert.rejects(downloadLargeModel(spec, root, { freeDiskBytes: async () => 0, fetch: async () => { calls++; throw new Error('Must not fetch.'); } }), { code: 'INSUFFICIENT_STORAGE' });
  assert.equal(calls, 0); await assert.rejects(lstat(path.join(root, 'downloads.json')), { code: 'ENOENT' });
  const release = await acquireCodingDownloadLock(root);
  try { await assert.rejects(downloadLargeModel(spec, root, { fetch: async () => { calls++; throw new Error('Must not fetch.'); } }), /active downloader/); }
  finally { await release(); }
  assert.equal(calls, 0);
});

test('failed or cancelled group acquisition preserves completed shards and releases only its owned lock', async t => {
  const root = await directory(t); await writeFile(path.join(root, artifacts[0].filename), payloads[0]);
  await assert.rejects(downloadLargeModel(spec, root, { rangeWindowBytes: 64, maxConsecutiveRetries: 0,
    fetch: async () => { throw new TypeError('Offline fixture connection failed.'); } }));
  assert.deepEqual(await readFile(path.join(root, artifacts[0].filename)), payloads[0]);
  await assert.rejects(lstat(path.join(root, 'downloads.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(root, '.download-lock.json')), { code: 'ENOENT' });
  const controller = new AbortController();
  await assert.rejects(downloadLargeModel(spec, root, { signal: controller.signal, rangeWindowBytes: 64, fetch: fetcher,
    onProgress: event => { if (event.status === 'downloading' && event.completed) controller.abort(new Error('Owned fixture cancellation')); } }));
  await assert.rejects(lstat(path.join(root, 'downloads.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(root, '.download-lock.json')), { code: 'ENOENT' });
});

test('large-model wrapper preserves unexpected or concurrently replaced manifests', async t => {
  const root = await directory(t), manifest = path.join(root, 'downloads.json');
  await writeFile(manifest, JSON.stringify({ unknown: 'do not replace' }));
  await assert.rejects(downloadLargeModel(spec, root, { fetch: fetcher, rangeWindowBytes: 64 }), /manifest differs/);
  assert.equal(await readFile(manifest, 'utf8'), '{"unknown":"do not replace"}'); await rm(manifest);
  await assert.rejects(downloadLargeModel(spec, root, { fetch: fetcher, rangeWindowBytes: 64,
    onProgress: event => { if (event.status === 'success') writeFileSync(manifest, '{"anotherOwner":"preserve"}'); } }), /manifest changed before publication/);
  assert.equal(await readFile(manifest, 'utf8'), '{"anotherOwner":"preserve"}');
});

test('large-model wrapper rejects symlinked cache or manifest rather than writing outside its isolated ownership', async t => {
  const root = await directory(t), target = await directory(t), link = path.join(root, 'linked-cache');
  await symlink(target, link); await assert.rejects(downloadLargeModel(spec, link, { fetch: fetcher }), /non-symlink/);
  const outside = path.join(target, 'manifest.json'); await writeFile(outside, 'preserve external data');
  await symlink(outside, path.join(root, 'downloads.json'));
  await assert.rejects(downloadLargeModel(spec, root, { fetch: fetcher }), /bounded ordinary file/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve external data');
});
