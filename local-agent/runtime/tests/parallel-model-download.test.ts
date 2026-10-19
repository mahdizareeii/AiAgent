import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connect, createServer, constants as http2Constants, type ServerHttp2Stream } from 'node:http2';
import { createHttp2ArtifactFetcher, downloadPinnedModels, downloadPinnedModelsOrdered, retainedPinnedModelBytes } from '../../../scripts/parallel-model-download.ts';
import { acquireCodingDownloadLock, mergeCodingDownloadRecords, parseCodingDownloadOptions, publishCodingDownloadManifest } from '../../../scripts/download-coding-models.ts';
import { MODEL_CATALOG, type CuratedModel } from '../catalog.ts';
import type { fetchArtifact } from '../download.ts';

const uint32 = (value: number) => { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; };
const uint64 = (value: number) => { const result = Buffer.alloc(8); result.writeBigUInt64LE(BigInt(value)); return result; };
const string = (value: string) => { const result = Buffer.from(value); return Buffer.concat([uint64(result.length), result]); };
const metadata = (key: string, value: string) => Buffer.concat([string(key), uint32(8), string(value)]);
const header = Buffer.concat([Buffer.from('GGUF'), uint32(3), uint64(1), uint64(2),
  metadata('general.architecture', 'llama'), metadata('tokenizer.chat_template', '{{ messages | tojson }}'),
  string('token_embd.weight'), uint32(1), uint64(8), uint32(0), uint64(0)]);
const bytes = Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), Buffer.alloc(32)]);
const spec: CuratedModel = { id: 'test:parallel', title: 'Offline range fixture', description: 'No model weights',
  estimatedDownloadBytes: bytes.length, minimumMemoryGB: 1, workingMemoryGB: 1, license: 'Apache-2.0',
  sourceUrl: 'https://huggingface.co/local-agent/offline-fixture', quantization: 'F32', repository: 'local-agent/offline-fixture',
  revision: 'a'.repeat(40), filename: 'tiny parallel.gguf', sha256: createHash('sha256').update(bytes).digest('hex'), architecture: 'llama', toolCapable: true };
const rangePath = (directory: string, model = spec) => path.join(directory, '.ranges', model.id.replace(/[^a-z0-9]/gi, '-'), model.revision, '0');
const requestRange = (init: RequestInit) => {
  const match = new Headers(init.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
  return { from: Number(match[1]), end: Number(match[2]) };
};
const response = (data: Uint8Array, from: number, end: number, total: number) => new Response(new ReadableStream({
  start(controller) { controller.enqueue(data); controller.close(); },
}), {
  status: 206, headers: { 'Content-Range': `bytes ${from}-${end}/${total}`, 'Content-Length': String(end - from + 1) },
});
async function directory(t: TestContext) {
  const value = await mkdtemp(path.join(tmpdir(), 'local-agent-parallel-download-'));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test('parallel acquisition resumes exact retained prefixes and verifies full SHA plus GGUF before publishing', async t => {
  const root = await directory(t), offset = 97, requested: string[] = [], statuses: string[] = [];
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, offset));
  const fetcher: typeof fetchArtifact = async (url, init) => {
    assert.equal(url, `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/tiny%20parallel.gguf`);
    assert.equal(new Headers(init.headers).get('accept-encoding'), 'identity');
    const { from, end } = requestRange(init); requested.push(`${from}-${end}`);
    return response(bytes.subarray(from, end + 1), from, end, bytes.length);
  };
  await downloadPinnedModels([spec], root, new AbortController().signal, (_id, status) => statuses.push(status), { fetch: fetcher });
  assert.deepEqual(requested, [`${offset}-${bytes.length - 1}`]);
  assert.deepEqual(await readFile(path.join(root, spec.filename)), bytes);
  assert.equal(statuses.at(-1), 'success');
  let contacted = false;
  await downloadPinnedModels([spec], root, new AbortController().signal, () => {}, { fetch: async () => { contacted = true; throw new Error('A verified artifact must be reused.'); } });
  assert.equal(contacted, false);
  await assert.rejects(downloadPinnedModels([{ ...spec, architecture: 'wrong' }], root, new AbortController().signal, () => {},
    { fetch: fetcher }), /architecture differs/);
});

test('range validation fails closed before appending on wrong start, insufficient end, total, format, status or length', async t => {
  const cases: [number, Record<string, string>][] = [
    [206, { 'Content-Range': `bytes 98-${bytes.length - 1}/${bytes.length}` }],
    [206, { 'Content-Range': `bytes 97-${bytes.length - 2}/${bytes.length}` }],
    [206, { 'Content-Range': `bytes 97-${bytes.length}/${bytes.length}` }],
    [206, { 'Content-Range': `bytes 97-${bytes.length - 1}/${bytes.length + 1}` }],
    [206, { 'Content-Range': `bytes 97-${bytes.length - 1}/*` }],
    [206, {}],
    [200, { 'Content-Range': `bytes 97-${bytes.length - 1}/${bytes.length}` }],
    [206, { 'Content-Range': `bytes 97-${bytes.length - 1}/${bytes.length}`, 'Content-Length': '1' }],
  ];
  for (const [status, headers] of cases) {
    const root = await directory(t), details: string[] = [];
    await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, 97));
    let attempts = 0;
    await assert.rejects(downloadPinnedModels([spec], root, new AbortController().signal, (_id, state, _size, detail) => {
      if (state === 'retrying') details.push(detail!);
    }, { retryDelayMs: 0, fetch: async () => { attempts++; return new Response(bytes.subarray(97), { status, headers }); } }), /pinned byte range|Content-Length/);
    assert.equal(attempts, 4, 'A malformed publisher response has a bounded retry count.');
    assert.equal(details.length, 3); assert.ok(details.every(detail => /pinned byte range|Content-Length/.test(detail)));
    assert.deepEqual(await readFile(rangePath(root)), bytes.subarray(0, 97));
    await assert.rejects(lstat(path.join(root, spec.filename)), { code: 'ENOENT' });
  }
});

test('a publisher suffix response is bounded and cancelled at the requested window before whole-file verification', async t => {
  const root = await directory(t), large = Buffer.alloc(32 * 1024 * 1024 + bytes.length);
  bytes.copy(large); const largeSpec = { ...spec, estimatedDownloadBytes: large.length, sha256: createHash('sha256').update(large).digest('hex') };
  const starts: number[] = []; let cancelled = 0;
  await downloadPinnedModels([largeSpec], root, new AbortController().signal, () => {}, { workers: 2, fetch: async (_url, init) => {
    const { from } = requestRange(init); starts.push(from);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(large.subarray(from)); }, cancel() { cancelled++; } }), {
      status: 206, headers: { 'Content-Range': `bytes ${from}-${large.length - 1}/${large.length}`, 'Content-Length': String(large.length - from) },
    });
  } });
  assert.deepEqual(starts.sort((a, b) => a - b), [0, 8 * 1024 * 1024, 16 * 1024 * 1024, 24 * 1024 * 1024, 32 * 1024 * 1024]);
  assert.equal(cancelled, 5);
  assert.equal((await lstat(rangePath(root, largeSpec))).size, 32 * 1024 * 1024);
  assert.deepEqual(await readFile(path.join(root, spec.filename)), large);
});

test('cancellation retains exact received bytes and a subsequent run resumes without replaying them', async t => {
  const root = await directory(t), controller = new AbortController(); let cancelled = false;
  await assert.rejects(downloadPinnedModels([spec], root, controller.signal, (_id, state, size) => {
    if (state === 'downloading' && size === 97) controller.abort(new Error('Fixture cancellation'));
  }, { fetch: async (_url, init) => {
    const { from, end } = requestRange(init);
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 97)); }, cancel() { cancelled = true; } }), {
      status: 206, headers: { 'Content-Range': `bytes ${from}-${end}/${bytes.length}` },
    });
  } }), /Fixture cancellation/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readFile(rangePath(root)), bytes.subarray(0, 97));
  await assert.rejects(lstat(path.join(root, spec.filename)), { code: 'ENOENT' });
  await downloadPinnedModels([spec], root, new AbortController().signal, () => {}, { fetch: async (_url, init) => {
    const { from, end } = requestRange(init); assert.equal(from, 97);
    return response(bytes.subarray(from), from, end, bytes.length);
  } });
  assert.deepEqual(await readFile(path.join(root, spec.filename)), bytes);
});

test('whole-file checksum or architecture mismatch never publishes retained or downloaded ranges', async t => {
  for (const mode of ['checksum', 'architecture', 'retained']) {
    const root = await directory(t), corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
    const wanted = mode === 'architecture' ? { ...spec, architecture: 'wrong' } : spec;
    if (mode === 'retained') {
      const file = rangePath(root);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, corrupted);
    }
    await assert.rejects(downloadPinnedModels([wanted], root, new AbortController().signal, () => {}, { fetch: async (_url, init) => {
      assert.notEqual(mode, 'retained', 'A complete retained range must be verified instead of downloaded again.');
      const { from, end } = requestRange(init); return response(mode === 'checksum' ? corrupted : bytes, from, end, bytes.length);
    } }), /publisher SHA-256|architecture differs/);
    await assert.rejects(lstat(path.join(root, spec.filename)), { code: 'ENOENT' });
  }
});

test('workers are bounded and already-cancelled acquisition starts no network or filesystem work', async t => {
  const root = await directory(t), models = Array.from({ length: 17 }, (_, index) => ({ ...spec, id: `test:${index}`, filename: `tiny-${index}.gguf` }));
  let active = 0, peak = 0, calls = 0;
  await downloadPinnedModels(models, root, new AbortController().signal, () => {}, { fetch: async (_url, init) => {
    active++; peak = Math.max(peak, active); calls++; await delay(10); active--;
    const { from, end } = requestRange(init); return response(bytes, from, end, bytes.length);
  } });
  assert.equal(calls, 17); assert.ok(peak > 1 && peak <= 16);
  for (const workers of [0, 17, 1.5]) {
    await assert.rejects(downloadPinnedModels([], root, new AbortController().signal, () => {}, { workers }), /between 1 and 16/);
  }
  const controller = new AbortController(); controller.abort(new Error('Already cancelled'));
  const absent = path.join(root, 'must-not-be-created');
  await assert.rejects(downloadPinnedModels([spec], absent, controller.signal, () => {}, { fetch: async () => { throw new Error('Must not fetch.'); } }), /Already cancelled/);
  assert.deepEqual((await readdir(root)).filter(name => name === 'must-not-be-created'), []);
});

test('retry backoff can be cancelled immediately instead of waiting for another network attempt', async t => {
  const root = await directory(t), controller = new AbortController(); let attempts = 0;
  await assert.rejects(downloadPinnedModels([spec], root, controller.signal, (_id, state) => {
    if (state === 'retrying') controller.abort(new Error('Stop retries'));
  }, { retryDelayMs: 3000, fetch: async () => { attempts++; throw new Error('Fixture transient network error'); } }));
  assert.equal(attempts, 1);
});

test('smaller wire windows preserve the retained 32MiB chunk layout and append only missing exact bytes', async t => {
  const root = await directory(t), offset = 97, ranges: { from: number; end: number }[] = [];
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, offset));
  await downloadPinnedModels([spec], root, new AbortController().signal, () => {}, { requestWindowBytes: 64,
    fetch: async (_url, init) => { const range = requestRange(init); ranges.push(range); return response(bytes.subarray(range.from, range.end + 1), range.from, range.end, bytes.length); } });
  assert.equal(ranges[0].from, offset);
  assert.ok(ranges.length > 1); assert.ok(ranges.every(range => range.end - range.from + 1 <= 64));
  assert.equal(ranges.at(-1)!.end, bytes.length - 1);
  assert.deepEqual(await readFile(rangePath(root)), bytes); assert.deepEqual(await readFile(path.join(root, spec.filename)), bytes);
});

test('HTTP/2 artifact transport reuses approved connections, enlarges receive windows and refuses credentials or off-host redirects', async t => {
  const server = createServer(), seen: Record<string, unknown>[] = []; let connections = 0;
  server.on('stream', (rawStream, headers) => {
    const stream = rawStream as ServerHttp2Stream;
    seen.push(headers);
    if (headers[':path'] === '/redirect') { stream.respond({ ':status': 302, location: 'https://evil.invalid/unapproved' }); stream.end(); }
    else { stream.respond({ ':status': 206, 'content-range': 'bytes 0-3/4', 'content-length': '4' }); stream.end('tiny'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const network = createHttp2ArtifactFetcher({ connect: (_origin, options) => {
    connections++; assert.equal(options.settings?.initialWindowSize, 4 * 1024 * 1024); assert.equal(options.settings?.enablePush, false);
    return connect(`http://127.0.0.1:${address.port}`, options);
  } });
  t.after(async () => { network.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  for (let index = 0; index < 2; index++) {
    const result = await network.fetch('https://huggingface.co/file', { headers: { Range: 'bytes=0-3', 'Accept-Encoding': 'identity' } });
    assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), 'bytes 0-3/4'); assert.equal(await result.text(), 'tiny');
  }
  assert.equal(connections, 1); assert.equal(seen[0].range, 'bytes=0-3'); assert.equal(seen[0].authorization, undefined);
  await assert.rejects(network.fetch('https://huggingface.co/file', { headers: { Authorization: 'do-not-forward' } }), /credentials or extra headers/);
  await assert.rejects(network.fetch('https://huggingface.co/redirect', {}), /approved artifact hosts/);
  assert.equal(connections, 1, 'A credential or off-host redirect cannot open another connection.');
});

test('HTTP/2 cancellation stops only its stream and a pre-header reset fails without hanging the shared session', async t => {
  const server = createServer();
  server.on('stream', (rawStream, headers) => {
    const stream = rawStream as ServerHttp2Stream;
    stream.on('error', () => {});
    if (headers[':path'] === '/reset') stream.close(http2Constants.NGHTTP2_CANCEL);
    else if (headers[':path'] === '/waiting') { stream.respond({ ':status': 206, 'content-range': 'bytes 0-3/4' }); stream.write('t'); }
    else { stream.respond({ ':status': 206, 'content-range': 'bytes 0-3/4' }); stream.end('tiny'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const network = createHttp2ArtifactFetcher({ connect: (_origin, options) => connect(`http://127.0.0.1:${address.port}`, options) });
  t.after(async () => { network.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const controller = new AbortController();
  const responseValue = await network.fetch('https://huggingface.co/waiting', { signal: controller.signal });
  const consuming = responseValue.text(); controller.abort(new Error('Cancel this transfer only'));
  await assert.rejects(consuming, /Cancel this transfer only|aborted/);
  await assert.rejects(network.fetch('https://huggingface.co/reset', { signal: AbortSignal.timeout(1000) }), /closed before response headers/);
  assert.equal(await (await network.fetch('https://huggingface.co/healthy', {})).text(), 'tiny');
});

test('download CLI constrains workers/transports and exclusive task lock prevents a second writer', async t => {
  const root = await directory(t);
  assert.deepEqual(parseCodingDownloadOptions([]), { ids: ['qwen3.8:27b', 'muse-glimmer:30b'], workers: 16, transport: 'http2', order: 'parallel' });
  assert.deepEqual(parseCodingDownloadOptions(['muse-glimmer:30b', '--workers', '4', '--transport', 'fetch']), { ids: ['muse-glimmer:30b'], workers: 4, transport: 'fetch', order: 'parallel' });
  assert.deepEqual(parseCodingDownloadOptions(['muse-glimmer:30b', 'qwen3.8:27b', '--order', 'sequential']), { ids: ['qwen3.8:27b', 'muse-glimmer:30b'], workers: 16, transport: 'http2', order: 'sequential' });
  assert.deepEqual(parseCodingDownloadOptions(['muse-glimmer:30b-q3-k-m', 'qwen3.8:27b-q3-k-m', '--order', 'sequential']).ids, ['qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m']);
  assert.deepEqual(parseCodingDownloadOptions(['muse-glimmer:30b', 'qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m', 'qwen3.8:27b', '--order', 'sequential']).ids,
    ['qwen3.8:27b-q3-k-m', 'qwen3.8:27b', 'muse-glimmer:30b', 'muse-glimmer:30b-q3-k-m']);
  for (const args of [['qwen3.8:27b', 'qwen3.8:27b'], ['--workers', '17'], ['--transport', 'other'], ['--order', 'other'], ['--order'], ['unapproved:model']]) assert.throws(() => parseCodingDownloadOptions(args));
  const release = await acquireCodingDownloadLock(root);
  await assert.rejects(acquireCodingDownloadLock(root), /active downloader/);
  await release(); assert.deepEqual(await readdir(root), []);
  const again = await acquireCodingDownloadLock(root); await again();
});

test('a Q3 manifest merge retains known verified Q4 pins and cannot carry their proof onto another quantization', () => {
  const models = '/owned/models', q4 = MODEL_CATALOG.filter(item => ['qwen3.8:27b', 'muse-glimmer:30b'].includes(item.id));
  const prior = q4.map(item => ({ model: item.id, file: path.join(models, item.filename), revision: item.revision, sha256: item.sha256, bytes: item.estimatedDownloadBytes }));
  const q3 = MODEL_CATALOG.filter(item => ['qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m'].includes(item.id)); assert.equal(q3.length, 2);
  const merged = mergeCodingDownloadRecords(prior, q3, models);
  assert.deepEqual(merged.slice(0, 2), prior); assert.equal(merged.length, 4);
  for (const spec of q3) {
    const actual = merged.find(item => item.model === spec.id)!;
    assert.equal(actual.quantization, 'Q3_K_M'); assert.equal(actual.sha256, spec.sha256); assert.equal(actual.revision, spec.revision);
    assert.equal(actual.repository, spec.repository); assert.equal(actual.file, path.join(models, spec.filename));
    assert.notEqual(actual.sha256, prior.find(item => item.model === spec.id.replace('-q3-k-m', ''))!.sha256);
    assert.equal('qualified' in actual, false); assert.equal('probePassed' in actual, false);
  }
  for (const corrupted of [[...prior, prior[0]], [{ ...prior[0], model: 'unapproved:model' }], [{ ...prior[0], sha256: '0'.repeat(64) }],
    [{ ...prior[0], file: '/outside/weights.gguf' }], [{ ...prior[0], qualified: true }]]) assert.throws(() => mergeCodingDownloadRecords(corrupted, q3, models), /unknown|duplicate|known publisher pin/);
  assert.throws(() => mergeCodingDownloadRecords(prior, [{ ...q3[0], sha256: q4[0].sha256 }], models), /newly verified known catalog pins/);
});

test('manifest publication atomically appends only new verified variants and preserves original model files', async t => {
  const root = await realpath(await directory(t)), models = path.join(root, 'models'); await mkdir(models, { mode: 0o700 });
  const q4 = { ...spec, id: 'qwen3.8:27b', filename: 'original-q4.gguf', quantization: 'Q4_K_M' }, q3 = { ...spec, id: 'qwen3.8:27b-q3-k-m', filename: 'new-q3.gguf', quantization: 'Q3_K_M' };
  await writeFile(path.join(models, q4.filename), bytes); const before = await lstat(path.join(models, q4.filename));
  const manifest = path.join(root, 'downloads.json'), prior = [{ model: q4.id, file: path.join(models, q4.filename), revision: q4.revision, sha256: q4.sha256, bytes: bytes.length }];
  await writeFile(manifest, JSON.stringify(prior) + '\n', { mode: 0o600 });
  let calls = 0;
  await downloadPinnedModelsOrdered([q3], models, new AbortController().signal, () => {}, { order: 'sequential', fetch: async (url, init) => {
    calls++; assert.ok(url.endsWith('/new-q3.gguf'), 'The original Q4 artifact is never fetched again.');
    const { from, end } = requestRange(init); return response(bytes.subarray(from, end + 1), from, end, bytes.length);
  } });
  await publishCodingDownloadManifest(manifest, [q3], models, [q4, q3]);
  const saved = JSON.parse(await readFile(manifest, 'utf8')); assert.deepEqual(saved[0], prior[0]); assert.equal(saved[1].model, q3.id); assert.equal(saved[1].quantization, 'Q3_K_M');
  assert.equal(calls, 1); const after = await lstat(path.join(models, q4.filename)); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(path.join(models, q4.filename)), bytes); assert.deepEqual((await readdir(root)).sort(), ['downloads.json', 'models']);
  const malformed = '[{"model":"unknown"}]\n'; await writeFile(manifest, malformed);
  await assert.rejects(publishCodingDownloadManifest(manifest, [q3], models, [q4, q3]), /unknown/); assert.equal(await readFile(manifest, 'utf8'), malformed);
  await writeFile(manifest, ' '.repeat(64 * 1024 + 1)); await assert.rejects(publishCodingDownloadManifest(manifest, [q3], models, [q4, q3]), /bounded ordinary/);
  await rm(manifest); const unrelated = path.join(root, 'unrelated.json'); await writeFile(unrelated, JSON.stringify(prior)); await symlink(unrelated, manifest);
  await assert.rejects(publishCodingDownloadManifest(manifest, [q3], models, [q4, q3]), /non-symlink/); assert.equal(await readFile(unrelated, 'utf8'), JSON.stringify(prior));
});

test('sequential acquisition resumes both models and publishes the first verified final before requesting the second payload', async t => {
  const root = await directory(t), second = { ...spec, id: 'test:second', filename: 'second.gguf' };
  await writeFile(path.join(root, `${spec.filename}.part`), bytes.subarray(0, 97));
  await writeFile(path.join(root, `${second.filename}.part`), bytes.subarray(0, 51));
  assert.equal(await retainedPinnedModelBytes(spec, root, new AbortController().signal), 97);
  assert.equal(await retainedPinnedModelBytes(second, root, new AbortController().signal), 51);
  const models: string[] = [];
  await downloadPinnedModelsOrdered([spec, second], root, new AbortController().signal, () => {}, { order: 'sequential',
    fetch: async (url, init) => {
      const isSecond = url.endsWith('/second.gguf'), { from, end } = requestRange(init);
      models.push(isSecond ? second.id : spec.id);
      if (isSecond) {
        assert.deepEqual(await readFile(path.join(root, spec.filename)), bytes, 'The first artifact is fully verified and atomically published.');
        assert.equal(from, 51);
      } else { assert.equal(from, 97); await assert.rejects(lstat(path.join(root, second.filename)), { code: 'ENOENT' }); }
      return response(bytes.subarray(from, end + 1), from, end, bytes.length);
    } });
  assert.deepEqual(models, [spec.id, second.id]);
  assert.deepEqual(await readFile(path.join(root, second.filename)), bytes);
  assert.equal(await retainedPinnedModelBytes(spec, root, new AbortController().signal), bytes.length);
});

test('sequential order never begins another model when the first checksum fails', async t => {
  const root = await directory(t), second = { ...spec, id: 'test:second', filename: 'second.gguf' };
  const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
  let requests = 0;
  await assert.rejects(downloadPinnedModelsOrdered([spec, second], root, new AbortController().signal, () => {}, { order: 'sequential', fetch: async (url, init) => {
    assert.ok(!url.endsWith('/second.gguf')); requests++;
    const { from, end } = requestRange(init); return response(corrupted.subarray(from, end + 1), from, end, bytes.length);
  } }), /publisher SHA-256/);
  assert.equal(requests, 1); await assert.rejects(lstat(path.join(root, second.filename)), { code: 'ENOENT' });
});
