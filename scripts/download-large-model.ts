import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG, modelArtifacts, type CuratedModel } from '../local-agent/runtime/catalog.ts';
import { downloadModel, type DownloadOptions } from '../local-agent/runtime/download.ts';
import { readGGUFMetadata, sha256File, validateGGUFModelSet } from '../local-agent/runtime/gguf.ts';
import { acquireCodingDownloadLock } from './download-coding-models.ts';
import { createHttp2ArtifactFetcher } from './parallel-model-download.ts';

export const LARGE_MODEL_ID = 'qwen3-coder-next:80b';
const PUBLISHER_PIN = {
  repository: 'Qwen/Qwen3-Coder-Next-GGUF', revision: 'b82fb7382639d97b38fa7672e526c760c2fb358e',
  sizes: [15524827040, 14872168352, 14503294496, 3510702144],
  digests: ['6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da',
    '817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3',
    '23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f',
    '249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b'],
} as const;
/** Official public API independently checked 2026-10-14; never substitute another conversion. */
export function assertPublicLargeModelPin(spec: CuratedModel): void {
  const artifacts = modelArtifacts(spec);
  if (spec.id !== LARGE_MODEL_ID || spec.repository !== PUBLISHER_PIN.repository || spec.revision !== PUBLISHER_PIN.revision
    || spec.license !== 'Apache-2.0' || spec.architecture !== 'qwen3next' || spec.quantization !== 'Q4_K_M'
    || spec.sourceUrl !== `https://huggingface.co/${PUBLISHER_PIN.repository}` || spec.estimatedDownloadBytes !== 48410992032
    || artifacts.length !== 4 || artifacts.some((artifact, index) => {
      const filename = `Qwen3-Coder-Next-Q4_K_M-${String(index + 1).padStart(5, '0')}-of-00004.gguf`;
      return artifact.filename !== filename || artifact.remotePath !== `Qwen3-Coder-Next-Q4_K_M/${filename}`
        || artifact.sizeBytes !== PUBLISHER_PIN.sizes[index] || artifact.sha256 !== PUBLISHER_PIN.digests[index];
    }) || spec.filename !== artifacts[0]?.filename || spec.sha256 !== artifacts[0]?.sha256) {
    throw new Error('The 80B catalog entry differs from its independently verified official public shard pins.');
  }
}
export function parseLargeModelDownloadOptions(args: readonly string[]) {
  let transport: 'http2' | 'fetch' = 'http2';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--transport' || !['http2', 'fetch'].includes(args[1])) {
      throw new Error('Use only --transport http2 or fetch; the official 80B model and isolated cache are fixed.');
    }
    transport = args[1] as typeof transport;
  }
  return { transport };
}
const digestText = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
async function manifestSnapshot(file: string) {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('The large-model manifest must be a bounded ordinary file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(file);
    if (identity(opened) !== identity(info) || identity(after) !== identity(info) || identity(current) !== identity(info)
      || current.isSymbolicLink() || bytes.length > 65536) throw new Error('The large-model manifest changed while reading.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), digest: digestText(text) };
  } finally { await handle.close(); }
}
function manifestPin(spec: CuratedModel, directory: string) {
  return { schemaVersion: 1, kind: 'verified-local-large-model-download', model: spec.id, repository: spec.repository,
    revision: spec.revision, license: spec.license, sourceUrl: spec.sourceUrl, architecture: spec.architecture,
    quantization: spec.quantization, bytes: spec.estimatedDownloadBytes,
    files: modelArtifacts(spec).map(artifact => ({ ...artifact, file: path.join(directory, artifact.filename) })) };
}

/** Isolated acquisition only. Production downloadModel verifies every SHA and the complete GGUF shard set. */
export async function downloadLargeModel(spec: CuratedModel, directory: string, options: Omit<DownloadOptions, 'hashFile'> = {}) {
  options.signal?.throwIfAborted();
  if (!path.isAbsolute(directory)) throw new Error('Use an absolute isolated model directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Use a real non-symlink model directory.');
  const manifest = path.join(directory, 'downloads.json'), pin = manifestPin(spec, directory), release = await acquireCodingDownloadLock(directory);
  const proofs = new Map<string, { identity: string; digest: string }>();
  try {
    const previous = await manifestSnapshot(manifest);
    if (previous) {
      const prior = previous.value;
      if (!prior || typeof prior !== 'object' || Object.keys(prior).some(key => !Object.hasOwn(pin, key) && !['chatTemplateSha256', 'complete', 'nativeReadiness', 'codingQualification'].includes(key))
        || Object.keys(pin).some(key => JSON.stringify(prior[key]) !== JSON.stringify(pin[key as keyof typeof pin]))
        || prior.complete !== true || prior.nativeReadiness !== false || prior.codingQualification !== false
        || typeof prior.chatTemplateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prior.chatTemplateSha256)) {
        throw new Error('The existing large-model manifest differs from this isolated publisher pin; it was preserved.');
      }
    }
    const file = await downloadModel(spec, directory, { ...options, hashFile: async (source, signal) => {
      const before = await lstat(source);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('A pinned model artifact must be an ordinary file.');
      const digest = await sha256File(source, signal), after = await lstat(source);
      if (identity(before) !== identity(after) || after.isSymbolicLink()) throw new Error('A model artifact changed during SHA verification.');
      // Renaming the verified partial changes ctime; capture final identities below, but require inode/size/mtime to stay equal.
      proofs.set(path.basename(source).replace(/\.part$/, ''), { identity: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}`, digest });
      return digest;
    } });
    const artifacts = modelArtifacts(spec), metadata = [], finalIdentities = new Map<string, string>();
    for (let index = 0; index < artifacts.length; index++) {
      const artifact = artifacts[index], target = path.join(directory, artifact.filename), info = await lstat(target), proof = proofs.get(artifact.filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.sizeBytes || proof?.digest !== artifact.sha256
        || proof.identity !== `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`) throw new Error('A downloaded shard changed before manifest publication.');
      finalIdentities.set(target, identity(info));
      metadata.push(await readGGUFMetadata(target, options.signal, artifacts.length > 1 ? { split: { index, count: artifacts.length } } : {}));
    }
    validateGGUFModelSet(metadata, spec.architecture);
    const record = { ...pin, chatTemplateSha256: digestText(metadata[0].chatTemplate), complete: true, nativeReadiness: false, codingQualification: false };
    if (previous && previous.value.chatTemplateSha256 !== record.chatTemplateSha256) throw new Error('The verified shard template differs from the retained manifest.');
    options.signal?.throwIfAborted();
    for (const [target, expected] of finalIdentities) if (identity(await lstat(target)) !== expected) throw new Error('A verified shard changed during manifest publication.');
    if ((await manifestSnapshot(manifest))?.digest !== previous?.digest) throw new Error('The large-model manifest changed before publication; it was preserved.');
    const temporary = manifest + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      options.signal?.throwIfAborted(); await rename(temporary, manifest);
    } finally { await rm(temporary, { force: true }); }
    return { file, manifest, record };
  } finally { await release(); }
}
export async function runLargeModelDownload(args: readonly string[]) {
  const options = parseLargeModelDownloadOptions(args), spec = MODEL_CATALOG.find(item => item.id === LARGE_MODEL_ID);
  if (!spec) throw new Error('The official 80B model is missing from the catalog.');
  assertPublicLargeModelPin(spec);
  const root = await realpath(process.cwd()), directory = path.join(root, '.cache/coding-reliability/large-models'), controller = new AbortController();
  const interrupt = () => controller.abort(new Error('The owned large-model download was interrupted; verified shards and partial bytes remain resumable.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const network = options.transport === 'http2' ? createHttp2ArtifactFetcher() : undefined;
  const fetcher: typeof fetch | undefined = network ? (input, init = {}) => network.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init) : undefined;
  let lastProgress = 0;
  try {
    console.log(JSON.stringify({ event: 'LARGE_MODEL_DOWNLOAD_STARTED', model: spec.id, repository: spec.repository, revision: spec.revision,
      pid: process.pid, directory, totalBytes: spec.estimatedDownloadBytes, transport: options.transport, shardStreams: 4, requestWindowBytes: 8 * 1024 ** 2 }));
    const result = await downloadLargeModel(spec, directory, { signal: controller.signal, ...(fetcher ? { fetch: fetcher } : {}), rangeWindowBytes: 8 * 1024 ** 2,
      freeDiskBytes: async target => { const disk = await statfs(target), free = Number(disk.bavail) * Number(disk.bsize); if (!Number.isSafeInteger(free) || free < 0) throw new Error('Available disk space could not be measured safely.'); return free; },
      onProgress: event => { const now = Date.now(); if (now - lastProgress >= 15000 || event.status !== 'downloading') { lastProgress = now; console.log(JSON.stringify(event)); } },
    });
    console.log(JSON.stringify({ event: 'LARGE_MODEL_DOWNLOAD_COMPLETE', model: spec.id, file: result.file, manifest: result.manifest,
      shaAndShardSetVerified: true, chatTemplateSha256: result.record.chatTemplateSha256, nativeReadiness: false, codingQualification: false }));
  } finally { network?.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Download the official free Qwen3-Coder-Next 80B Q4_K_M four-shard model into an isolated task cache.\n  node scripts/download-large-model.ts [--transport http2|fetch]\nRequires roughly 45.09 GiB disk for the complete weights plus remaining-work headroom. Resumes production pinned partial files; SHA and complete GGUF shard verification precede atomic isolated manifest publication. Downloading grants no native readiness or coding qualification and changes no app selection or Qwen3.8/Muse manifest.');
  else try { await runLargeModelDownload(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
