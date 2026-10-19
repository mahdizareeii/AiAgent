import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalActions, type ActionPermission } from '../actions.ts';
import { parseTaskBrief, TaskVerificationLedger, type TaskCriterion } from '../task-verification.ts';
import { COMMAND_EVIDENCE_SCOPE, commandEvidencePresentation, commandEvidenceTitle, finalizationEvidence, hostCodingClosing } from '../task-outcome.ts';
import type { TaskCheck } from '../renderer/types.ts';

async function fixture(options: { manual?: boolean; fail?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'command-evidence-scope-')));
  const workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  await writeFile(path.join(workspace, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(workspace, 'source.mjs'), `export const transform = _input => ${JSON.stringify(options.fail ? 'wrong' : 'ok')};\n`);
  const checkText = "import assert from 'node:assert/strict';\nimport {transform} from './source.mjs';\nassert.equal(transform('sample'),'ok');\n";
  await writeFile(path.join(workspace, 'check.mjs'), checkText);
  const command = `"${process.execPath}" check.mjs`;
  const request = `Implement all requested input handling. Keep check.mjs unchanged and run exactly \`${command}\`.${options.manual ? ' A human must review the design.' : ''}`;
  const description = 'Handles every input and throws for invalid inputs';
  const brief = parseTaskBrief({ goal: request, deliverables: ['source.mjs'], criteria: [
    { id: 'first-check', description, kind: 'command', command, cwd: '.', paths: ['source.mjs', 'check.mjs', 'package.json'] },
    { id: 'second-check', description: 'Handles all edge cases', kind: 'command', command, cwd: '.', paths: ['source.mjs', 'check.mjs', 'package.json'] },
    ...(options.manual ? [{ id: 'human-review', description: 'Human review of design quality', kind: 'manual' }] : []),
  ] }, request);
  const ledger = new TaskVerificationLedger(brief, workspace); await ledger.captureProtectedInputs(request);
  const originalBrief = structuredClone(brief), controller = new AbortController(), permissions: ActionPermission[] = [];
  const commands = [...brief.criteria].filter((criterion): criterion is Extract<TaskCriterion, { kind: 'command' }> => criterion.kind === 'command').map(({ id, kind, command, cwd }) => ({ id, kind, command, cwd }));
  const actions = new LocalActions({ projectPath: workspace, historyDirectory: path.join(directory, 'history'), verificationCheckIds: ledger.verificationCheckIds,
    frozenVerification: { turnId: 'current-turn', requestHash: brief.requestHash, workspacePath: workspace, signal: controller.signal, commands },
    onPermission: async permission => { permissions.push(permission); return true; },
    onBeforeVerificationCommand: (id, args, signal) => ledger.beforeVerificationCommand(id, args, signal),
    onTool: event => ledger.recordHostAction(event),
  });
  return { actions, ledger, brief, originalBrief, permissions, command, workspace, checkText,
    cleanup: async () => { controller.abort(); await rm(directory, { recursive: true, force: true }); } };
}

test('real command receipts prove execution only while frozen requirements, identities and approvals stay unchanged', async () => {
  const f = await fixture();
  try {
    for (const id of ['first-check', 'second-check']) {
      const result = await f.actions.execute('run_verification', { check_id: id });
      assert.equal(result.structuredContent?.operation, 'run_command'); assert.equal(result.structuredContent?.exit_code, 0);
      assert.equal(result.structuredContent?.purpose, 'verification'); assert.deepEqual(result.structuredContent?.check_ids, [id]);
    }
    const checks = await f.ledger.evaluate();
    for (const id of ['first-check', 'second-check']) {
      const check = checks.find(check => check.checkIds.includes(id))!;
      assert.equal(check.status, 'passed'); assert.equal(check.title, commandEvidenceTitle('passed'));
      assert.equal(check.evidence?.operation, 'verify_command'); assert.equal(check.evidence?.complete, true);
      assert(check.detail.startsWith(COMMAND_EVIDENCE_SCOPE));
      assert.match(check.detail, /Planned requirement \(from the model; coverage unverified\):/);
      assert(check.detail.includes(f.brief.criteria.find(criterion => criterion.id === id)!.description));
    }
    assert.equal(f.permissions.length, 2);
    assert(f.permissions.every(permission => permission.command === f.command && permission.cwd === f.workspace));
    assert.deepEqual(f.brief, f.originalBrief); assert.equal(f.ledger.canFinish(checks), true, 'Only the frozen mechanical checks are satisfied.');
    assert.equal(await readFile(path.join(f.workspace, 'check.mjs'), 'utf8'), f.checkText);
    assert.equal(checks.find(check => check.evidence?.operation === 'verify_preserved_file')!.status, 'passed');
  } finally { await f.cleanup(); }
});

test('successful command checks never satisfy or remove a genuine manual criterion', async () => {
  const f = await fixture({ manual: true });
  try {
    for (const id of ['first-check', 'second-check']) await f.actions.execute('run_verification', { check_id: id });
    const checks = await f.ledger.evaluate(), manual = checks.find(check => check.checkIds.includes('human-review'))!;
    assert.equal(manual.status, 'unverified'); assert.equal(manual.title, 'Human review of design quality');
    assert.equal(manual.detail, 'This semantic requirement needs review; mechanical task completion is unverified.');
    assert.equal(f.ledger.canFinish(checks), false); assert.deepEqual(f.brief, f.originalBrief);
  } finally { await f.cleanup(); }
});

test('failed or unrun commands retain their verdicts and never acquire a success title', async () => {
  const f = await fixture({ fail: true });
  try {
    const result = await f.actions.execute('run_verification', { check_id: 'first-check' });
    assert.equal(result.isError, true); assert.equal(result.structuredContent?.exit_code, 1);
    const checks = await f.ledger.evaluate(), failed = checks.find(check => check.checkIds.includes('first-check'))!, unrun = checks.find(check => check.checkIds.includes('second-check'))!;
    assert.equal(failed.status, 'failed'); assert.equal(unrun.status, 'unverified');
    assert.equal(failed.title, commandEvidenceTitle('failed')); assert.equal(unrun.title, commandEvidenceTitle('unverified'));
    assert.doesNotMatch(failed.title + unrun.title, /Approved command passed/); assert.equal(f.ledger.canFinish(checks), false);
    assert.deepEqual(f.brief, f.originalBrief); assert.equal(f.permissions.length, 1);
  } finally { await f.cleanup(); }
});

test('historical command display scopes model descriptions without changing saved verdicts or non-command rows', () => {
  for (const status of ['passed', 'failed', 'unverified'] as const) {
    const historical: TaskCheck = { id: 'acceptance:old', title: 'All input cases and TypeError are correct', status, purpose: 'acceptance', checkIds: ['old'],
      detail: 'Retained command evidence.', evidence: { operation: 'verify_command', actionId: 'old-action', commandSha256: 'a'.repeat(64) } };
    const original = structuredClone(historical), view = commandEvidencePresentation(historical);
    assert.equal(view.title, commandEvidenceTitle(status)); assert(view.detail.startsWith(COMMAND_EVIDENCE_SCOPE));
    assert(view.detail.includes(`Planned requirement (from the model; coverage unverified): ${historical.title}`));
    assert.deepEqual(historical, original); assert.doesNotMatch(view.title, /All input|TypeError/);
  }
  const file: TaskCheck = { id: 'file', title: 'Exact required bytes', status: 'passed', detail: 'Host bytes matched.', evidence: { operation: 'verify_exact_file' } };
  assert.deepEqual(commandEvidencePresentation(file), { title: file.title, detail: file.detail });
});

test('bounded final feedback uses the same command scope and preserves statuses, IDs and receipt evidence', () => {
  const command: TaskCheck = { id: 'acceptance:command', title: 'All possible behavior is correct', status: 'passed', purpose: 'acceptance', checkIds: ['command'],
    detail: 'Recorded old detail. '.repeat(100), evidence: { operation: 'verify_command', actionId: 'receipt', commandSha256: 'a'.repeat(64) } };
  const manual: TaskCheck = { id: 'acceptance:manual', title: 'Human review', status: 'unverified', purpose: 'acceptance', checkIds: ['manual'], detail: 'Requires human review.' };
  const checks = [command, manual], original = structuredClone(checks), feedback = JSON.parse(finalizationEvidence(checks, []));
  assert.equal(feedback.checks[0].title, commandEvidenceTitle('passed'));
  assert(feedback.checks[0].detail.startsWith(COMMAND_EVIDENCE_SCOPE)); assert(feedback.checks[0].detail.length <= 400);
  assert(feedback.checks[0].detail.includes(`Planned requirement (from the model; coverage unverified): ${command.title}`));
  assert.equal(feedback.checks[0].status, command.status); assert.deepEqual(feedback.checks[0].checkIds, command.checkIds);
  assert.deepEqual(feedback.checks[0].evidence, command.evidence); assert.deepEqual(feedback.checks[1], manual); assert.deepEqual(checks, original);
});

test('host closing distinguishes command scope while preserving unresolved manual checks and outcome counts', () => {
  const checks: TaskCheck[] = [
    { id: 'command', title: 'Broad planned behavior', status: 'passed', purpose: 'acceptance', checkIds: ['command'], detail: 'exit zero', evidence: { operation: 'verify_command' } },
    { id: 'manual', title: 'Human review', status: 'unverified', purpose: 'acceptance', checkIds: ['manual'], detail: 'Needs review.' },
  ];
  const original = structuredClone(checks), closing = hostCodingClosing({ status: 'incomplete', checks, planPrepared: true });
  assert.match(closing, /^Task remains incomplete\./); assert(closing.includes(COMMAND_EVIDENCE_SCOPE));
  assert.match(closing, /Acceptance checks: 1 passed, 0 failed, 1 unverified/); assert.match(closing, /Unresolved acceptance IDs: "manual"/);
  assert.doesNotMatch(closing, /Broad planned behavior|all requirements passed/i); assert.deepEqual(checks, original);
});
