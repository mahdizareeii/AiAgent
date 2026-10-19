import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalActions, type ActionToolEvent } from '../actions.ts';
import { isFailedVerificationCheck, RepairBudget } from '../repair-budget.ts';

function failedVerification(): ActionToolEvent {
  const id = 'ad2075ec-e3b6-4a56-860a-2e7ab3a0f4f0', command = 'node check.mjs';
  return { id, title: 'Run command', status: 'failed', input: { command, purpose: 'verification', checkIds: ['tests'] },
    output: { content: [{ type: 'text', text: 'PASS is command output, not exit evidence.' }], isError: true,
      structuredContent: { ok: false, operation: 'run_command', action_id: id, durable_id: id, command_sha256: createHash('sha256').update(command).digest('hex'),
        purpose: 'verification', check_ids: ['tests'], exit_code: 1, exit_signal: null } } };
}

test('a repair failure requires bound structured host evidence of a normally exited verification command', () => {
  assert.equal(isFailedVerificationCheck(failedVerification()), true);
  for (const code of [2, 127, -1]) {
    const event = failedVerification(); (event.output as any).structuredContent.exit_code = code;
    assert.equal(isFailedVerificationCheck(event), true, `Integer nonzero exit ${code} is an observed verification failure.`);
  }
  const reject: Array<[string, (event: ActionToolEvent) => void]> = [
    ['pending approval', event => { event.status = 'pending'; }],
    ['running command', event => { event.status = 'running'; }],
    ['inconsistent completed event', event => { event.status = 'completed'; }],
    ['successful result', event => { (event.output as any).isError = false; }],
    ['successful receipt', event => { (event.output as any).structuredContent.ok = true; }],
    ['implementation input', event => { (event.input as any).purpose = 'implementation'; }],
    ['implementation receipt', event => { (event.output as any).structuredContent.purpose = 'implementation'; }],
    ['file operation', event => { (event.output as any).structuredContent.operation = 'write_file'; }],
    ['zero exit', event => { (event.output as any).structuredContent.exit_code = 0; }],
    ['missing exit', event => { delete (event.output as any).structuredContent.exit_code; }],
    ['unknown exit', event => { (event.output as any).structuredContent.exit_code = null; }],
    ['string exit', event => { (event.output as any).structuredContent.exit_code = '1'; }],
    ['fractional exit', event => { (event.output as any).structuredContent.exit_code = 1.5; }],
    ['signal termination', event => { (event.output as any).structuredContent.exit_signal = 'SIGTERM'; }],
    ['missing signal', event => { delete (event.output as any).structuredContent.exit_signal; }],
    ['empty IDs', event => { (event.output as any).structuredContent.check_ids = []; }],
    ['unknown input IDs', event => { (event.input as any).checkIds = []; }],
    ['mismatched IDs', event => { (event.output as any).structuredContent.check_ids = ['different']; }],
    ['duplicate IDs', event => { (event.output as any).structuredContent.check_ids = ['tests', 'tests']; (event.input as any).checkIds = ['tests', 'tests']; }],
    ['invalid IDs', event => { (event.output as any).structuredContent.check_ids = ['bad.id']; (event.input as any).checkIds = ['bad.id']; }],
    ['oversized ID', event => { (event.output as any).structuredContent.check_ids = ['a'.repeat(65)]; (event.input as any).checkIds = ['a'.repeat(65)]; }],
    ['too many IDs', event => { const ids = Array.from({ length: 13 }, (_, i) => `test${i}`); (event.output as any).structuredContent.check_ids = ids; (event.input as any).checkIds = ids; }],
    ['unbound action', event => { (event.output as any).structuredContent.action_id = 'other'; }],
    ['unbound durable log', event => { (event.output as any).structuredContent.durable_id = 'other'; }],
    ['unbound command', event => { (event.input as any).command = 'node other.mjs'; }],
    ['missing command hash', event => { delete (event.output as any).structuredContent.command_sha256; }],
    ['prose only', event => { event.output = { content: [{ type: 'text', text: 'Verification exited with code 1.' }], isError: true }; }],
  ];
  for (const [name, modify] of reject) { const event = failedVerification(); modify(event); assert.equal(isFailedVerificationCheck(event), false, name); }
  for (const error of ['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'CANCELLED', 'COMMAND_TIMEOUT', 'COMMAND_INTERRUPTED']) {
    const resultError = failedVerification(); (resultError.output as any).errorCode = error;
    assert.equal(isFailedVerificationCheck(resultError), false, `Host error ${error} is not a normally exited verification.`);
    const receiptError = failedVerification(); (receiptError.output as any).structuredContent.error = error;
    assert.equal(isFailedVerificationCheck(receiptError), false, `Receipt error ${error} is not a normally exited verification.`);
  }
});

test('metadata validation errors cannot exhaust repair cycles and guidance preserves arguments and approval authority', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-repair-test-'))), projectPath = path.join(directory, 'project');
  await mkdir(projectPath);
  const events: ActionToolEvent[] = [], permissions: unknown[] = [], budget = new RepairBudget();
  const actions = new LocalActions({ projectPath, historyDirectory: path.join(directory, 'history'), verificationCheckIds: ['tests'],
    onPermission: async permission => { permissions.push(permission); return true; },
    onTool: event => { events.push(event); if (event.status === 'pending') budget.beginAction(event.id); if (isFailedVerificationCheck(event)) budget.failedCheck(); } });
  try {
    for (const metadata of [
      { purpose: 'debug', checkIds: [] }, { purpose: 'verification', checkIds: [] },
      { purpose: 'verification', checkIds: ['unknown'] }, { purpose: 'implementation', checkIds: ['tests'] },
      { purpose: 'verification', checkIds: ['tests', 'tests'] }, { purpose: 'verification', checkIds: ['bad.id'] },
    ]) {
      const args = { command: 'echo must-not-run > unintended.txt', ...metadata }, before = structuredClone(args);
      const result = await actions.execute('run_command', args);
      assert.equal(result.errorCode, 'INVALID_ARGUMENT');
      assert.match(result.content[0].text, /Implementation command receipts do not satisfy acceptance/);
      assert.match(result.content[0].text, /purpose:"verification", nonempty matching checkIds and the exact frozen command\/cwd/);
      assert.match(result.content[0].text, /No current frozen ID map is bound/);
      assert.deepEqual(args, before, 'Metadata errors must not normalize or rewrite proposed command arguments.');
    }
    assert.equal(permissions.length, 0, 'Invalid metadata cannot reach approval or execute.');
    assert.deepEqual(await readdir(projectPath), []);
    assert.equal(events.filter(isFailedVerificationCheck).length, 0);
    assert.equal(budget.beginAction('first-real-edit'), 0, 'Six metadata errors consume zero repair attempts.');
    for (let repair = 1; repair <= 3; repair++) { budget.failedCheck(); assert.equal(budget.beginAction(`real-repair-${repair}`), repair); }
    budget.failedCheck(); assert.throws(() => budget.beginAction('fourth-real-repair'), /Repair limit reached/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual failed verification receipts count while implementation failures and denied verification do not', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-repair-receipt-test-'))), projectPath = path.join(directory, 'project');
  await mkdir(projectPath);
  const events: ActionToolEvent[] = [], budget = new RepairBudget(); let approve = true;
  const actions = new LocalActions({ projectPath, historyDirectory: path.join(directory, 'history'), verificationCheckIds: ['tests'],
    onPermission: async () => approve,
    onTool: event => { events.push(event); if (event.status === 'pending') budget.beginAction(event.id); if (isFailedVerificationCheck(event)) budget.failedCheck(); } });
  try {
    const command = `"${process.execPath}" -e 'process.exit(1)'`;
    assert.equal((await actions.execute('run_command', { command, purpose: 'implementation', checkIds: [] })).isError, true);
    assert.equal(budget.beginAction('after-debug-failure'), 0);
    approve = false;
    assert.equal((await actions.execute('run_command', { command, purpose: 'verification', checkIds: ['tests'] })).errorCode, 'PERMISSION_DENIED');
    assert.equal(budget.beginAction('after-denial'), 0);
    approve = true;
    const failed = await actions.execute('run_command', { command, purpose: 'verification', checkIds: ['tests'] });
    assert.equal(failed.structuredContent?.exit_code, 1); assert.equal(failed.structuredContent?.exit_signal, null);
    assert.equal(events.filter(isFailedVerificationCheck).length, 1);
    assert.equal(budget.beginAction('actual-repair'), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('initial operations do not consume repairs and three repairs are allowed after observed failures', () => {
  const budget = new RepairBudget();
  assert.equal(budget.beginAction('initial-file'), 0);
  assert.equal(budget.beginAction('initial-check'), 0);
  for (let repair = 1; repair <= 3; repair++) {
    budget.failedCheck();
    assert.equal(budget.beginAction(`repair-${repair}`), repair);
    assert.equal(budget.beginAction(`verify-${repair}`), repair);
  }
  budget.failedCheck();
  assert.throws(() => budget.beginAction('fourth-repair'), /Repair limit reached after three repair attempts/);
});

test('multiple failures before the next action form one repair attempt rather than burning the whole limit', () => {
  const budget = new RepairBudget();
  budget.beginAction('initial');
  budget.failedCheck(); budget.failedCheck(); budget.failedCheck(); budget.failedCheck();
  assert.equal(budget.beginAction('repair-batch'), 1);
  assert.equal(budget.beginAction('independent-followup'), 1);
});

test('duplicate action updates cannot consume a second repair or erase a pending observed failure', () => {
  const budget = new RepairBudget();
  budget.beginAction('initial');
  budget.failedCheck();
  assert.equal(budget.beginAction('initial'), 0);
  assert.equal(budget.beginAction('repair'), 1);
  budget.failedCheck();
  assert.equal(budget.beginAction('repair'), 1);
  assert.equal(budget.beginAction('next-repair'), 2);
  assert.equal(budget.beginAction('next-repair'), 2);
});
