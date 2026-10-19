import { createReadStream } from 'node:fs';
import { mkdir, open, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type ClientHttp2Session, type ClientSessionOptions, constants as http2Constants } from 'node:http2';
import { Readable } from 'node:stream';
import type { CuratedModel } from '../local-agent/runtime/catalog.ts';
import { fetchArtifact } from '../local-agent/runtime/download.ts';
import { readGGUFMetadata, sha256File } from '../local-agent/runtime/gguf.ts';

const WINDOW = 32 * 1024 * 1024;
export type DownloadOrder = 'parallel' | 'sequential';
/** Count existing acquisition bytes without treating an unverified artifact as ready. */
export async function retainedPinnedModelBytes(spec: CuratedModel, directory: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const destination = path.join(directory, spec.filename);
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.estimatedDownloadBytes) throw new Error('Existing test weights do not match their pinned artifact size.');
    return info.size;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let prefixSize = 0;
  try {
    const info = await lstat(`${destination}.part`);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The retained download must be a regular file.');
    prefixSize = Math.min(info.size, spec.estimatedDownloadBytes);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const chunks = path.join(directory, '.ranges', spec.id.replace(/[^a-z0-9]/gi, '-'), spec.revision);
  let retained = 0;
  for (let start = 0, index = 0; start < spec.estimatedDownloadBytes; start += WINDOW, index++) {
    signal.throwIfAborted();
    const length = Math.min(WINDOW, spec.estimatedDownloadBytes - start);
    let found = 0;
    try {
      const info = await lstat(path.join(chunks, String(index)));
      if (!info.isFile() || info.isSymbolicLink() || info.size > length) throw new Error('A retained range is invalid or exceeds its pinned size.');
      found = info.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    retained += found || Math.max(0, Math.min(prefixSize - start, length));
  }
  return retained;
}

/** One caller retains ownership of the lock/transport while each ordered artifact verifies. */
export async function downloadPinnedModelsOrdered(specs: readonly CuratedModel[], directory: string, signal: AbortSignal,
  progress: (model: string, status: string, bytes: number, detail?: string) => void,
  options: Parameters<typeof downloadPinnedModels>[4] & { order?: DownloadOrder } = {}) {
  if (options.order !== undefined && !['parallel', 'sequential'].includes(options.order)) throw new Error('Use parallel or sequential download order.');
  if (options.order === 'sequential') {
    for (const spec of specs) { signal.throwIfAborted(); await downloadPinnedModels([spec], directory, signal, progress, options); }
  } else await downloadPinnedModels(specs, directory, signal, progress, options);
}
/** Reuse approved TLS connections with receive windows sized for long-latency artifact transfers. */
export function createHttp2ArtifactFetcher(options: { connect?: (origin: string, options: ClientSessionOptions) => ClientHttp2Session } = {}) {
  const sessions = new Map<string, ClientHttp2Session>();
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const approved = url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co') || url.hostname === 'cdn-lfs.hf.co'
      || url.hostname.endsWith('.hf.co') || url.hostname.endsWith('.xethub.hf.co');
    if (url.protocol !== 'https:' || !approved || url.username || url.password || init.body || init.method && init.method !== 'GET') throw new Error('Artifact HTTP/2 transport permits only approved public HTTPS GET requests.');
    init.signal?.throwIfAborted();
    const headers: Record<string, string> = { ':method': 'GET', ':path': url.pathname + url.search };
    new Headers(init.headers).forEach((value, key) => {
      if (!['range', 'accept-encoding'].includes(key)) throw new Error('The public artifact transport does not forward credentials or extra headers.');
      headers[key] = value;
    });
    let session = sessions.get(url.origin);
    if (!session || session.closed || session.destroyed) {
      session = (options.connect ?? connect)(url.origin, { settings: { initialWindowSize: 4 * 1024 * 1024, enablePush: false } });
      const owned = session;
      sessions.set(url.origin, owned);
      owned.on('connect', () => owned.setLocalWindowSize(16 * 1024 * 1024));
      owned.on('error', () => { if (sessions.get(url.origin) === owned) sessions.delete(url.origin); });
      owned.on('goaway', () => { if (sessions.get(url.origin) === owned) sessions.delete(url.origin); owned.close(); });
      owned.on('close', () => { if (sessions.get(url.origin) === owned) sessions.delete(url.origin); });
    }
    const stream = session.request(headers);
    const abort = () => stream.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Artifact transfer cancelled.'));
    init.signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => init.signal?.removeEventListener('abort', abort));
    if (init.signal?.aborted) abort();
    return new Promise<Response>((resolve, reject) => {
      let responded = false;
      stream.once('error', reject);
      stream.once('close', () => { if (!responded) reject(new Error('The artifact stream closed before response headers.')); });
      stream.once('response', incoming => {
        responded = true;
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming)) {
            if (key.startsWith(':') || value === undefined) continue;
            responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          }
          const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: Number(incoming[':status']), headers: responseHeaders });
          resolve(response);
        } catch (error) { stream.close(http2Constants.NGHTTP2_CANCEL); reject(error); }
      });
    });
  };
  return { fetch: (url: string, init: RequestInit) => fetchArtifact(url, init, request),
    close: () => { for (const session of sessions.values()) session.destroy(); sessions.clear(); } };
}
/** Test acquisition only: bounded independent ranges, then whole-file publisher verification. */
export async function downloadPinnedModels(specs: readonly CuratedModel[], directory: string, signal: AbortSignal, progress: (model: string, status: string, bytes: number, detail?: string) => void,
  options: { workers?: number; fetch?: typeof fetchArtifact; retryDelayMs?: number; requestWindowBytes?: number } = {}) {
  const workers = options.workers ?? 16;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) throw new Error('Use between 1 and 16 bounded download workers.');
  const retryDelayMs = options.retryDelayMs ?? 500;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3000) throw new Error('Use a retry delay between 0 and 3000 milliseconds.');
  const requestWindowBytes = options.requestWindowBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(requestWindowBytes) || requestWindowBytes < 1 || requestWindowBytes > WINDOW) throw new Error('The transfer window must be between 1 byte and 32 MiB.');
  signal.throwIfAborted();
  const fetchRange = options.fetch ?? fetchArtifact;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs: { spec: CuratedModel; index: number; start: number; end: number; chunk: string }[] = [];
  const complete = new Map<string, number>();
  const required: CuratedModel[] = [];
  for (const spec of specs) {
    signal.throwIfAborted();
    const destination = path.join(directory, spec.filename);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.estimatedDownloadBytes || await sha256File(destination, signal) !== spec.sha256) throw new Error('Existing test weights do not match their pinned artifact.');
      const metadata = await readGGUFMetadata(destination, signal);
      if (metadata.architecture !== spec.architecture) throw new Error('The verified model architecture differs from the catalog.');
      progress(spec.id, 'success', info.size); continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    required.push(spec);
    const chunks = path.join(directory, '.ranges', spec.id.replace(/[^a-z0-9]/gi, '-'), spec.revision);
    await mkdir(chunks, { recursive: true, mode: 0o700 });
    let retained = 0;
    let prefix: Awaited<ReturnType<typeof open>> | undefined;
    let prefixSize = 0;
    try {
      const info = await lstat(`${destination}.part`);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('The retained download must be a regular file.');
      prefixSize = Math.min(info.size, spec.estimatedDownloadBytes);
      prefix = await open(`${destination}.part`, 'r');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      for (let start = 0, index = 0; start < spec.estimatedDownloadBytes; start += WINDOW, index++) {
        signal.throwIfAborted();
        const end = Math.min(spec.estimatedDownloadBytes - 1, start + WINDOW - 1), chunk = path.join(chunks, String(index));
        let found = 0;
        try { const info = await lstat(chunk); if (!info.isFile() || info.isSymbolicLink()) throw new Error('The retained range must be a regular file.'); found = info.size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (found > end - start + 1) throw new Error('Retained range exceeds its pinned size.');
        if (!found && prefix && prefixSize > start) {
          const length = Math.min(prefixSize - start, end - start + 1), target = await open(chunk, 'wx', 0o600);
          try {
            const buffer = Buffer.alloc(Math.min(length, 1024 * 1024));
            for (let copied = 0; copied < length;) {
              signal.throwIfAborted();
              const { bytesRead } = await prefix.read(buffer, 0, Math.min(buffer.length, length - copied), start + copied);
              if (!bytesRead) throw new Error('Retained model prefix ended unexpectedly.');
              await target.writeFile(buffer.subarray(0, bytesRead)); copied += bytesRead;
            }
            await target.sync(); found = length;
          } finally { await target.close(); }
        }
        retained += found;
        if (found < end - start + 1) jobs.push({ spec, index, start, end, chunk });
      }
    } finally { await prefix?.close(); }
    complete.set(spec.id, retained); progress(spec.id, 'downloading', retained);
  }
  // Interleave models so one interrupted transfer cannot starve the other model.
  jobs.sort((a, b) => a.index - b.index || a.spec.id.localeCompare(b.spec.id));
  const owned = new AbortController(), joined = AbortSignal.any([signal, owned.signal]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      joined.throwIfAborted(); const job = jobs[next++];
      for (let attempt = 0;; attempt++) {
        joined.throwIfAborted();
        const found = await lstat(job.chunk).then(info => info.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
        if (found === job.end - job.start + 1) break;
        const from = job.start + found, deadline = AbortSignal.any([joined, AbortSignal.timeout(300_000)]);
        const requestedEnd = Math.min(job.end, from + requestWindowBytes - 1);
        const url = `https://huggingface.co/${job.spec.repository}/resolve/${job.spec.revision}/${encodeURIComponent(job.spec.filename)}`;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let cancel: (() => void) | undefined;
        try {
          const response = await fetchRange(url, { headers: { Range: `bytes=${from}-${requestedEnd}`, 'Accept-Encoding': 'identity' }, signal: deadline });
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          // Some publisher CDNs serve the remaining suffix for a bounded
          // request. Its start and total must match, and its end must cover the
          // requested window without escaping the pinned file. The reader below
          // writes only this window and cancels the remaining response body.
          if (response.status !== 206 || !range || !range.slice(1).every(value => Number.isSafeInteger(Number(value))) ||
            Number(range[1]) !== from || Number(range[2]) < requestedEnd || Number(range[2]) >= job.spec.estimatedDownloadBytes || Number(range[3]) !== job.spec.estimatedDownloadBytes) {
            await response.body?.cancel(); throw new Error(`The publisher did not return the pinned byte range (HTTP ${response.status}).`);
          }
          const contentLength = response.headers.get('content-length');
          if (contentLength !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) !== Number(range[2]) - from + 1)) {
            await response.body?.cancel(); throw new Error('The pinned byte range has an inconsistent Content-Length.');
          }
          if (!response.body || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
            await response.body?.cancel(); throw new Error('A pinned transfer needs an uncompressed response body.');
          }
          handle = await open(job.chunk, 'a', 0o600); reader = response.body.getReader();
          const currentReader = reader; cancel = () => { void currentReader.cancel().catch(() => {}); };
          deadline.addEventListener('abort', cancel, { once: true });
          let offset = from;
          while (offset <= requestedEnd) {
            deadline.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
            const length = Math.min(value.length, requestedEnd - offset + 1);
            await handle.writeFile(value.subarray(0, length)); offset += length;
            complete.set(job.spec.id, (complete.get(job.spec.id) ?? 0) + length); progress(job.spec.id, 'downloading', complete.get(job.spec.id)!);
          }
          deadline.throwIfAborted(); await handle.sync();
          if (offset <= requestedEnd) throw new Error('A pinned range ended early.');
          if (requestedEnd === job.end) break;
          attempt = -1; // A completed wire window starts a fresh bounded retry allowance.
        } catch (error) {
          if (joined.aborted || attempt >= 3) throw error;
          progress(job.spec.id, 'retrying', complete.get(job.spec.id) ?? 0, error instanceof Error ? error.message : String(error));
          await delay(Math.min(3000, retryDelayMs * 2 ** attempt), undefined, { signal: joined });
        } finally {
          if (cancel) deadline.removeEventListener('abort', cancel);
          await reader?.cancel().catch(() => {}); reader?.releaseLock(); await handle?.close();
        }
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(workers, jobs.length) }, () => worker().catch(error => { owned.abort(error); throw error; })));
  const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  for (const spec of required) {
    joined.throwIfAborted(); progress(spec.id, 'verifying', spec.estimatedDownloadBytes);
    const destination = path.join(directory, spec.filename), assembling = `${destination}.assembling`;
    await rm(assembling, { force: true }); const handle = await open(assembling, 'wx', 0o600);
    try {
      const chunks = path.join(directory, '.ranges', spec.id.replace(/[^a-z0-9]/gi, '-'), spec.revision);
      for (let start = 0, index = 0; start < spec.estimatedDownloadBytes; start += WINDOW, index++) {
        const file = path.join(chunks, String(index)), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== Math.min(WINDOW, spec.estimatedDownloadBytes - start)) throw new Error('A completed model range has changed.');
        for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024 })) { joined.throwIfAborted(); await handle.writeFile(bytes); }
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (await sha256File(assembling, joined) !== spec.sha256) throw new Error('The assembled model does not match its publisher SHA-256.');
    const metadata = await readGGUFMetadata(assembling, joined);
    if (metadata.architecture !== spec.architecture) throw new Error('The verified model architecture differs from the catalog.');
    await rename(assembling, destination); progress(spec.id, 'success', spec.estimatedDownloadBytes);
  }
}
