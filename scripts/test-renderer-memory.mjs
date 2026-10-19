import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, migrateState } from '../local-agent/desktop/state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), options = { baseline: false };
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flag === '--baseline') { assert.equal(options.baseline, false, 'Duplicate --baseline.'); options.baseline = true; }
  else if (['--app', '--report', '--electron'].includes(flag)) {
    const key = flag.slice(2);
    assert.equal(options[key], undefined, `Duplicate ${flag}.`);
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${flag} requires a path.`);
    options[key] = path.resolve(args[++index]);
  } else throw new Error(`Unknown argument: ${flag}. Use --app <app.asar> [--report <file>] [--electron <executable>] [--baseline].`);
}
assert.ok(options.app, '--app must select an actual packaged app.asar.');
const appPath = await realpath(options.app);
assert.equal(path.basename(appPath), 'app.asar', 'This harness requires packaged assets.');
const require = createRequire(import.meta.url);
const electronPath = await realpath(options.electron ?? require('electron'));
const reportPath = options.report ?? path.join(root, '.cache', `renderer-memory-${options.baseline ? 'baseline' : 'candidate'}-${Date.now()}.json`);
const profile = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-renderer-memory-')));
const childReportPath = path.join(profile, 'renderer-observations.json');
const fixturePath = path.join(profile, 'memory-fixture.json');
const sessionId = '38e42684-16b2-4f99-8a05-4af091515089';
const digest = value => createHash('sha256').update(value).digest('hex');
async function fileBinding(file) {
  const resolved = await realpath(file), hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(resolved)) { hash.update(chunk); bytes += chunk.length; }
  return { path: resolved, bytes, sha256: hash.digest('hex') };
}
const rows = Array.from({ length: 48 }, (_, index) => `scalar-${index}: authored fixture`);
const tools = Array.from({ length: 256 }, (_, index) => ({
  id: `memory-${index}`, title: `Authored command receipt ${index}`, status: 'completed',
  input: { command: 'python verify_fixture.py', cwd: '.', purpose: 'verification', checkIds: ['authored-check'], timeout_ms: 60000, rows },
  output: { ok: true, operation: 'run_command', action_id: `authored-action-${index}`, log_id: `log-${index.toString(16).padStart(8, '0')}`,
    exit_code: 0, output_complete: true, next_offset: null, rows,
    output_text: `AUTHORED_RENDERER_MEMORY_STDOUT_${index}\nسلام 🌍\n${JSON.stringify(rows)}\n` },
}));
for (const tool of tools) for (const value of [tool.input, tool.output]) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 16 * 1024, 'Every authored tool detail must fit the unchanged retention bound.');
}
const binding = { modelId: 'authored-renderer-only', digest: 'a'.repeat(64), templateHash: 'b'.repeat(64), profileSignature: 'authored-no-inference' };
const privateText = 'HOST_ONLY_RENDERER_MEMORY_TRANSCRIPT\n'.repeat(7500);
const canonicalTranscript = [{ role: 'user', content: privateText }, { role: 'assistant', content: 'Authored host transcript.', reasoning_content: privateText }];
const brief = { version: 1, requestHash: 'c'.repeat(64), goal: 'Authored renderer fixture; no command was executed.', deliverables: ['authored.txt'],
  criteria: [{ id: 'authored-check', kind: 'manual', description: 'Authored display receipt only; no execution evidence.' }] };
const messages = [{ role: 'user', content: 'AUTHORED_RENDERER_MEMORY_REQUEST\nNo model or command should run.' },
  { role: 'assistant', content: 'AUTHORED_RENDERER_MEMORY_ANSWER\nThese are authored display records, not executed work.', thinking: 'AUTHORED_RENDERER_MEMORY_THINKING\nNo inference ran.', tools,
    outcome: { status: 'incomplete', finishReason: 'Authored display fixture; no task execution.', verification: 'unverified',
      checks: [{ id: 'authored-check', title: 'Authored receipt display', status: 'unverified', detail: 'No command or model was run.', toolId: 'memory-0' }] } }];
const authoredSession = { id: sessionId, title: 'Authored renderer memory fixture', updatedAt: '2026-10-17T00:00:00.000Z', mode: 'coding', taskEffort: 'careful',
  preferredModel: null, messages, files: [], draft: '', draftFiles: [], draftRevision: 0,
  canonicalTranscript, transcriptBinding: binding, transcriptIncomplete: true,
  transcriptHistory: [{ binding, messages: canonicalTranscript, throughMessageCount: messages.length }], taskBrief: brief };
const state = migrateState({ ...emptyState(), selectedModel: null, navigation: { current: { screen: 'conversation', sessionId }, back: [] }, sessions: [authoredSession] });
assert.equal(state.selectedModel, null);
assert.deepEqual(state.sessions[0].messages, messages, 'Migration must preserve every authored visible byte.');
const stateJSON = JSON.stringify(state);
assert.ok(Buffer.byteLength(stateJSON) < 100 * 1024 * 1024, 'The isolated chat store must stay below 100 MiB.');
const expectedSession = { id: sessionId, mode: 'coding', messages, files: [], draft: '', draftFiles: [], draftRevision: 0, preferredModel: null, taskEffort: 'careful' };
const fixture = { classification: 'authored-renderer-memory-fixture-v1', sessionId, tools: 256,
  visibleMessagesSha256: digest(JSON.stringify(state.sessions[0].messages)), expectedRendererKeys: Object.keys(expectedSession).sort(),
  thinking: messages[1].thinking, firstTool: tools[0], answer: messages[1].content,
  stateBytes: Buffer.byteLength(stateJSON), stateSha256: digest(stateJSON),
  hostTranscriptBytes: Buffer.byteLength(JSON.stringify({ canonicalTranscript, transcriptHistory: authoredSession.transcriptHistory })),
  expectedRendererBytesWithoutStage: Buffer.byteLength(JSON.stringify(expectedSession)),
  perToolBytes: { input: Buffer.byteLength(JSON.stringify(tools[0].input)), output: Buffer.byteLength(JSON.stringify(tools[0].output)) } };
await writeFile(path.join(profile, 'chats.json'), stateJSON, { mode: 0o600, flag: 'wx' });
await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
const sourceFiles = ['scripts/test-renderer-memory.mjs', 'scripts/electron-renderer-memory-host.cjs',
  'local-agent/desktop/main.ts', 'local-agent/desktop/preload.ts', 'local-agent/desktop/session-projection.ts',
  'local-agent/desktop/renderer/WorkingDetails.tsx', 'local-agent/desktop/renderer/HighlightedCode.tsx', 'local-agent/desktop/state.ts'];
const provenance = { package: await fileBinding(appPath), externalElectron: await fileBinding(electronPath),
  sources: await Promise.all(sourceFiles.map(file => fileBinding(path.join(root, file)))),
  sourceScope: 'Current workspace files observed at launch; these hashes do not prove an older package was built from these sources.',
  fixture: await fileBinding(fixturePath), authoredChatStore: await fileBinding(path.join(profile, 'chats.json')) };
const report = { schemaVersion: 1, classification: 'authored-packaged-renderer-memory-diagnostic',
  mode: options.baseline ? 'baseline-observation' : 'lazy-renderer-and-projection-check',
  status: 'running', startedAt: new Date().toISOString(), appPath, profile, fixture, provenance,
  inference: 'none; no model selection, Send, provider, tool invocation or command execution',
  actual8GBModelEvidence: false, qualificationEstablished: false, qualityClaimEstablished: false,
  measurementScope: 'Observed renderer JS heap, DOM counters and separate Electron-owned process metrics; no allocation high-water mark, forced GC, additive shared-memory total or guaranteed improvement.',
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const startedAt = new Date().toISOString();
const child = spawn(electronPath, [path.join(root, 'scripts/electron-renderer-memory-host.cjs'), `--user-data-dir=${profile}`,
  `--memory-app=${appPath}`, `--memory-report=${childReportPath}`, `--memory-fixture=${fixturePath}`, ...(options.baseline ? ['--memory-baseline'] : [])],
{ cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
let stdoutTail = '', stderrTail = '', timedOut = false, spawnError;
child.stdout.on('data', chunk => { stdoutTail = (stdoutTail + String(chunk)).slice(-12000); });
child.stderr.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-16000); });
child.once('error', error => { spawnError = String(error.stack || error); });
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 115000);
const forceStop = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
const closure = await new Promise(resolve => child.once('close', (code, signal) => resolve({ pid: child.pid ?? null, parentPid: process.pid,
  startedAt, closedAt: new Date().toISOString(), code, signal, actualCloseObserved: true })));
clearTimeout(timeout); clearTimeout(forceStop);
let observations, observationReadError;
try { observations = JSON.parse(await readFile(childReportPath, 'utf8')); }
catch (error) { observationReadError = String(error); }
Object.assign(report, { status: !timedOut && !spawnError && closure.code === 0 && observations?.status === 'passed' && observations.normalQuitObserved === true ? 'passed' : 'failed',
  completedAt: new Date().toISOString(), closure, timedOut, ...(spawnError ? { spawnError } : {}),
  ...(observationReadError ? { observationReadError } : {}), observations, stdoutTail, stderrTail,
  isolatedProfileRetained: true, retentionReason: 'Retain the authored profile and exact fixture for review and comparisons.' });
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, status: report.status, mode: report.mode, profile, closure }));
if (report.status !== 'passed') process.exitCode = 1;
