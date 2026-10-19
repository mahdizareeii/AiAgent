import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const electron = require('electron');
const root = await realpath('.');
const profile = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-electron-interaction-')));
await mkdir(path.join(profile, 'fixtures'));
const report = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.cache', 'v060-electron-interactions.json');
const appPath = process.argv[3] ? path.resolve(process.argv[3]) : root;
async function phase(name) {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(root, 'scripts/electron-interaction-host.cjs'), `--user-data-dir=${profile}`, `--interaction-app=${appPath}`, `--interaction-report=${report}`, `--interaction-phase=${name}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Electron interaction ${name} timed out. ${output.slice(-4000)}`)); }, 120000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron interaction ${name} exited ${code} / ${signal}: ${output.slice(-7000)}`)); });
  });
}
try {
  await phase('initial'); await phase('relaunch');
  await phase('held-close');
  const held = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(held.heldCloseRegression?.actualHostDraftPersistedBeforeAcknowledgement, true, 'A premature process exit cannot pass the held-close regression.');
  assert.equal(held.heldCloseRegression?.windowAliveWhileSaveHeld, true);
  await phase('relaunch-held-close');
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.heldCloseRegression?.status, 'passed');
  assert.equal(result.heldCloseRegression?.relaunchVerified, true);
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(profile, { recursive: true, force: true }); }
