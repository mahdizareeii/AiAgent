import { mkdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_CATALOG } from '../../local-agent/runtime/catalog.ts';
import { acquireCodingDownloadLock } from '../download-coding-models.ts';
import { createHttp2ArtifactFetcher, downloadPinnedModelsOrdered } from '../parallel-model-download.ts';

// Acquisition only. No runtime, probes, readiness, quality or support claims.
const directory = path.resolve('.cache/8gb-validation/models');
const specs = MODEL_CATALOG.filter(spec => spec.lowRamCandidate);
if (specs.length !== 3 || process.argv.length !== 2) throw new Error('Run without arguments to acquire exactly the three pinned 9B candidate files.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const unlock = await acquireCodingDownloadLock(directory), controller = new AbortController(), network = createHttp2ArtifactFetcher();
const stop = () => controller.abort(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
let last = 0;
try {
  await downloadPinnedModelsOrdered(specs, directory, controller.signal, (model, status, bytes) => {
    if (Date.now() - last > 10_000 || /verified|complete|error/i.test(status)) { last = Date.now(); console.log(JSON.stringify({ model, status, bytes })); }
  }, { order: 'sequential', workers: 8, fetch: network.fetch });
  const models = [];
  for (const spec of specs) {
    const file = path.join(directory, spec.filename), info = await lstat(file);
    models.push({ id: spec.id, file, bytes: info.size, sha256: spec.sha256, revision: spec.revision, repository: spec.repository,
      acquisition: 'publisher checksum and GGUF architecture verified by downloader', readiness: false, measuredQuality: false, eightGBSupport: 'unverified' });
  }
  await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), models }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} finally { network.close(); await unlock(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
