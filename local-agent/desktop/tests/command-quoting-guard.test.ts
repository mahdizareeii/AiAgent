import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalActions, type ActionPermission, type ActionToolEvent, type ActionResult } from '../actions.ts';
import { createActionHost } from '../action-host.ts';
import { TaskVerificationLedger, type TaskBrief } from '../task-verification.ts';

interface Row { id: string; command: string; cwd: string; }
const posixOnly = { skip: process.platform === 'win32' };
async function fixture(options: { quote?: string; approve?: boolean; bound?: boolean;
  rows?: (command: string, executable: string) => Row[] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'command-quoting-guard-')));
  const workspace = path.join(directory, 'workspace'), history = path.join(directory, 'history');
  await mkdir(workspace); await mkdir(path.join(workspace, 'nested'));
  const executable = path.join(directory, 'Node With Spaces'); await symlink(process.execPath, executable);
  await writeFile(path.join(workspace, 'source.txt'), 'broken\n');
  const check = "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nassert.equal(fs.readFileSync('source.txt','utf8'),'fixed\\n');\n";
  await writeFile(path.join(workspace, 'check.mjs'), check);
  const quote = options.quote ?? "'", command = `${quote}${executable}${quote} check.mjs`;
  const rows = options.rows?.(command, executable) ?? [{ id: 'cmd_check', command, cwd: '.' }];
  const request = 'Observe the failing check, repair source.txt, rerun the check, and keep check.mjs unchanged.';
  const brief: TaskBrief = { version: 1, requestHash: createHash('sha256').update(request).digest('hex'), goal: request,
    deliverables: ['source.txt'], criteria: rows.map(row => ({ ...row, kind: 'command', description: 'Run the exact supplied check', paths: ['source.txt', 'check.mjs'] })) };
  const ledger = new TaskVerificationLedger(brief, workspace); await ledger.captureProtectedInputs(request);
  const originalBrief = structuredClone(brief), controller = new AbortController(), permissions: ActionPermission[] = [], events: ActionToolEvent[] = [];
  const actions = new LocalActions({ projectPath: workspace, historyDirectory: history, verificationCheckIds: ledger.verificationCheckIds,
    ...(options.bound === false ? {} : { frozenVerification: { turnId: 'current-turn', requestHash: brief.requestHash, workspacePath: workspace,
      signal: controller.signal, commands: rows.map(row => ({ ...row, kind: 'command' as const })) } }),
    onPermission: async permission => { permissions.push(permission); return options.approve ?? false; },
    onBeforeVerificationCommand: (id, args, signal) => ledger.beforeVerificationCommand(id, args, signal),
    onTool: event => { events.push(event); ledger.recordHostAction(event); },
  });
  return { actions, ledger, brief, originalBrief, controller, permissions, events, executable, command, workspace, history, check,
    cleanup: async () => { controller.abort(); await rm(directory, { recursive: true, force: true }); } };
}

test('one exact quote-stripped frozen spelling is rejected before approval, execution or verification evidence', posixOnly, async () => {
  for (const quote of ["'", '"']) {
    const f = await fixture({ quote, approve: true });
    try {
      const args = { command: `${f.executable} check.mjs`, cwd: '.', purpose: 'implementation', checkIds: [] }, original = structuredClone(args);
      const result = await f.actions.execute('run_command', args);
      assert.equal(result.errorCode, 'INVALID_ARGUMENT'); assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /^This looks like frozen command "cmd_check"/);
      assert.match(result.content[0].text, /run_verification\(\{"check_id":"cmd_check"\}\)/);
      assert.match(result.content[0].text, /first check is expected to fail/);
      assert.equal(f.permissions.length, 0); assert(f.events.every(event => event.status === 'pending' || event.status === 'failed'));
      assert.deepEqual(args, original); assert.deepEqual(f.brief, f.originalBrief);
      const checks = await f.ledger.evaluate(); assert.equal(checks.find(check => check.checkIds.includes('cmd_check'))!.status, 'unverified');
      assert(!checks.some(check => check.evidence?.operation === 'verify_command'));
      assert.equal(await readFile(path.join(f.workspace, 'source.txt'), 'utf8'), 'broken\n');
      assert.equal(await readFile(path.join(f.workspace, 'check.mjs'), 'utf8'), f.check);
      await assert.rejects(lstat(f.history), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    } finally { await f.cleanup(); }
  }
});

test('explicit ID recovery keeps normal approval and real failing, edit and post-repair receipts', posixOnly, async () => {
  const f = await fixture({ approve: true });
  try {
    assert.equal((await f.actions.execute('run_command', { command: `${f.executable} check.mjs`, purpose: 'implementation' })).errorCode, 'INVALID_ARGUMENT');
    assert.equal(f.permissions.length, 0);
    const first = await f.actions.execute('run_verification', { check_id: 'cmd_check' });
    assert.equal(first.structuredContent?.operation, 'run_command'); assert.equal(first.structuredContent?.exit_code, 1);
    assert.equal(first.structuredContent?.purpose, 'verification'); assert.deepEqual(first.structuredContent?.check_ids, ['cmd_check']);
    assert.equal((await f.ledger.evaluate()).find(check => check.checkIds.includes('cmd_check'))!.status, 'failed');
    const edit = await f.actions.execute('write_file', { path: 'source.txt', content: 'fixed\n' }); assert.equal(edit.structuredContent?.changed, true);
    const final = await f.actions.execute('run_verification', { check_id: 'cmd_check' });
    assert.equal(final.structuredContent?.operation, 'run_command'); assert.equal(final.structuredContent?.exit_code, 0);
    assert.deepEqual(final.structuredContent?.check_ids, ['cmd_check']); assert.equal(final.structuredContent?.purpose, 'verification');
    assert.equal(f.permissions.length, 3); assert.equal(f.permissions[0].command, f.command); assert.equal(f.permissions[2].command, f.command);
    assert.equal(f.permissions[0].cwd, f.workspace); assert.equal(f.permissions[2].cwd, f.workspace);
    const checks = await f.ledger.evaluate(); assert.equal(f.ledger.canFinish(checks), true); assert(checks.every(check => check.status === 'passed'));
    assert.deepEqual(f.brief, f.originalBrief); assert.equal(await readFile(path.join(f.workspace, 'check.mjs'), 'utf8'), f.check);
  } finally { await f.cleanup(); }
});

test('correct quoted implementation and unrelated debug commands retain approval and unverified acceptance', posixOnly, async () => {
  const f = await fixture({ approve: true });
  try {
    await writeFile(path.join(f.workspace, 'source.txt'), 'fixed\n');
    const implementation = await f.actions.execute('run_command', { command: f.command, purpose: 'implementation', checkIds: [] });
    assert.equal(implementation.structuredContent?.exit_code, 0); assert.equal(implementation.structuredContent?.purpose, 'implementation');
    const debug = await f.actions.execute('run_command', { command: `"${process.execPath}" -e "process.stdout.write('debug')"`, purpose: 'implementation' });
    assert.equal(debug.structuredContent?.exit_code, 0); assert.equal(f.permissions.length, 2);
    assert.equal((await f.ledger.evaluate()).find(check => check.checkIds.includes('cmd_check'))!.status, 'unverified');
  } finally { await f.cleanup(); }
});

test('near matches, cwd aliases and missing scopes retain the original approval/denial path', posixOnly, async () => {
  for (const variant of ['path', 'args', 'cwd', 'cwd-alias', 'no-map'] as const) {
    const f = await fixture({ bound: variant !== 'no-map' });
    try {
      const command = variant === 'path' ? `${f.executable}-other check.mjs` : `${f.executable} check.mjs${variant === 'args' ? ' --extra' : ''}`;
      const cwd = variant === 'cwd' ? 'nested' : variant === 'cwd-alias' ? './' : '.';
      const result = await f.actions.execute('run_command', { command, cwd, purpose: 'implementation' });
      assert.equal(result.errorCode, 'PERMISSION_DENIED'); assert.equal(f.permissions.length, 1);
      assert.equal(f.permissions[0].command, command); assert.equal(result.structuredContent, undefined);
      assert(!f.events.some(event => event.status === 'running')); assert.deepEqual(f.brief, f.originalBrief);
    } finally { await f.cleanup(); }
  }
});

test('duplicate candidates, exact existing rows and unsupported shell forms are never guessed or repaired', posixOnly, async () => {
  const variants: ((command: string, executable: string) => { rows: Row[]; proposed: string })[] = [
    (command, executable) => ({ rows: [{ id: 'one', command, cwd: '.' }, { id: 'two', command, cwd: '.' }], proposed: `${executable} check.mjs` }),
    (command, executable) => ({ rows: [{ id: 'one', command, cwd: '.' }, { id: 'two', command: `"${executable}" check.mjs`, cwd: '.' }], proposed: `${executable} check.mjs` }),
    (command, executable) => ({ rows: [{ id: 'one', command, cwd: '.' }, { id: 'two', command: `${executable} check.mjs`, cwd: '.' }], proposed: `${executable} check.mjs` }),
    () => ({ rows: [{ id: 'one', command: "'/safe/no-space/node' check.mjs", cwd: '.' }], proposed: '/safe/no-space/node check.mjs' }),
    (command, executable) => ({ rows: [{ id: 'one', command: `env X=1 ${command}`, cwd: '.' }], proposed: `env X=1 ${executable} check.mjs` }),
    (_command, executable) => ({ rows: [{ id: 'one', command: `'${executable}' 'argument with spaces'`, cwd: '.' }], proposed: `${executable} 'argument with spaces'` }),
    (_command, executable) => ({ rows: [{ id: 'one', command: `'${executable}' check.mjs | cat`, cwd: '.' }], proposed: `${executable} check.mjs | cat` }),
    () => ({ rows: [{ id: 'one', command: "'$HOME/Node With Spaces' check.mjs", cwd: '.' }], proposed: '$HOME/Node With Spaces check.mjs' }),
    () => ({ rows: [{ id: 'one', command: "'/tmp/Node; With Spaces' check.mjs", cwd: '.' }], proposed: '/tmp/Node; With Spaces check.mjs' }),
  ];
  for (const variant of variants) {
    let proposed = '';
    const f = await fixture({ rows: (command, executable) => { const value = variant(command, executable); proposed = value.proposed; return value.rows; } });
    try {
      const result = await f.actions.execute('run_command', { command: proposed, purpose: 'implementation' });
      assert.equal(result.errorCode, 'PERMISSION_DENIED'); assert.equal(f.permissions.length, 1);
      assert.equal(f.permissions[0].command, proposed); assert.equal(result.structuredContent, undefined);
      assert(!f.events.some(event => event.status === 'running'));
    } finally { await f.cleanup(); }
  }
});

test('a closed bound turn stays cancelled without ID guidance, approval or replay', posixOnly, async () => {
  const f = await fixture({ approve: true });
  try {
    f.controller.abort();
    const result = await f.actions.execute('run_command', { command: `${f.executable} check.mjs`, purpose: 'implementation' }, { signal: new AbortController().signal });
    assert.equal(result.errorCode, 'CANCELLED'); assert.equal(f.permissions.length, 0); assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(result.content[0].text, /run_verification/); assert(!f.events.some(event => event.status === 'running'));
  } finally { await f.cleanup(); }
});

test('legacy verification with known metadata retains its ordinary approval and denial path', posixOnly, async () => {
  const f = await fixture();
  try {
    const args = { command: `${f.executable} check.mjs`, cwd: '.', purpose: 'verification', checkIds: ['cmd_check'] }, original = structuredClone(args);
    const result = await f.actions.execute('run_command', args);
    assert.equal(result.errorCode, 'PERMISSION_DENIED'); assert.equal(f.permissions.length, 1); assert.equal(result.structuredContent, undefined);
    assert.equal(f.permissions[0].command, original.command); assert.equal(f.permissions[0].cwd, f.workspace);
    assert.equal(f.permissions[0].arguments.purpose, 'verification'); assert.deepEqual(f.permissions[0].arguments.checkIds, ['cmd_check']);
    assert.deepEqual(args, original); assert.deepEqual(f.brief, f.originalBrief);
    assert(!f.events.some(event => event.status === 'running'));
    const checks = await f.ledger.evaluate(); assert.equal(checks.find(check => check.checkIds.includes('cmd_check'))!.status, 'unverified');
    assert(!checks.some(check => check.evidence?.operation === 'verify_command'));
  } finally { await f.cleanup(); }
});

test('real host permits argument recovery but a real approval denial still ends the turn', { ...posixOnly, timeout: 5000 }, async () => {
  const f = await fixture(); let host: Awaited<ReturnType<typeof createActionHost>> | undefined;
  try {
    host = await createActionHost(f.actions, f.controller.signal);
    const post = async (tool: string, args: Record<string, unknown>): Promise<ActionResult> => {
      const response = await fetch(host!.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) });
      assert.equal(response.status, 200); return response.json() as Promise<ActionResult>;
    };
    const rejected = await post('run_command', { command: `${f.executable} check.mjs`, purpose: 'implementation', checkIds: [] });
    assert.equal(rejected.errorCode, 'INVALID_ARGUMENT'); assert.equal(f.permissions.length, 0);
    const denied = await post('run_verification', { check_id: 'cmd_check' });
    assert.equal(denied.errorCode, 'PERMISSION_DENIED'); assert.equal(f.permissions.length, 1); assert.equal(f.permissions[0].command, f.command);
    const later = await post('run_verification', { check_id: 'cmd_check' });
    assert.equal(later.errorCode, 'TURN_DENIED'); assert.equal(f.permissions.length, 1);
    assert.equal(rejected.structuredContent, undefined); assert.equal(denied.structuredContent, undefined); assert.equal(later.structuredContent, undefined);
    assert(!f.events.some(event => event.status === 'running'));
    const checks = await f.ledger.evaluate(); assert.equal(checks.find(check => check.checkIds.includes('cmd_check'))!.status, 'unverified');
    assert(!checks.some(check => check.evidence?.operation === 'verify_command'));
    assert.equal(await readFile(path.join(f.workspace, 'source.txt'), 'utf8'), 'broken\n');
    assert.equal(await readFile(path.join(f.workspace, 'check.mjs'), 'utf8'), f.check);
    await assert.rejects(lstat(f.history), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    f.controller.abort();
    if (host) { await host.drain(); host.server.closeAllConnections(); await new Promise<void>(resolve => host!.server.close(() => resolve())); }
    await f.cleanup();
  }
});
