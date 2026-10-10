#!/usr/bin/env node
// Native packaged-resource smoke test. No model, approved command, or public
// network request is used. Run after `npm run package` with Node 24.10+.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File, validateNativeEngine, verifyInferenceResources } from './prepare-inference.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createActionHost } from '../local-agent/desktop/action-host.ts';
import { LocalActions } from '../local-agent/desktop/actions.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform;
const defaults = { darwin: 'release/mac-arm64', win32: 'release/win-unpacked', linux: 'release/linux-unpacked' };
if (!defaults[platform]) throw new Error(`Unsupported native smoke platform: ${platform}`);
const artifactRoot = path.resolve(process.argv[2] ?? path.join(root, defaults[platform]));
let electronExecutable;
let resourceDirectory;
if (platform === 'darwin') {
  const bundle = artifactRoot.endsWith('.app') ? artifactRoot : path.join(artifactRoot, 'Free Local Agent.app');
  electronExecutable = path.join(bundle, 'Contents', 'MacOS', 'Free Local Agent');
  resourceDirectory = path.join(bundle, 'Contents', 'Resources');
} else {
  resourceDirectory = path.join(artifactRoot, 'resources');
  const candidates = platform === 'win32' ? ['Free Local Agent.exe'] : ['free-local-agent-desktop', 'free-local-agent', 'Free Local Agent'];
  electronExecutable = candidates.map(name => path.join(artifactRoot, name)).find(existsSync);
}
const researchExecutable = path.join(resourceDirectory, 'research', platform === 'win32' ? 'local-agent-research.exe' : 'local-agent-research');
const gooseExecutable = path.join(resourceDirectory, 'goose', platform === 'win32' ? 'goose.exe' : 'goose');
const inferenceDirectory = path.join(resourceDirectory, 'inference');
const archive = path.join(resourceDirectory, 'app.asar');
const bridgeExecutable = path.join(archive, 'dist', 'action-bridge.cjs');
for (const [label, filename] of [['packaged Electron executable', electronExecutable], ['app.asar', archive], ['frozen research executable', researchExecutable], ['offline Goose executable', gooseExecutable], ['inference manifest', path.join(inferenceDirectory, 'manifest.json')]]) {
  if (!filename || !existsSync(filename)) throw new Error(`Missing ${label}. Build the native package first. Expected: ${filename ?? artifactRoot}`);
}
const gooseManifest = JSON.parse(await readFile(path.join(resourceDirectory, 'goose', 'manifest.json'), 'utf8'));
assert.equal(gooseManifest.version, '1.53.0');
assert.equal(gooseManifest.target, `${platform}-${process.arch}`);
assert.equal(gooseManifest.offline, true, 'The bundled Goose must be built with offline metadata behavior.');
assert.deepEqual([...gooseManifest.features].sort(), ['disable-update', 'rustls-tls']);
assert.ok(!gooseManifest.features.includes('online-model-meta'), 'Online model metadata must be absent.');
assert.equal(await sha256File(gooseExecutable), gooseManifest.sha256, 'Packaged Goose differs from its build manifest.');
const inferenceManifest = await verifyInferenceResources(inferenceDirectory);
const nativeValidation = validateNativeEngine(inferenceDirectory, inferenceManifest);
assert.equal(nativeValidation.executed, true, 'Run package smoke on the target operating system.');

function environment(extra) {
  const safe = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key]) safe[key] = process.env[key];
  }
  return { ...safe, ...extra };
}

// Electron's filesystem support must read the skill inside the actual ASAR.
const packagedSkill = await new Promise((resolve, reject) => {
  const child = spawn(electronExecutable, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
    path.join(archive, 'dist', 'skills', 'task-research', 'SKILL.md')], {
    env: environment({ ELECTRON_RUN_AS_NODE: '1' }), shell: false, windowsHide: true,
  });
  let output = '', errors = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged skill read timed out.')); }, 10_000);
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-2000); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Packaged skill read failed: ${errors}`)); });
});
assert.equal(packagedSkill, await readFile(path.join(root, 'local-agent', 'desktop', 'skills', 'task-research', 'SKILL.md'), 'utf8'));

async function bounded(promise, label, timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-packaged-smoke-')));
const projectPath = path.join(directory, 'project');
const controller = new AbortController();
const connections = [];
let host;
let approvals = 0;
let researchTools = [];
try {
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'smoke.txt'), 'unchanged\n');
  const actions = new LocalActions({
    projectPath,
    historyDirectory: path.join(directory, 'history'),
    onPermission: async permission => {
      approvals++;
      assert.equal(permission.arguments.path, 'smoke.txt');
      assert.equal(permission.arguments.content, 'must not be written\n');
      assert.match(permission.preview, /-unchanged\n\+must not be written/);
      return false;
    },
  });
  host = await createActionHost(actions, controller.signal);

  async function connect(command, args, env, label) {
    const transport = new StdioClientTransport({ command, args, env, cwd: directory, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const client = new Client({ name: 'local-agent-packaged-smoke', version: '0.3.0-alpha.2' });
    connections.push({ client, transport });
    try { await bounded(client.connect(transport), `${label} initialization`); }
    catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`); }
    return client;
  }

  // Crucially use the packaged Electron, not the development Node executable,
  // and load the bridge inside its actual ASAR archive.
  const bridge = await connect(electronExecutable, [bridgeExecutable], environment({
    ELECTRON_RUN_AS_NODE: '1', LOCAL_AGENT_ACTION_URL: host.url,
  }), 'Packaged Electron/ASAR MCP bridge');
  const bridgeTools = await bounded(bridge.listTools(), 'Bridge tool listing');
  assert.deepEqual(bridgeTools.tools.map(tool => tool.name).sort(), ['create_files', 'edit_file', 'read_command_output', 'run_command', 'write_file']);
  const denied = await bounded(bridge.callTool({ name: 'write_file', arguments: {
    path: 'smoke.txt', content: 'must not be written\n',
  } }), 'Denied packaged write');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /denied/);
  assert.equal(approvals, 1);
  assert.equal(await readFile(path.join(projectPath, 'smoke.txt'), 'utf8'), 'unchanged\n');
  assert.deepEqual(await readdir(projectPath), ['smoke.txt']);
  assert.equal(existsSync(path.join(directory, 'history')), false);

  const research = await connect(researchExecutable, [], environment({
    LOCAL_AGENT_MODE: 'research',
    LOCAL_AGENT_GRANTED_ROOTS: JSON.stringify([projectPath]),
    LOCAL_AGENT_GRANTED_FILES: '[]',
    LOCAL_AGENT_UTILITIES: '{}',
  }), 'Frozen packaged research MCP');
  const listed = await bounded(research.listTools(), 'Frozen research tool listing');
  researchTools = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(researchTools, ['inspect_file', 'read_file', 'read_pdf']);
  for (const tool of listed.tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  const inspection = await bounded(research.callTool({ name: 'inspect_file', arguments: { path: 'smoke.txt' } }), 'Frozen file inspection');
  assert.equal(inspection.structuredContent.ok, true);
  assert.match(inspection.structuredContent.sha256, /^[a-f0-9]{64}$/);
  const reading = await bounded(research.callTool({ name: 'read_file', arguments: { path: 'smoke.txt', expected_sha256: inspection.structuredContent.sha256 } }), 'Frozen verified file read');
  assert.equal(reading.structuredContent.text, '1: unchanged');
  for (const mode of ['coding', 'research', 'assistant']) {
    const optedIn = await connect(researchExecutable, [], environment({
      LOCAL_AGENT_MODE: mode, LOCAL_AGENT_GRANTED_ROOTS: '[]', LOCAL_AGENT_GRANTED_FILES: '[]',
      LOCAL_AGENT_UTILITIES: JSON.stringify({ fileReading: false, projectSearch: false, webResearch: true }),
    }), `Explicit web preference in ${mode}`);
    assert.deepEqual((await bounded(optedIn.listTools(), 'Opted-in web tool listing')).tools.map(tool => tool.name).sort(), mode === 'assistant' ? [] : ['web_fetch', 'web_search']);
  }
} finally {
  controller.abort();
  await host?.drain();
  await Promise.allSettled(connections.map(async ({ client, transport }) => {
    await client.close();
    await transport.close();
  }));
  if (host) {
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
console.log(`Packaged smoke passed (${platform}-${process.arch}).`);
console.log('Packaged Electron + app.asar bridge: write denied; project file unchanged.');
console.log('Offline Goose build manifest and bundled inference pins, hashes, and native version verified.');
console.log(`Frozen packaged research MCP tools: ${researchTools.join(', ')}.`);
console.log('Web tools absent by default and listed only after explicit enablement.');
console.log('Bundled research skill read from packaged ASAR; enabled web tools work in Agent/Research and stay absent in Chat.');
console.log('No model loaded or downloaded; no public network tool called.');
