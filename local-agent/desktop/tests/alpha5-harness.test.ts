import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { bindExecutionStopped, commandText, parseAcceptanceRequests, parseApprovalLine, sequenceCheck, sha256Text } from '../../../scripts/ssd-validation-support.ts';
import { LocalActions } from '../actions.ts';
import { ApprovalRegistry } from '../approvals.ts';
import { RuntimeError } from '../../runtime/index.ts';
import { checkFromHostAction } from '../task-outcome.ts';
import type { TaskCheck, ToolActivity } from '../renderer/types.ts';
import { lstat } from 'node:fs/promises';

test('acceptance requests require independent evidence and keep Chat action-free', () => {
  assert.equal(parseAcceptanceRequests([{ name: 'chat', mode: 'assistant', request: 'Answer the question.', expectedAnswer: '42' }])[0].expectedAnswer, '42');
  assert.throws(() => parseAcceptanceRequests([{ name: 'self-claim', mode: 'coding', request: 'Build it.' }]), /independent assertion/);
  assert.throws(() => parseAcceptanceRequests([{ name: 'chat-action', mode: 'assistant', request: 'Hello.', expectedAnswer: 'Hello', expectedFiles: { 'file.txt': 'bad' } }]), /no file or command actions/);
  assert.throws(() => parseAcceptanceRequests([{ name: 'escape', mode: 'coding', request: 'Write a file.', expectedFiles: { '../other.txt': 'bad' } }]), /inside the test workspace/);
  assert.throws(() => parseAcceptanceRequests([{ name: 'duplicate', mode: 'assistant', request: 'Hi', expectedAnswer: 'Hi' }, { name: 'duplicate', mode: 'assistant', request: 'Hi', expectedAnswer: 'Hi' }]), /unique/);
});

test('manual review rejects bare or ambiguous approval text', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(parseApprovalLine(`approve ${id}`), { type: 'decision', requestId: id, approved: true });
  assert.deepEqual(parseApprovalLine(`deny ${id}`), { type: 'decision', requestId: id, approved: false });
  for (const line of ['approve', 'yes', 'approve all', `approve ${id} extra`, 'approve old-action', 'auto-approve']) assert.deepEqual(parseApprovalLine(line), { type: 'invalid' });
  assert.deepEqual(parseApprovalLine('cancel'), { type: 'cancel' });
});

test('independent command arguments and stdin remain literal data through the shell', async () => {
  const args = ["O'Brien", '$(printf injected)', '`printf injected`', 'line\nnext', '$HOME'];
  const invocation = commandText({ name: 'literal', command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], timeoutMs: 1000, expectedExitCode: 0 });
  const completed = await promisify(execFile)('/bin/sh', ['-c', invocation]);
  assert.deepEqual(JSON.parse(completed.stdout), args);
  const input = "line one\nO'Brien $(printf bad) `printf bad` $HOME\n";
  const pipe = commandText({ name: 'stdin', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: input, timeoutMs: 1000, expectedExitCode: 0 });
  const piped = await promisify(execFile)('/bin/sh', ['-c', pipe]); assert.equal(piped.stdout, input);
});

test('file-sequence acceptance requires exact ordered readbacks and independently owned edit receipts', () => {
  const root = path.resolve('/tmp/ssd-harness-fixture'), relative = 'note.txt', initial = 'Literal 1: first.\r\nسلام\n', final = 'Literal 1: verified.\r\nسلام\n';
  const expected = { path: relative, initial, final, fileOnly: true };
  const before = sha256Text(initial), after = sha256Text(final);
  const receipt = (operation: string, digest: string, id: string) => ({ ok: true, operation, path: relative, changed: true, sha256: digest, action_id: id });
  const created = receipt('write_file', before, 'host-create'), edited = receipt('edit_file', after, 'host-edit');
  const read = (text: string, digest: string) => ({ ok: true, path: path.join(root, relative), text, sha256: digest, size: Buffer.byteLength(text), start_byte: 0, end_byte: Buffer.byteLength(text), eof: true });
  const activity = (id: string, title: string, output: unknown): ToolActivity => ({ id, title, status: 'completed', output: { structuredContent: output } });
  const tools = [activity('create', 'Write file', created), activity('read-before', 'Read file', read(initial, before)), activity('edit', 'Edit file', edited), activity('read-after', 'Read file', read(final, after))];
  const checks = [created, edited].map((value, index) => checkFromHostAction({ id: index ? 'host-edit' : 'host-create', title: 'File mutation', status: 'completed', output: { content: [], structuredContent: value } })!) as TaskCheck[];
  assert.equal(sequenceCheck(root, expected, tools, checks).status, 'passed');
  assert.equal(sequenceCheck(root, expected, tools, []).status, 'failed');
  assert.equal(sequenceCheck(root, expected, [tools[0], tools[2], tools[1], tools[3]], checks).status, 'failed');
  assert.equal(sequenceCheck(root, expected, tools.map((tool, index) => index === 2 ? activity('edit', 'Edit file', { ...edited, action_id: 'model-invented' }) : tool), checks).status, 'failed');
  assert.equal(sequenceCheck(root, expected, [...tools, activity('command', 'Run command', { ok: true, operation: 'run_command' })], checks).status, 'failed');
});

test('the native harness help is non-mutating and automatic approval flags are rejected before startup', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ssd-harness-help-'));
  const script = path.resolve('scripts/validate-ssd-agent.ts');
  try {
    const help = await promisify(execFile)(process.execPath, [script, '--help'], { cwd });
    assert.match(help.stdout, /no automatic approval option/i);
    assert.match(help.stdout, /Cross-volume linking fails explicitly/);
    assert.match(help.stdout, /--backend cpu\|metal/);
    assert.match(help.stdout, /Metal task remains unvalidated for numerical parity/);
    await assert.rejects(promisify(execFile)(process.execPath, [script, '--auto-approve'], { cwd }), /Unknown option/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a trusted watchdog stop cancels pending approval before any file mutation and rejects duplicate or late approvals', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ssd-stop-approval-')));
  const runtime = new EventEmitter(), controller = new AbortController(), sessionId = 'session', turnId = 'turn';
  let permissionReady!: (requestId: string) => void, cancellations = 0;
  const pending = new Promise<string>(resolve => { permissionReady = resolve; });
  const registry = new ApprovalRegistry({ emit: event => { if (event.type === 'permission') permissionReady(event.requestId); } });
  const dispose = bindExecutionStopped(runtime, { model: 'gemma4:26b', trialId: () => 'live-trial', controller, signal: controller.signal, registry, sessionId, cancelBackend: () => { cancellations++; } });
  try {
    const actions = new LocalActions({ projectPath: directory, historyDirectory: path.join(directory, 'history'), onPermission: (permission, signal) => registry.request(sessionId, turnId, permission, signal!) });
    const action = actions.execute('write_file', { path: 'after-stop.txt', content: 'must never be written' }, { signal: controller.signal });
    const requestId = await Promise.race([pending, action.then(result => { throw new Error(`The action failed before reaching approval: ${JSON.stringify(result)}`); })]);
    runtime.emit('executionStopped', { model: 'other-model', code: 'EXPERIMENTAL_RESIDENT_LIMIT', message: 'wrong model', trialId: 'live-trial' });
    runtime.emit('executionStopped', { model: 'gemma4:26b', code: 'EXPERIMENTAL_RESIDENT_LIMIT', message: 'old trial', trialId: 'prior-trial' });
    assert.equal(registry.snapshot(sessionId, turnId).pending.length, 1);
    assert.equal(controller.signal.aborted, false);
    const stopped = { model: 'gemma4:26b', code: 'EXPERIMENTAL_RESIDENT_LIMIT', message: 'Native resident limit reached.', trialId: 'live-trial' };
    runtime.emit('executionStopped', stopped);
    assert(controller.signal.reason instanceof RuntimeError);
    assert.equal(controller.signal.reason.code, stopped.code);
    assert.equal(registry.snapshot(sessionId, turnId).pending.length, 0);
    assert.equal(registry.respond({ requestId, approved: true, sessionId, turnId }).status, 'expired');
    runtime.emit('executionStopped', stopped);
    assert.equal(cancellations, 1);
    const result = await action; assert.equal(result.isError, true);
    await assert.rejects(lstat(path.join(directory, 'after-stop.txt')), { code: 'ENOENT' });
    dispose(); assert.equal(runtime.listenerCount('executionStopped'), 0);
    runtime.emit('executionStopped', stopped); assert.equal(cancellations, 1);
  } finally { dispose(); controller.abort(); registry.cancelAll(); await rm(directory, { recursive: true, force: true }); }
});

test('a prior genuine manual cancellation remains the cause when worker shutdown arrives later', () => {
  const runtime = new EventEmitter(), controller = new AbortController(), manual = new Error('Manual cancellation');
  controller.abort(manual);
  const registry = new ApprovalRegistry({ emit: () => {} });
  const dispose = bindExecutionStopped(runtime, { model: 'model', trialId: () => 'trial', controller, signal: controller.signal, registry, sessionId: 'session', cancelBackend: () => {} });
  runtime.emit('executionStopped', { model: 'model', code: 'SSD_INFERENCE_INTERRUPTED', message: 'The worker stopped.', trialId: 'trial' });
  assert.equal(controller.signal.reason, manual);
  assert.equal(controller.signal.reason instanceof RuntimeError, false);
  dispose(); assert.equal(runtime.listenerCount('executionStopped'), 0);
});
