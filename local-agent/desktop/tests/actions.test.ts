import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalActions, type ActionPermission, type LocalActionsOptions } from '../actions.ts';

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
  } finally { await run.cleanup(); }
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
    assert.equal(record.state, 'failed');
  } finally { await run.cleanup(); }
});

test('paged UTF-8 command output is complete and reading it never reruns execution', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { resultChars: 501 });
  try {
    const original = '😀سلامabc'.repeat(1500);
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('execution-count.txt','x');process.stdout.write('😀سلامabc'.repeat(1500))") });
    assert.equal(output.isError, undefined);
    const id = commandLogId(output.content[0].text);
    let offset: number | null = 0;
    const excerpts: string[] = [];
    while (offset !== null) {
      const response = await run.actions.execute('read_command_output', { id, offset });
      assert.equal(response.isError, undefined);
      const excerpt = JSON.parse(response.content[0].text) as { offset: number; text: string; next_offset: number | null; size: number };
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

test('disabled host utilities refuse edits, commands, and logs before approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { utilities: { fileEditing: false, terminal: false } });
  try {
    for (const [name, args] of [
      ['write_file', { path: 'new.txt', content: 'disabled' }],
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
