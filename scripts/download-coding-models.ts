import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG, type CuratedModel } from '../local-agent/runtime/catalog.ts';
import { codingModelFamily } from '../local-agent/runtime/generation.ts';
import { createHttp2ArtifactFetcher, downloadPinnedModelsOrdered, retainedPinnedModelBytes, type DownloadOrder } from './parallel-model-download.ts';

export function parseCodingDownloadOptions(args: readonly string[]) {
  const ids: string[] = []; let workers = 16, transport: 'http2' | 'fetch' = 'http2', order: DownloadOrder = 'parallel';
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--workers') {
      workers = Number(args[++index]);
      if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) throw new Error('Use --workers between 1 and 16.');
    } else if (value === '--transport') {
      const choice = args[++index]; if (choice !== 'http2' && choice !== 'fetch') throw new Error('Use --transport http2 or fetch.'); transport = choice;
    } else if (value === '--order') {
      const choice = args[++index]; if (choice !== 'parallel' && choice !== 'sequential') throw new Error('Use --order parallel or sequential.'); order = choice;
    } else if (codingModelFamily(value)) ids.push(value);
    else throw new Error('Choose a pinned Qwen3.8 or Muse Glimmer Q4_K_M/Q3_K_M model ID with optional --workers/--transport/--order.');
  }
  if (new Set(ids).size !== ids.length) throw new Error('Each pinned model may appear only once.');
  const selected = ids.length ? ids : ['qwen3.8:27b', 'muse-glimmer:30b'];
  if (order === 'sequential') selected.sort((a, b) => Number(codingModelFamily(a) !== 'qwen38') - Number(codingModelFamily(b) !== 'qwen38'));
  return { ids: selected, workers, transport, order };
}

interface CodingDownloadRecord {
  model: string; file: string; revision: string; sha256: string; bytes: number;
  quantization?: string; repository?: string; sourceUrl?: string; architecture?: string;
}
const MAX_MANIFEST_BYTES = 64 * 1024;
const manifestDigest = (text: string) => createHash('sha256').update(text).digest('hex');
function downloadRecord(spec: CuratedModel, directory: string): CodingDownloadRecord {
  return { model: spec.id, file: path.join(directory, spec.filename), revision: spec.revision, sha256: spec.sha256, bytes: spec.estimatedDownloadBytes,
    quantization: spec.quantization, repository: spec.repository, sourceUrl: spec.sourceUrl, architecture: spec.architecture };
}
/** Known prior pins are retained exactly; malformed or unknown records cannot disappear during a variant acquisition. */
export function mergeCodingDownloadRecords(previous: unknown, completed: readonly CuratedModel[], directory: string, catalog: readonly CuratedModel[] = MODEL_CATALOG): CodingDownloadRecord[] {
  if (!Array.isArray(previous) || previous.length > 64) throw new Error('The coding download manifest must contain at most 64 pinned records.');
  const merged = new Map<string, CodingDownloadRecord>();
  for (const raw of previous) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The coding download manifest contains an invalid record.');
    const record = raw as CodingDownloadRecord, spec = catalog.find(item => item.id === record.model);
    if (!spec || !codingModelFamily(spec.id) || merged.has(record.model)) throw new Error('The coding download manifest contains an unknown or duplicate model pin.');
    const expected = downloadRecord(spec, directory);
    if (Object.keys(record).some(key => !Object.hasOwn(expected, key))
      || (['model', 'file', 'revision', 'sha256', 'bytes'] as const).some(key => record[key] !== expected[key])
      || (['quantization', 'repository', 'sourceUrl', 'architecture'] as const).some(key => record[key] !== undefined && record[key] !== expected[key])) {
      throw new Error(`The retained download record no longer matches its known publisher pin: ${record.model}`);
    }
    merged.set(record.model, structuredClone(record));
  }
  for (const spec of completed) {
    const expected = catalog.find(item => item.id === spec.id);
    if (!expected || !codingModelFamily(spec.id) || JSON.stringify(downloadRecord(spec, directory)) !== JSON.stringify(downloadRecord(expected, directory))) throw new Error('Only newly verified known catalog pins may be published.');
    merged.set(spec.id, downloadRecord(spec, directory));
  }
  return [...merged.values()];
}
async function readCodingDownloadManifest(file: string): Promise<{ records: unknown; sha256?: string }> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error('The coding download manifest must be a bounded ordinary non-symlink file.');
  const descriptor = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await descriptor.stat(); if (before.dev !== info.dev || before.ino !== info.ino || before.size > MAX_MANIFEST_BYTES) throw new Error('The coding download manifest changed while opening.');
    const bytes = await descriptor.readFile(), after = await descriptor.stat(), current = await lstat(file);
    if (bytes.length > MAX_MANIFEST_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error('The coding download manifest changed while reading.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return { records: JSON.parse(text), sha256: manifestDigest(text) };
  } finally { await descriptor.close(); }
}
async function assertRetainedDownloadFiles(records: readonly CodingDownloadRecord[]): Promise<void> {
  for (const record of records) { const info = await lstat(record.file); if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes) throw new Error(`The retained pinned artifact is missing or changed: ${record.model}`); }
}
/** Called under the download lock only after payload SHA/GGUF verification; this manifest grants no readiness. */
export async function publishCodingDownloadManifest(file: string, completed: readonly CuratedModel[], directory: string, catalog: readonly CuratedModel[] = MODEL_CATALOG): Promise<void> {
  if (!path.isAbsolute(file) || !path.isAbsolute(directory) || path.dirname(file) !== path.dirname(directory)
    || await realpath(path.dirname(file)) !== path.dirname(file) || await realpath(directory) !== directory) throw new Error('Use the real task-local model directory and its sibling download manifest.');
  const previous = await readCodingDownloadManifest(file), records = mergeCodingDownloadRecords(previous.records, completed, directory, catalog);
  await assertRetainedDownloadFiles(records);
  const text = JSON.stringify(records, null, 2) + '\n'; if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('The coding download manifest exceeds its bounded size.');
  const latest = await readCodingDownloadManifest(file); if (latest.sha256 !== previous.sha256) throw new Error('The coding download manifest changed before publication; no records were replaced.');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** An exclusive task-local lock prevents two processes from appending the same ranges. */
export async function acquireCodingDownloadLock(directory: string) {
  const file = path.join(directory, '.download-lock.json'), token = randomUUID();
  const owner = { kind: 'pinned-coding-model-download', pid: process.pid, token, startedAt: new Date().toISOString() };
  try { await writeFile(file, JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('The task download lock is invalid.');
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (prior?.kind !== owner.kind || !Number.isSafeInteger(prior.pid) || prior.pid < 1 || typeof prior.token !== 'string') throw new Error('The task download lock is invalid.');
    try { process.kill(prior.pid, 0); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('The download lock is stale. Confirm its owned process has stopped before removing the lock and resuming.');
      throw failure;
    }
    throw new Error('The task model cache already has an active downloader.');
  }
  return async () => {
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (current.token !== token || current.pid !== process.pid) throw new Error('The download lock owner changed.');
    await rm(file);
  };
}

export async function runCodingModelDownload(args: readonly string[]) {
  const root = process.cwd(), options = parseCodingDownloadOptions(args), directory = path.join(root, '.cache/coding-reliability/models');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireCodingDownloadLock(directory), controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const network = options.transport === 'http2' ? createHttp2ArtifactFetcher() : undefined;
  try {
    const specs = options.ids.map(id => { const spec = MODEL_CATALOG.find(model => model.id === id); if (!spec) throw new Error(`The pinned catalog entry ${id} is missing.`); return spec; });
    const manifestFile = path.join(root, '.cache/coding-reliability/downloads.json');
    const prior = await readCodingDownloadManifest(manifestFile);
    await assertRetainedDownloadFiles(mergeCodingDownloadRecords(prior.records, [], directory));
    const disk = await statfs(directory);
    if (Number(disk.bavail) * Number(disk.bsize) < specs.reduce((total, spec) => total + spec.estimatedDownloadBytes * 2, 0) + 1024 ** 3) throw new Error('The isolated parallel download needs storage for ranges and verified assembled models.');
    const reported = new Map<string, number>(), completedByModel = new Map<string, number>(), samples: { at: number; bytes: number }[] = [];
    const totalBytes = specs.reduce((sum, model) => sum + model.estimatedDownloadBytes, 0);
    for (const spec of specs) completedByModel.set(spec.id, await retainedPinnedModelBytes(spec, directory, controller.signal));
    const retainedBytes = [...completedByModel.values()].reduce((sum, value) => sum + value, 0);
    samples.push({ at: Date.now(), bytes: retainedBytes });
    console.log(JSON.stringify({ event: 'DOWNLOAD_STARTED', pid: process.pid, transport: options.transport, workers: options.workers, order: options.order,
      requestWindowBytes: 8 * 1024 * 1024, retainedBytes, retainedByModel: Object.fromEntries(completedByModel), totalBytes }));
    await downloadPinnedModelsOrdered(specs, directory, controller.signal, (model, status, completed, error) => {
      completedByModel.set(model, completed); const now = Date.now();
      if (now - (reported.get(model) ?? 0) < 15_000 && !['success', 'verifying', 'retrying'].includes(status)) return;
      reported.set(model, now); const spec = specs.find(item => item.id === model)!;
      const totalCompleted = [...completedByModel.values()].reduce((sum, value) => sum + value, 0);
      if (completedByModel.size === specs.length) { samples.push({ at: now, bytes: totalCompleted }); while (samples.length > 2 && samples[1].at < now - 60_000) samples.shift(); }
      const measuredSeconds = samples.length > 1 ? (now - samples[0].at) / 1000 : 0;
      const bytesPerSecond = measuredSeconds >= 15 ? Math.max(0, totalCompleted - samples[0].bytes) / measuredSeconds : null;
      const etaTransferSeconds = bytesPerSecond && measuredSeconds >= 30 ? Math.ceil((totalBytes - totalCompleted) / bytesPerSecond) : null;
      console.log(JSON.stringify({ model, status, completed, percent: completed / spec.estimatedDownloadBytes * 100, totalCompleted, totalBytes,
        overallPercent: totalCompleted / totalBytes * 100, bytesPerSecond, measuredSeconds, etaTransferSeconds, ...(error ? { error } : {}) }));
    }, { workers: options.workers, order: options.order, ...(network ? { fetch: network.fetch } : {}) });
    await publishCodingDownloadManifest(manifestFile, specs, directory);
  } finally {
    network?.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); await releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Pinned local model acquisition\n  node scripts/download-coding-models.ts [qwen3.8:27b muse-glimmer:30b | qwen3.8:27b-q3-k-m muse-glimmer:30b-q3-k-m] [--workers 1..16] [--transport http2|fetch] [--order parallel|sequential]\nDefault IDs remain Q4_K_M. Q3_K_M variants require explicit IDs and separate verification. Existing ranges and verified manifest pins are retained; complete files require publisher SHA-256 and GGUF verification. Sequential order publishes both Qwen variants before Muse. HTTP/2 uses bounded receive windows and 8MiB wire requests.');
  else { try { await runCodingModelDownload(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
}
