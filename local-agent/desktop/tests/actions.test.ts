import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACTION_TOOL_SCHEMAS, LocalActions, type ActionPermission, type LocalActionsOptions } from '../actions.ts';
import { commandTimeoutLimits, commandTimeoutText } from '../action-protocol.ts';

async function setup(onPermission: (permission: ActionPermission) => Promise<boolean> = async () => true,
  options: Partial<Pick<LocalActionsOptions, 'resultChars' | 'utilities' | 'onTool'>> = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-action-test-')));
  const projectPath = path.join(directory, 'project');
  const historyDirectory = path.join(directory, 'history');
  await mkdir(projectPath);
  const actions = new LocalActions({ projectPath, historyDirectory, onPermission, ...options });
  return { actions, directory, projectPath, historyDirectory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function nodeCommand(script: string): string {
  return `"${process.execPath.replace(/"/g, '\\"')}" -e "${script.replace(/"/g, '\\"')}"`;
}

function commandLogId(text: string): string {
  const id = /Saved command log: ([a-f0-9-]{36})/.exec(text)?.[1];
  assert.ok(id, 'Every executed command must return its durable log identity.');
  return id;
}

function commandLogMetadata(text: string): { log_id: string; durable_id: string; output_complete: boolean; next_offset: number | null } {
  return JSON.parse(text.split('\n')[0]);
}

test('a denied write or command performs no mutation', async () => {
  const run = await setup(async () => false);
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    assert.equal((await run.actions.execute('write_file', { path: 'app.txt', content: 'after' })).isError, true);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
    assert.equal((await run.actions.execute('run_command', { command: 'echo created > denied.txt' })).isError, true);
    assert.deepEqual(await readdir(run.projectPath), ['app.txt']);
    await assert.rejects(lstat(run.historyDirectory), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally { await run.cleanup(); }
});

test('the permission preview identifies the exact replacement', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'first\nbefore\nlast\n');
    const action = await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'before', new_text: 'after' });
    assert.equal(action.isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'first\nafter\nlast\n');
    assert.match(permissions[0].preview!, /@@ -2,1 \+2,1 @@\n-before\n\+after$/);
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'first\nbefore\nlast\n');
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('external changes while approval is pending make the proposed edit stale', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { await writeFile(path.join(run.projectPath, 'app.txt'), 'user changed it'); return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const action = await run.actions.execute('write_file', { path: 'app.txt', content: 'agent version' });
    assert.equal(action.isError, true);
    assert.match(action.content[0].text, /changed while approval/);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'user changed it');
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('path traversal, Git internals, keys, and environment files are blocked before approval', async () => {
  let requests = 0;
  const run = await setup(async () => { requests++; return true; });
  try {
    for (const file of ['../outside.txt', '.git/config', '.env', '.env.production', 'auth/token.json', 'id_ed25519', 'certificate.pem']) {
      assert.equal((await run.actions.execute('write_file', { path: file, content: 'blocked' })).isError, true, file);
    }
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await run.cleanup(); }
});

test('symlink files and parent directories cannot escape the project', async () => {
  const run = await setup();
  try {
    const outside = path.join(run.directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(outside, path.join(run.projectPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(outside, 'keep.txt'), path.join(run.projectPath, 'keep.txt'));
    assert.equal((await run.actions.execute('write_file', { path: 'linked/keep.txt', content: 'changed' })).isError, true);
    assert.equal((await run.actions.execute('write_file', { path: 'keep.txt', content: 'changed' })).isError, true);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { await run.cleanup(); }
});

test('a swapped parent symlink is caught after approval', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => {
    await rm(path.join(run.projectPath, 'src'), { recursive: true });
    await symlink(path.join(run.directory, 'outside'), path.join(run.projectPath, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  });
  try {
    await mkdir(path.join(run.projectPath, 'src'));
    await mkdir(path.join(run.directory, 'outside'));
    const action = await run.actions.execute('write_file', { path: 'src/new.txt', content: 'changed' });
    assert.equal(action.isError, true);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
  } finally { await run.cleanup(); }
});

test('undo removes created files and preserves later external modifications', async () => {
  const run = await setup();
  try {
    assert.equal((await run.actions.execute('write_file', { path: 'nested/new.txt', content: 'created' })).isError, undefined);
    assert.equal(await run.actions.undo(), 1);
    await assert.rejects(lstat(path.join(run.projectPath, 'nested/new.txt')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await writeFile(path.join(run.projectPath, 'app.txt'), 'initial');
    await run.actions.execute('write_file', { path: 'app.txt', content: 'agent version' });
    await writeFile(path.join(run.projectPath, 'app.txt'), 'user version');
    assert.equal(await run.actions.undo(), 0);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'user version');
  } finally { await run.cleanup(); }
});

test('undo can restore snapshots in a new service instance', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    await run.actions.execute('write_file', { path: 'app.txt', content: 'after' });
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => false });
    assert.equal(await restarted.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('UTF-8 byte order marks survive exact replacements and undo', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'bom.txt'), '\ufeffbefore\n');
    assert.equal((await run.actions.execute('edit_file', { path: 'bom.txt', old_text: 'before', new_text: 'after' })).isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'bom.txt'), 'utf8'), '\ufeffafter\n');
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'bom.txt'), 'utf8'), '\ufeffbefore\n');
  } finally { await run.cleanup(); }
});

test('ambiguous text, binary, invalid UTF-8, large files, and private key content are rejected', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'same same');
    assert.equal((await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'same', new_text: 'new' })).isError, true);
    await writeFile(path.join(run.projectPath, 'binary.txt'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(run.projectPath, 'utf8.txt'), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(run.projectPath, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    await writeFile(path.join(run.projectPath, 'private.txt'), '-----BEGIN PRIVATE KEY-----\nsecret');
    for (const file of ['binary.txt', 'utf8.txt', 'large.txt', 'private.txt']) assert.equal((await run.actions.execute('write_file', { path: file, content: 'changed' })).isError, true, file);
  } finally { await run.cleanup(); }
});

test('approved commands run in the exact reviewed directory and capture output', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return true; });
  try {
    await mkdir(path.join(run.projectPath, 'sub'));
    const command = process.platform === 'win32' ? 'echo approved' : 'printf approved';
    const action = await run.actions.execute('run_command', { command, cwd: 'sub' });
    assert.equal(action.isError, undefined);
    assert.match(action.content[0].text, /approved/);
    assert.equal(permissions[0].command, command);
    assert.equal(permissions[0].cwd, path.join(run.projectPath, 'sub'));
    assert.equal((await run.actions.execute('run_command', { command, cwd: '../' })).isError, true);
  } finally { await run.cleanup(); }
});

test('commands can be cancelled and are stopped at the configured time limit', async () => {
  const run = await setup();
  try {
    const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.actions.execute('run_command', { command }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const cancelled = await pending;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /cancelled/);
    assert.ok(Date.now() - started < 5000);
    const timed = await run.actions.execute('run_command', { command, timeout_ms: 100 });
    assert.equal(timed.isError, true);
    assert.match(timed.content[0].text, /time limit/);
    assert.equal(timed.errorCode, 'COMMAND_TIMEOUT');
    assert.equal(timed.content[1].text, commandTimeoutText);
    const timedRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(timed.content[0].text)}.json`), 'utf8'));
    assert.equal(timedRecord.state, 'interrupted'); assert.equal(timedRecord.timeoutMs, 100); assert.equal(timedRecord.errorCode, 'COMMAND_TIMEOUT');
  } finally { await run.cleanup(); }
});

test('commands require valid explicit bounds while omitted timeout retains its reviewed 60 second default', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  try {
    for (const timeout_ms of [99, 600001, 1.5, NaN, Infinity, null, '600000']) {
      const rejected = await run.actions.execute('run_command', { command: 'echo forbidden', timeout_ms });
      assert.equal(rejected.errorCode, 'INVALID_TIMEOUT');
    }
    assert.equal(permissions.length, 0);
    const defaultCommand = await run.actions.execute('run_command', { command: 'exit 0' });
    assert.equal(defaultCommand.isError, undefined);
    assert.equal(permissions[0].arguments.timeout_ms, commandTimeoutLimits.default);
    const defaultRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(defaultCommand.content[0].text)}.json`), 'utf8'));
    assert.equal(defaultRecord.timeoutMs, 60000); assert.equal(defaultRecord.state, 'completed');
    const longCommand = await run.actions.execute('run_command', { command: 'exit 0', timeout_ms: 600000 });
    assert.equal(longCommand.isError, undefined); assert.equal(permissions[1].arguments.timeout_ms, 600000);
    const longRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(longCommand.content[0].text)}.json`), 'utf8'));
    assert.equal(longRecord.timeoutMs, 600000); assert.equal(longRecord.state, 'completed');
    const schema = ACTION_TOOL_SCHEMAS.find(item => item.name === 'run_command')!;
    assert.equal(schema.inputSchema.properties.timeout_ms.minimum, 100);
    assert.equal(schema.inputSchema.properties.timeout_ms.maximum, 600000);
    assert.equal(schema.inputSchema.properties.timeout_ms.default, 60000);
  } finally { await run.cleanup(); }
});

test('explicit 10 minute dependency commands still cancel promptly and preserve partial work without replay', async () => {
  const run = await setup(); const controller = new AbortController();
  try {
    const command = process.platform === 'win32' ? 'echo EXECUTED>>count.txt & ping -n 30 127.0.0.1 >nul' : "printf 'EXECUTED\\n' >> count.txt; sleep 30";
    const pending = run.actions.execute('run_command', { command, timeout_ms: 600000 }, { signal: controller.signal });
    for (let index = 0; index < 100; index++) {
      if (await readFile(path.join(run.projectPath, 'count.txt'), 'utf8').catch(() => '')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await readFile(path.join(run.projectPath, 'count.txt'), 'utf8')).trim(), 'EXECUTED');
    const stoppedAt = Date.now(); controller.abort();
    const output = await pending;
    assert.equal(output.isError, true); assert.equal(output.errorCode, 'COMMAND_INTERRUPTED');
    assert.ok(Date.now() - stoppedAt < 5000);
    const record = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(output.content[0].text)}.json`), 'utf8'));
    assert.equal(record.state, 'interrupted'); assert.equal(record.timeoutMs, 600000);
    const reopened = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => { throw new Error('No automatic replay approval expected.'); } });
    assert.equal((await reopened.execute('read_command_output', { id: record.id })).isError, undefined);
    assert.equal((await readFile(path.join(run.projectPath, 'count.txt'), 'utf8')).trim(), 'EXECUTED');
  } finally { controller.abort(); await run.cleanup(); }
});

test('cancellation stops an owned descendant that ignores SIGTERM after its shell closes', { skip: process.platform === 'win32' }, async () => {
  const run = await setup();
  const controller = new AbortController();
  let descendantPid: number | undefined;
  let outputPromise: ReturnType<LocalActions['execute']> | undefined;
  const isRunning = async (pid: number) => {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
    if (process.platform === 'linux') {
      // A killed child adopted by a container's init may briefly be a zombie.
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!status || /^\d+ \(.+\) Z /.test(status)) return false;
    }
    return true;
  };
  try {
    const descendant = "process.on('SIGTERM',()=>{});require('fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)";
    const command = nodeCommand(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>{},30000)`);
    outputPromise = run.actions.execute('run_command', { command }, { signal: controller.signal });
    const readyDeadline = Date.now() + 5000;
    while (Date.now() < readyDeadline) {
      const raw = await readFile(path.join(run.projectPath, 'descendant.pid'), 'utf8').catch(() => '');
      if (raw) { descendantPid = Number(raw); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(descendantPid && Number.isSafeInteger(descendantPid));
    assert.equal(await isRunning(descendantPid!), true);
    const stoppedAt = Date.now();
    controller.abort();
    const output = await outputPromise;
    assert.equal(output.isError, true);
    assert.ok(Date.now() - stoppedAt < 5000, 'Cancellation cleanup must remain bounded.');
    const cleanupDeadline = Date.now() + 2000;
    while (await isRunning(descendantPid!) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await isRunning(descendantPid!), false, 'Stop must also terminate the ignored-SIGTERM descendant.');
    const id = commandLogId(output.content[0].text);
    assert.equal(JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${id}.json`), 'utf8')).state, 'interrupted');
  } finally {
    controller.abort();
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    await outputPromise;
    await run.cleanup();
  }
});

test('cancellation while approval is pending prevents a late approval from executing', async () => {
  let approve!: (value: boolean) => void;
  const waiting = new Promise<boolean>((resolve) => { approve = resolve; });
  const run = await setup(async () => waiting);
  try {
    const controller = new AbortController();
    const pending = run.actions.execute('write_file', { path: 'new.txt', content: 'late' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).isError, true);
    approve(true);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await run.cleanup(); }
});

test('cancellation after edit approval prevents the final project write and leaves no applied undo entry', async () => {
  const controller = new AbortController();
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, {
    onTool: event => { if (event.status === 'running') controller.abort(); },
  });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const output = await run.actions.execute('write_file', { path: 'app.txt', content: 'after' }, { signal: controller.signal });
    assert.equal(approvals, 1);
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /cancelled/);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
    assert.deepEqual(await readdir(run.projectPath), ['app.txt']);
    const snapshots = (await readdir(run.historyDirectory)).filter(name => name.endsWith('.json'));
    assert.equal(snapshots.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(run.historyDirectory, snapshots[0]), 'utf8')).applied, false);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('cancellation after command approval records interruption without spawning the command', async () => {
  const controller = new AbortController();
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, {
    onTool: event => { if (event.status === 'running') controller.abort(); },
  });
  try {
    const command = nodeCommand("require('fs').writeFileSync('should-not-exist.txt','ran')");
    const output = await run.actions.execute('run_command', { command }, { signal: controller.signal });
    assert.equal(approvals, 1);
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /cancelled/);
    assert.deepEqual(await readdir(run.projectPath), []);
    const logDirectory = path.join(run.historyDirectory, 'command-logs');
    const records = (await readdir(logDirectory)).filter(name => name.endsWith('.json'));
    assert.equal(records.length, 1);
    const record = JSON.parse(await readFile(path.join(logDirectory, records[0]), 'utf8'));
    assert.equal(record.state, 'interrupted');
    assert.equal(record.command, command);
    assert.equal((await lstat(path.join(logDirectory, `${record.id}.log`))).size, 0);
  } finally { await run.cleanup(); }
});

test('command output is retained with a bounded preview and unsuccessful exits report an error', async () => {
  const run = await setup();
  try {
    const failed = await run.actions.execute('run_command', { command: 'exit 7' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /code 7/);
    const output = await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('x'.repeat(200000))") });
    assert.equal(output.isError, undefined);
    assert.match(output.content[0].text, /Excerpt only/);
    assert.ok(Buffer.byteLength(output.content[0].text) < 2500);
    const id = commandLogId(output.content[0].text);
    assert.equal((await lstat(path.join(run.historyDirectory, 'command-logs', `${id}.log`))).size, 200000);
  } finally { await run.cleanup(); }
});

test('the saved command log stops at its 64 MiB resource cap', async () => {
  const run = await setup();
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('x'.repeat(67*1024*1024))") });
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /64 MB saved-log limit/);
    const id = commandLogId(output.content[0].text);
    assert.equal((await lstat(path.join(run.historyDirectory, 'command-logs', `${id}.log`))).size, 64 * 1024 * 1024);
    assert.ok(Buffer.byteLength(output.content[0].text) < 2500);
    const record = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${id}.json`), 'utf8'));
    assert.equal(record.state, 'interrupted');
    assert.equal(record.errorCode, 'COMMAND_INTERRUPTED');
  } finally { await run.cleanup(); }
});

test('paged UTF-8 command output is complete and reading it never reruns execution', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { resultChars: 501 });
  try {
    const original = '😀سلامabc'.repeat(1500);
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('execution-count.txt','x');process.stdout.write('😀سلامabc'.repeat(1500))") });
    assert.equal(output.isError, undefined);
    const durableId = commandLogId(output.content[0].text);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.equal(metadata.log_id, `log-${durableId.slice(0, 8)}`);
    assert.equal(metadata.durable_id, durableId);
    assert.equal(metadata.output_complete, false);
    assert.ok(metadata.next_offset! > 0 && metadata.next_offset! <= 501);
    const initial = Buffer.from(original).subarray(0, metadata.next_offset!).toString('utf8');
    assert.ok(output.content[0].text.includes(initial));
    assert.ok(!output.content[0].text.includes('\ufffd'), 'The initial excerpt must end at a complete UTF-8 character.');
    let offset: number | null = metadata.next_offset;
    const excerpts: string[] = [initial];
    while (offset !== null) {
      const response = await run.actions.execute('read_command_output', { id: metadata.log_id, offset });
      assert.equal(response.isError, undefined);
      const excerpt = JSON.parse(response.content[0].text) as { id: string; durable_id: string; offset: number; text: string; next_offset: number | null; size: number };
      assert.equal(excerpt.id, metadata.log_id);
      assert.equal(excerpt.durable_id, durableId);
      assert.equal(excerpt.offset, offset);
      assert.ok(Buffer.byteLength(excerpt.text) <= 501);
      assert.ok(!excerpt.text.includes('\ufffd'), 'UTF-8 characters cannot be lost at pagination boundaries.');
      if (excerpt.next_offset !== null) assert.ok(excerpt.next_offset > offset);
      excerpts.push(excerpt.text);
      offset = excerpt.next_offset;
    }
    assert.equal(excerpts.join(''), original);
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'execution-count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('complete command output exposes a short durable log reference without requesting another read', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('count.txt','x');process.stdout.write('complete output')") });
    assert.equal(output.isError, undefined);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.deepEqual(metadata, { log_id: `log-${metadata.durable_id.slice(0, 8)}`, durable_id: commandLogId(output.content[0].text), output_complete: true, next_offset: null });
    assert.match(output.content[0].text, /complete output/);
    assert.match(output.content[0].text, /no log read is needed/);
    assert.doesNotMatch(output.content[0].text, /Read remaining output|Use read_command_output/);
    const reopened = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
      onPermission: async () => { approvals++; return false; } });
    for (const id of [metadata.log_id, metadata.durable_id]) {
      const saved = await reopened.execute('read_command_output', { id });
      assert.equal(saved.isError, undefined);
      assert.equal(JSON.parse(saved.content[0].text).text, 'complete output');
    }
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('short command-log references reject unknown, foreign-chat, edit, malformed, and traversal identities', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const foreignLogs = path.join(run.directory, 'another-chat', 'command-logs');
    await mkdir(foreignLogs, { recursive: true });
    await writeFile(path.join(foreignLogs, 'a1b2c3d4-0000-4000-8000-000000000000.log'), 'foreign chat output');
    const edited = await run.actions.execute('write_file', { path: 'file.txt', content: 'kept' });
    assert.equal(edited.isError, undefined);
    const editId = (await readdir(run.historyDirectory)).find(name => name.endsWith('.json'))!.slice(0, -5);
    for (const id of ['log-a1b2c3d4', `log-${editId.slice(0, 8)}`]) {
      const missing = await run.actions.execute('read_command_output', { id });
      assert.equal(missing.errorCode, 'COMMAND_LOG_NOT_FOUND');
      assert.ok(!JSON.stringify(missing).includes('foreign chat output'));
    }
    for (const id of ['log-a1b2c3d', 'log-a1b2c3d4extra', '../another-chat/command-logs/a1b2c3d4-0000-4000-8000-000000000000.log', 'log-../../']) {
      assert.equal((await run.actions.execute('read_command_output', { id })).errorCode, 'INVALID_ARGUMENT');
    }
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'file.txt'), 'utf8'), 'kept');
  } finally { await run.cleanup(); }
});

test('colliding short log handles require exact UUIDs and never choose or rerun a command', async () => {
  let approvals = 0;
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { approvals++; return true; }, { onTool: event => {
    if (event.status !== 'running' || event.title !== 'Run command') return;
    const logs = path.join(run.historyDirectory, 'command-logs');
    mkdirSync(logs, { recursive: true });
    const tail = event.id.slice(8) === '-0000-4000-8000-000000000000' ? '-0000-4000-8000-000000000001' : '-0000-4000-8000-000000000000';
    writeFileSync(path.join(logs, `${event.id.slice(0, 8)}${tail}.log`), 'other saved command');
  } });
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('count.txt','x');process.stdout.write('original output')") });
    assert.equal(output.isError, undefined);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.equal(metadata.log_id, metadata.durable_id, 'A collision must return the full durable identity.');
    const ambiguous = await run.actions.execute('read_command_output', { id: `log-${metadata.durable_id.slice(0, 8)}` });
    assert.equal(ambiguous.errorCode, 'COMMAND_LOG_AMBIGUOUS');
    assert.match(ambiguous.content[0].text, /Use the exact durable UUID/);
    const exact = await run.actions.execute('read_command_output', { id: metadata.durable_id });
    assert.equal(exact.isError, undefined);
    assert.equal(JSON.parse(exact.content[0].text).text, 'original output');
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('file edit IDs and missing command logs give actionable guidance without exposing internal paths', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const edited = await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'before', new_text: 'after' });
    assert.equal(edited.isError, undefined);
    const editSnapshot = (await readdir(run.historyDirectory)).find(name => name.endsWith('.json'));
    assert.ok(editSnapshot);
    const editId = editSnapshot.slice(0, -5);
    for (const id of [editId, '00000000-0000-4000-8000-000000000000']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await run.actions.execute('read_command_output', { id });
        assert.equal(response.isError, true);
        assert.equal(response.errorCode, 'COMMAND_LOG_NOT_FOUND');
        assert.match(response.content[0].text, /Do not retry the same id/);
        assert.match(response.content[0].text, /log id returned by run_command/);
        assert.match(response.content[0].text, /use read_file to verify edited files/);
        assert.ok(!response.content[0].text.includes(run.historyDirectory));
        assert.ok(!response.content[0].text.includes('ENOENT'));
      }
    }
    const invalid = await run.actions.execute('read_command_output', { id: 'invented-id' });
    assert.equal(invalid.errorCode, 'INVALID_ARGUMENT');
    assert.match(invalid.content[0].text, /exact saved command log UUID returned by run_command/);
    assert.equal(approvals, 1, 'Reading a nonexistent log never asks for another action approval.');
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'after');
    assert.equal(await run.actions.undo(), 1, 'The successful edit and its undo remain intact.');
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('disabled host utilities refuse edits, commands, and logs before approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { utilities: { fileEditing: false, terminal: false } });
  try {
    for (const [name, args] of [
      ['write_file', { path: 'new.txt', content: 'disabled' }],
      ['create_files', { files: [{ path: 'new.txt', content: 'disabled' }] }],
      ['edit_file', { path: 'new.txt', old_text: 'old', new_text: 'new' }],
      ['run_command', { command: 'echo disabled' }],
      ['read_command_output', { id: '00000000-0000-0000-0000-000000000000' }],
    ] as const) {
      const response = await run.actions.execute(name, args);
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /disabled/i);
    }
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('an empty project can create a reviewed WordPress theme and verify it with an approved command', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  const theme = 'wp-content/themes/local-agent';
  const files = [
    { path: `${theme}/style.css`, content: '/*\nTheme Name: Local Agent\nVersion: 1.0.0\n*/\n' },
    { path: `${theme}/index.php`, content: '<?php get_header(); ?>\n<main><?php if (have_posts()) : while (have_posts()) : the_post(); the_title(); the_content(); endwhile; endif; ?></main>\n<?php get_footer(); ?>\n' },
    { path: `${theme}/functions.php`, content: "<?php\nadd_action('after_setup_theme', function () { add_theme_support('title-tag'); });\n" },
  ];
  try {
    assert.deepEqual(await readdir(run.projectPath), []);
    const created = await run.actions.execute('create_files', { files });
    assert.equal(created.isError, undefined);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].title, 'Create 3 project files');
    for (const file of files) {
      assert.ok(permissions[0].preview!.includes(`+++ ${file.path}`));
      assert.equal(await readFile(path.join(run.projectPath, file.path), 'utf8'), file.content);
    }
    const command = process.platform === 'win32' ? 'if exist functions.php (echo SCAFFOLD_OK) else (exit /b 1)' : 'test -f functions.php && test -f index.php && test -f style.css && printf SCAFFOLD_OK';
    const verified = await run.actions.execute('run_command', { command, cwd: theme });
    assert.equal(verified.isError, undefined);
    assert.match(verified.content[0].text, /SCAFFOLD_OK/);
    assert.equal(permissions.length, 2);
    assert.equal(permissions[1].cwd, path.join(run.projectPath, theme));
    assert.equal(await run.actions.undo(), 3, 'One undo reverses the complete reviewed creation batch.');
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('a denied creation batch makes no files, parent folders, or undo snapshots', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return false; });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }, { path: 'theme/style.css', content: 'body {}' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /denied/);
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), []);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('invalid, protected, existing and conflicting batch paths reject before approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'existing.txt'), 'keep');
    for (const files of [
      [],
      [{ path: '../outside.php', content: 'denied' }],
      [{ path: '.env', content: 'denied' }],
      [{ path: 'existing.txt', content: 'replacement' }],
      [{ path: 'theme', content: 'file' }, { path: 'theme/index.php', content: 'file' }],
      [{ path: 'same.txt', content: 'first' }, { path: './same.txt', content: 'second' }],
      [{ path: 'private.txt', content: '-----BEGIN PRIVATE KEY-----\nsecret' }],
      [{ path: 'large.txt', content: 'x'.repeat(512 * 1024 + 1) }],
      Array.from({ length: 21 }, (_, index) => ({ path: `${index}.txt`, content: 'text' })),
    ]) assert.equal((await run.actions.execute('create_files', { files })).isError, true);
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), ['existing.txt']);
    assert.equal(await readFile(path.join(run.projectPath, 'existing.txt'), 'utf8'), 'keep');
  } finally { await run.cleanup(); }
});

test('a stale batch approval preserves an externally created file and writes no other batch files', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { await writeFile(path.join(run.projectPath, 'second.txt'), 'user version'); return true; });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'nested/first.txt', content: 'agent first' }, { path: 'second.txt', content: 'agent second' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /appeared while approval/);
    assert.deepEqual(await readdir(run.projectPath), ['second.txt']);
    assert.equal(await readFile(path.join(run.projectPath, 'second.txt'), 'utf8'), 'user version');
  } finally { await run.cleanup(); }
});

test('cancelling an approved creation batch rolls back completed files and empty new folders', async () => {
  const controller = new AbortController();
  let creating = 0;
  const run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title.startsWith('Create ')) {
      creating++;
      if (creating === 2) controller.abort();
    }
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] }, { signal: controller.signal });
    assert.equal(creating, 2);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cancelled/);
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('batch undo works after service restart and preserves externally edited files', async () => {
  const run = await setup();
  try {
    await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] });
    await writeFile(path.join(run.projectPath, 'theme/first.php'), 'user edit');
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => false });
    assert.equal(await restarted.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/first.php'), 'utf8'), 'user edit');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['first.php']);
    assert.equal(await restarted.undo(), 0);
  } finally { await run.cleanup(); }
});

test('exclusive batch publication cannot overwrite a file created after its last preflight', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title === 'Create theme/index.php') writeFileSync(path.join(run.projectPath, 'theme/index.php'), 'user raced creation');
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /No existing file was overwritten/);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/index.php'), 'utf8'), 'user raced creation');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['index.php']);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('cancelled batch rollback preserves an external edit to an already created file', async () => {
  const controller = new AbortController();
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title === 'Create theme/second.php') {
      writeFileSync(path.join(run.projectPath, 'theme/first.php'), 'external edit during creation');
      controller.abort();
    }
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] }, { signal: controller.signal });
    assert.equal(response.isError, true);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/first.php'), 'utf8'), 'external edit during creation');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['first.php']);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('batch creation rejects swapped symlink parents and a replaced project root', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => {
    await mkdir(path.join(run.directory, 'outside'));
    await symlink(path.join(run.directory, 'outside'), path.join(run.projectPath, 'theme'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  });
  try {
    assert.equal((await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }] })).isError, true);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
    await rm(run.projectPath, { recursive: true });
    await symlink(path.join(run.directory, 'outside'), run.projectPath, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await run.actions.execute('create_files', { files: [{ path: 'new.php', content: '<?php echo 1;' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /selected project folder changed/i);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
  } finally { await run.cleanup(); }
});

test('cancelled commands retain interruption records across service restart without replay', async () => {
  const run = await setup(async () => true);
  const controller = new AbortController();
  let outputPromise: ReturnType<LocalActions['execute']> | undefined;
  try {
    const command = nodeCommand("require('fs').appendFileSync('execution-count.txt','x');process.stdout.write('saved before interruption');setTimeout(()=>{},30000)");
    outputPromise = run.actions.execute('run_command', { command }, { signal: controller.signal });
    const logDirectory = path.join(run.historyDirectory, 'command-logs');
    const deadline = Date.now() + 5000;
    let record: { id: string; command: string; state: string } | undefined;
    let logReady = false;
    while (Date.now() < deadline) {
      const records = await readdir(logDirectory).catch(() => []);
      const name = records.find(name => name.endsWith('.json'));
      if (name) {
        record = JSON.parse(await readFile(path.join(logDirectory, name), 'utf8'));
        const text = await readFile(path.join(logDirectory, `${record!.id}.log`), 'utf8').catch(() => '');
        if (text.includes('saved before interruption')) { logReady = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(record, 'The started command must be recorded durably before completion.');
    assert.equal(record!.state, 'started');
    assert.ok(logReady, 'Partial output must be durable while the command is running.');
    controller.abort();
    const output = await outputPromise;
    assert.equal(output.isError, true);
    const id = commandLogId(output.content[0].text);
    assert.equal(JSON.parse(await readFile(path.join(logDirectory, `${id}.json`), 'utf8')).state, 'interrupted');
    let approvals = 0;
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
      onPermission: async () => { approvals++; return true; } });
    const saved = await restarted.execute('read_command_output', { id, offset: 0 });
    assert.equal(saved.isError, undefined);
    assert.match(JSON.parse(saved.content[0].text).text, /saved before interruption/);
    assert.equal(approvals, 0);
    assert.equal(await readFile(path.join(run.projectPath, 'execution-count.txt'), 'utf8'), 'x');
  } finally { controller.abort(); await outputPromise; await run.cleanup(); }
});
