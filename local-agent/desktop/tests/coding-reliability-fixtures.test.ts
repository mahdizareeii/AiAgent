import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { codingFixtures, fixtureDigest, fixtureEvidenceChecks, fixturePermissionAllowed, fixtureReplayCheck, qualificationSummary, runIndependentVerifier, seedFixture } from '../../../scripts/coding-reliability-fixtures.ts';
import { closeUpdatedCodingTask, drainUpdatedCodingTask, evaluateUpdatedCodingTask, harnessModelSource, recordHarnessTaskProfile, parseHarnessOptions, startHarnessRuntime, loopbackOnlyFetch, CASE_BUDGET_MS, DESKTOP_TASK_BUDGET_MS, harnessBudget, harnessSummary, validateBaselineReport } from '../../../scripts/validate-local-coding.ts';
import { applyOracleRevalidation } from '../../../scripts/revalidate-coding-baseline.ts';
import { MODEL_CATALOG, modelArtifacts } from '../../runtime/catalog.ts';
import { isQualificationEligible } from '../../runtime/generation.ts';
import { LocalActions, type ActionToolEvent } from '../actions.ts';
import { createActionHost } from '../action-host.ts';
import { TaskClock } from '../task-clock.ts';
import { parseTaskBrief, TaskVerificationLedger } from '../task-verification.ts';
import { checkFromHostAction } from '../task-outcome.ts';

test('twelve fixed fixture definitions include immutable verifiers and required boundaries', () => {
  const fixtures = codingFixtures(process.execPath); assert.equal(fixtures.length, 12); assert.equal(new Set(fixtures.map(item => item.id)).size, 12);
  assert.deepEqual(fixtures.filter(item => item.mandatory).map(item => item.id), ['exact-lf', 'unicode-crlf', 'no-op', 'denial-cancel']);
  assert.ok(fixtures.find(item => item.id === 'long-context')!.files['requirements.txt'].length > 100_000);
  for (const fixture of fixtures) { assert.match(fixtureDigest(fixture), /^[a-f0-9]{64}$/); for (const file of fixture.protectedFiles) assert.equal(typeof fixture.files[file], 'string'); }
});

test('debug selections never qualify and full qualification preserves 31/36 plus mandatory cases and no false verification', () => {
  const fixtures = codingFixtures(process.execPath), results = fixtures.flatMap(fixture => [1, 2, 3].map(() => ({ fixtureId: fixture.id, passed: true, falseVerified: false })));
  assert.equal(qualificationSummary(fixtures, 3, results).qualified, true);
  for (const result of results.filter(item => ['cli-inputs', 'csv-transform'].includes(item.fixtureId)).slice(0, 5)) result.passed = false;
  assert.equal(qualificationSummary(fixtures, 3, results).qualified, true);
  results.find(item => item.fixtureId === 'exact-lf')!.passed = false; assert.equal(qualificationSummary(fixtures, 3, results).qualified, false);
  results.forEach(item => item.passed = true); results[20].falseVerified = true; assert.equal(qualificationSummary(fixtures, 3, results).qualified, false);
  assert.equal(qualificationSummary(fixtures.slice(0, 1), 3, results.slice(0, 3)).qualified, false);
  assert.equal(qualificationSummary(fixtures, 1, fixtures.map(item => ({ fixtureId: item.id, passed: true }))).qualified, false);
});

test('harness parses explicit pinned local sources, rejects malformed repetitions and cannot fetch a public URL', async () => {
  const options = parseHarnessOptions(['--model', 'qwen3.5:4b', '--source-dir', '.cache/models', '--cases', 'exact-lf,no-op', '--repeat', '1']);
  assert.equal(options.repeat, 1); assert.deepEqual(options.cases, ['exact-lf', 'no-op']); assert.equal(CASE_BUDGET_MS, 900_000);
  assert.equal(options.memoryMode, 'automatic');
  assert.throws(() => parseHarnessOptions(['--model', 'x']), /missing value|required/);
  assert.throws(() => parseHarnessOptions(['--model', 'x', '--source-dir', 'x', '--repeat', '0']), /repeat/);
  assert.throws(() => parseHarnessOptions(['--model', 'x', '--source-dir', 'x', '--cases', 'no-op,no-op']), /unique/);
  await assert.rejects(loopbackOnlyFetch('https://example.org/'), /loopback/); await assert.rejects(loopbackOnlyFetch('http://192.0.2.1/'), /loopback/);
});

test('one-hour desktop diagnostics cannot alter a baseline or qualify even with all passing oracle results', () => {
  const base = ['--model', 'qwen3.8:27b-q3-k-m', '--source-dir', '.cache/models'];
  const normal = harnessBudget(parseHarnessOptions(base));
  assert.equal(normal.limitMs, CASE_BUDGET_MS); assert.equal(normal.qualificationAllowed, true);
  const diagnostic = harnessBudget(parseHarnessOptions([...base, '--budget-profile', 'desktop-task', '--cases', 'exact-lf,cli-inputs', '--repeat', '1']));
  assert.equal(diagnostic.limitMs, DESKTOP_TASK_BUDGET_MS); assert.equal(diagnostic.qualificationAllowed, false);
  const fixtures = codingFixtures(process.execPath), passed = fixtures.flatMap(fixture => [1, 2, 3].map(() => ({ fixtureId: fixture.id, passed: true, falseVerified: false })));
  assert.equal(harnessSummary(normal, fixtures, 3, passed).qualified, true);
  assert.equal(harnessSummary(diagnostic, fixtures, 3, passed).qualified, false);
  assert.equal(harnessSummary(diagnostic, fixtures, 3, passed).passedCases, 36);
  for (const extra of [[], ['--cases', 'exact-lf'], ['--cases', 'exact-lf', '--repeat', '2'], ['--cases', 'exact-lf', '--repeat', '1', '--source-snapshot', '.cache/baseline-src']]) {
    assert.throws(() => parseHarnessOptions([...base, '--budget-profile', 'desktop-task', ...extra]), /Desktop diagnostics/);
  }
  assert.throws(() => harnessBudget({ budgetProfile: 'desktop-task', repeat: 1 }), /explicit/);
  assert.throws(() => parseHarnessOptions([...base, '--budget-profile', 'unlimited']), /budget-profile/);
});

test('harness memory-mode selection is explicit and cannot change the preserved source baseline', async () => {
  const base = ['--model', 'qwen3.8:27b', '--source-dir', '.cache/models'];
  assert.equal(parseHarnessOptions([...base, '--memory-mode', 'low-memory']).memoryMode, 'low-memory');
  assert.equal(parseHarnessOptions([...base, '--memory-mode', 'automatic']).memoryMode, 'automatic');
  for (const extra of [['--memory-mode', 'ssd-experts'], ['--memory-mode'], ['--memory-mode', 'automatic', '--memory-mode', 'low-memory']]) {
    assert.throws(() => parseHarnessOptions([...base, ...extra]), /memory-mode|missing value|Duplicate/);
  }
  assert.throws(() => parseHarnessOptions([...base, '--source-snapshot', '.cache/baseline-src', '--memory-mode', 'low-memory']), /baseline comparisons require automatic/);
  const calls: string[] = [], signal = new AbortController().signal;
  const runtime = { setMemoryMode: async (mode: string) => { calls.push(`mode:${mode}`); }, start: async (options: { signal?: AbortSignal }) => {
    assert.equal(options.signal, signal); calls.push('start');
  } };
  await startHarnessRuntime(runtime, { memoryMode: 'low-memory' }, signal); assert.deepEqual(calls, ['mode:low-memory', 'start']);
  calls.length = 0;
  await startHarnessRuntime(runtime, {}, signal); assert.deepEqual(calls, ['mode:automatic', 'start']);
  calls.length = 0;
  await startHarnessRuntime(runtime, { sourceSnapshot: '/preserved/baseline', memoryMode: 'automatic' }, signal); assert.deepEqual(calls, ['start']);
  calls.length = 0;
  await assert.rejects(startHarnessRuntime(runtime, { sourceSnapshot: '/preserved/baseline', memoryMode: 'low-memory' }, signal), /baseline comparisons require automatic/);
  assert.deepEqual(calls, [], 'Invalid comparison options cannot configure or start any runtime.');
});

test('updated harness uses deterministic failed coding closing and cannot upgrade an answerless task', () => {
  const acceptance: any = { id: 'acceptance:tests', title: 'Real tests', purpose: 'acceptance', checkIds: ['tests'], status: 'failed', detail: 'Exit 1' };
  const task: any = { answer: 'The program printed PASS.', stopReason: 'end_turn', error: null, taskBrief: {}, acceptanceChecks: [acceptance], checks: [acceptance] };
  let saved = '';
  closeUpdatedCodingTask(task, { aborted: false, timedOut: false, recordClosing: text => { saved = text; } });
  assert.equal(task.status, 'incomplete'); assert.equal(task.verification, 'failed'); assert.equal(task.closingSource, 'host');
  assert.match(saved, /Acceptance checks: 0 passed, 1 failed, 0 unverified/); assert.match(task.answer, /Task remains incomplete/);
  const passed: any = { ...acceptance, status: 'passed' }, empty: any = { answer: '', stopReason: 'end_turn', error: null, taskBrief: {}, acceptanceChecks: [passed], checks: [passed] };
  closeUpdatedCodingTask(empty, { aborted: false, timedOut: false });
  assert.equal(empty.status, 'incomplete'); assert.match(empty.answer, /Task remains incomplete/);
  const stopped: any = { answer: '', stopReason: 'end_turn', error: 'denied', acceptanceChecks: [], checks: [] };
  closeUpdatedCodingTask(stopped, { aborted: true, timedOut: false }); assert.equal(stopped.status, 'cancelled'); assert.match(stopped.answer, /Task stopped/);
});

test('updated final evaluator rejection clears a prior passed snapshot and blocks completion while retaining action receipts', async () => {
  const acceptance: any = { id: 'acceptance:tests', title: 'Tests', purpose: 'acceptance', checkIds: ['tests'], status: 'passed', detail: 'Earlier exit zero' };
  const operation: any = { id: 'action:actual-write', title: 'Wrote result', purpose: 'operation', status: 'passed', detail: 'Actual write receipt' };
  const task: any = { answer: 'Done.', stopReason: 'end_turn', error: null, taskBrief: {}, verification: 'passed', acceptanceChecks: [acceptance], checks: [operation, acceptance] };
  let evaluations = 0;
  await evaluateUpdatedCodingTask(task, { evaluate: async () => { evaluations++; throw new Error('Final dependency snapshot unavailable'); } });
  assert.equal(evaluations, 1); assert.deepEqual(task.acceptanceChecks, []); assert.deepEqual(task.checks, [operation]);
  assert.equal(task.verification, 'unverified'); assert.match(task.error, /Task verification could not finish: Final dependency snapshot unavailable/);
  assert.equal(task.verificationError, task.error);
  closeUpdatedCodingTask(task, { aborted: false, timedOut: false });
  assert.equal(task.status, 'blocked'); assert.equal(task.verification, 'unverified'); assert.match(task.answer, /requested result is unverified/);
  const retained = JSON.parse(JSON.stringify(task)); assert.equal(retained.status, 'blocked'); assert.deepEqual(retained.acceptanceChecks, []);
  assert.equal(retained.checks[0].id, operation.id); assert.match(retained.error, /Final dependency snapshot unavailable/);
  const alreadyBlocked: any = { ...task, error: 'Earlier backend failure', checks: [operation, acceptance], acceptanceChecks: [acceptance] };
  await evaluateUpdatedCodingTask(alreadyBlocked, { evaluate: async () => { throw new Error('Independent final failure'); } });
  assert.equal(alreadyBlocked.error, 'Earlier backend failure'); assert.match(alreadyBlocked.verificationError, /Independent final failure/);
});

test('updated harness drains a real accepted mutation receipt before final checks and keeps the original cancellation state', async () => {
  for (const cancelled of [false, true]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'coding-final-receipt-')), project = await realpath(directory);
    const clock = new TaskClock(60_000); clock.start();
    const controller = new AbortController(), cancellation = new AbortController();
    const signal = AbortSignal.any([controller.signal, cancellation.signal, clock.signal]);
    const request = 'Write exact done LF bytes to result.txt.';
    const ledger = new TaskVerificationLedger(parseTaskBrief({ goal: request, deliverables: ['result.txt'], criteria: [
      { id: 'exact', description: 'Exact final bytes', kind: 'exact_file', path: 'result.txt', content: 'done\n' },
    ] }, request), project);
    const events: ActionToolEvent[] = [], checks = new Map<string, NonNullable<ReturnType<typeof checkFromHostAction>>>();
    const record = (event: ActionToolEvent) => { events.push(event); ledger.recordHostAction(event); const check = checkFromHostAction(event); if (check) checks.set(check.id, check); };
    let terminal: ActionToolEvent | undefined, approvals = 0, executions = 0;
    let releaseReceipt!: () => void, committed!: () => void;
    const receiptReady = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const mutationCommitted = new Promise<void>(resolve => { committed = resolve; });
    class DelayedReceiptActions extends LocalActions {
      override async execute(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
        executions++; const result = await super.execute(tool, args, options);
        assert.equal(result.isError, undefined); committed();
        // The actual approved atomic write has finished. Delay only publishing its receipt/response.
        await receiptReady; assert(terminal); record(terminal); return result;
      }
    }
    const actions = new DelayedReceiptActions({ projectPath: project, historyDirectory: path.join(project, 'history'),
      onPermission: async () => { approvals++; return true; },
      onTool: event => { if (event.status === 'completed' || event.status === 'failed') terminal = event; else record(event); } });
    const host = await createActionHost(actions, signal);
    const response = fetch(host.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', args: { path: 'result.txt', content: 'done\n' } }) }).then(value => value.text()).catch(() => 'response closed after drain');
    try {
      await mutationCommitted;
      assert.equal(await readFile(path.join(project, 'result.txt'), 'utf8'), 'done\n');
      assert.equal(checks.size, 0, 'No terminal receipt has been published yet.');
      const reason = new Error('User cancelled after the accepted mutation committed.');
      if (cancelled) cancellation.abort(reason);
      let drained = false;
      const cleanup = drainUpdatedCodingTask({ signal, clock, controller, cancelApprovals: () => {}, host,
        backend: { stop: async () => {} }, gateway: { close: async () => {} } }).then(value => { drained = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(drained, false, 'Finalization must wait for the late accepted receipt.');
      assert.equal(signal.aborted, true, 'Cleanup closes admission even for a successful task.');
      const rejected = await fetch(host.url, { method: 'POST', body: JSON.stringify({ tool: 'write_file', args: { path: 'result.txt', content: 'replayed' } }) });
      assert.equal(rejected.status, 403, 'No request may replay while the accepted action drains.');
      releaseReceipt(); const termination = await cleanup; await response;
      assert.equal(termination.aborted, cancelled); assert.equal(termination.timedOut, false);
      assert.equal(termination.abortReason, cancelled ? reason : undefined);
      assert(termination.cleanup.every(entry => entry.status === 'fulfilled'));
      const acceptance = await ledger.evaluate(), task: any = { answer: 'Wrote result.txt.', stopReason: 'end_turn', error: null,
        taskBrief: ledger.brief, acceptanceChecks: acceptance, checks: [...checks.values(), ...acceptance] };
      closeUpdatedCodingTask(task, termination);
      assert.equal(task.status, cancelled ? 'cancelled' : 'completed'); assert.equal(task.verification, 'passed');
      assert.equal(checks.size, 1); assert.equal([...checks.values()][0].status, 'passed');
      assert.equal(events.filter(event => event.status === 'completed').length, 1); assert.equal(executions, 1); assert.equal(approvals, 1);
      assert.equal(await readFile(path.join(project, 'result.txt'), 'utf8'), 'done\n');
      clock.resume(); assert.equal(clock.signal.aborted, false, 'The next safety phase retains its shared active budget.');
    } finally {
      releaseReceipt(); controller.abort(); clock.close(); await host.drain(); host.server.closeAllConnections(); host.server.close();
      await response; await rm(project, { recursive: true, force: true });
    }
  }
});

test('updated qualification records final native profile evidence and stops its case loop on profile drift', () => {
  const expected = { model: 'owned', sourceModel: 'qwen3.8:27b', digest: 'b'.repeat(64), templateHash: 'c'.repeat(64), engineIdentity: 'verified-engine',
    contextTokens: 16384, outputTokens: 4096, profileSignature: 'f16-cache' };
  const report: any = { profileStable: true }, task: any = { taskId: 'first' };
  const actual = { ...expected, profileSignature: 'q8-cache', nativeMemoryPlan: { profileSignature: 'q8-cache', workingBytes: 18 * 1024 ** 3 },
    calibrationMeasurements: { sampledAt: '2026-10-14T00:00:00Z', residentBytes: 100, availableMemoryBytes: 9 * 1024 ** 3, pressure: 'normal' },
    apiKey: 'private-token', baseUrl: 'http://127.0.0.1:secret' };
  const cases = ['first', 'must-not-start']; let started = 0;
  for (const _case of cases) { started++; if (!recordHarnessTaskProfile(report, task, actual as any, expected)) break; }
  assert.equal(started, 1); assert.equal(report.profileStable, false); assert.equal(report.profileDrift.kind, 'profile');
  assert.match(report.stoppedReason, /cannot qualify one stable profile.*further fixture cases were stopped/);
  assert.equal(task.profileBindingVerified, true); assert.equal(task.modelProfile.profileSignature, 'q8-cache');
  assert.deepEqual(task.modelProfile.nativeMemoryPlan, actual.nativeMemoryPlan); assert.deepEqual(task.modelProfile.calibrationMeasurements, actual.calibrationMeasurements);
  assert.equal('apiKey' in task.modelProfile, false); assert.equal('baseUrl' in task.modelProfile, false);
  actual.nativeMemoryPlan.workingBytes = 0; assert.equal(task.modelProfile.nativeMemoryPlan.workingBytes, 18 * 1024 ** 3, 'Saved evidence is an independent snapshot.');
  const stableReport: any = { profileStable: true }, stable: any = {};
  assert.equal(recordHarnessTaskProfile(stableReport, stable, expected, expected), true);
  assert.equal(stableReport.profileStable, true); assert.equal(stableReport.profileDrift, undefined); assert.equal(stable.profileBindingVerified, true);
  for (const key of ['model', 'sourceModel', 'digest', 'templateHash', 'engineIdentity'] as const) {
    const changedReport: any = { profileStable: true }, changed: any = {};
    assert.equal(recordHarnessTaskProfile(changedReport, changed, { ...expected, [key]: 'wrong' }, expected), false);
    assert.equal(changed.profileBindingVerified, false); assert.equal(changedReport.profileDrift.kind, 'identity');
    assert.match(changed.error, new RegExp(key)); assert.equal(changedReport.error, changed.error);
  }
  const noSignature: any = { profileStable: true };
  assert.equal(recordHarnessTaskProfile(noSignature, {}, { ...expected, profileSignature: undefined }, expected), false, 'Missing current profile evidence cannot qualify.');
});

test('explicit Q3 variants report their actual source and require fresh exact binding rather than Q4 proof', () => {
  for (const id of ['qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m']) {
    const spec = MODEL_CATALOG.find(item => item.id === id)!; assert(spec);
    assert.equal(parseHarnessOptions(['--model', id, '--source-dir', '.cache/models', '--cases', 'exact-lf', '--repeat', '1']).model, id);
    assert.equal(isQualificationEligible(id), true); assert.equal(isQualificationEligible(id + '-unapproved'), false);
    const source = harnessModelSource(spec); assert.equal(source.quantization, 'Q3_K_M'); assert.equal(source.repository, spec.repository);
    assert.equal(source.revision, spec.revision); assert.equal(source.filename, spec.filename); assert.equal(source.sourceUrl, spec.sourceUrl);
    const q4 = MODEL_CATALOG.find(item => item.id === id.replace('-q3-k-m', ''))!;
    const expected = { model: 'owned', sourceModel: id, digest: spec.sha256, templateHash: 'c'.repeat(64), engineIdentity: 'verified-engine', contextTokens: 16384, outputTokens: 4096, profileSignature: `${id}-profile` };
    const report: any = { profileStable: true };
    assert.equal(recordHarnessTaskProfile(report, {}, { ...expected, sourceModel: q4.id, digest: q4.sha256 }, expected), false);
    assert.equal(report.profileStable, false); assert.match(report.error, /sourceModel, digest/);
  }
  assert.equal(isQualificationEligible('qwen3.5:4b'), false, 'The baseline remains a comparator, not an eligible promotion.');
});

test('promotion baseline rejects synthetic, partial, mismatched fixture or repeated/cherry-picked evidence', () => {
  const fixtures = codingFixtures(process.execPath), model = MODEL_CATALOG.find(item => item.id === 'qwen3.5:4b')!, tasks: any[] = [];
  const cases = fixtures.flatMap(fixture => [1, 2, 3].map(repeat => {
    const ids = (fixture.safety ? ['deny', 'cancel'] : ['ordinary']).map(phase => `${fixture.id}-${repeat}-${phase}`);
    tasks.push(...ids.map((taskId, index) => ({ taskId, fixtureId: fixture.id, iteration: repeat, phase: fixture.safety ? ['deny', 'cancel'][index] : 'ordinary', completedAt: '2026-10-14T00:00:00Z', cleanup: [{ status: 'fulfilled' }, { status: 'fulfilled' }, { status: 'fulfilled' }], passed: true, independentChecks: [{ id: 'behavior', passed: true }] })));
    return { fixtureId: fixture.id, repeat, fixtureDigest: fixtureDigest(fixture), tasks: ids, passed: true };
  }));
  const report = { schemaVersion: 1, modelId: model.id, syntheticProvider: false, fullRequested: true, expectedCases: 36, ownedProcessesStopped: true,
    completedAt: '2026-10-14T00:00:00Z', sourceSnapshot: '/preserved/source', controller: 'preserved 4B loop with current shared safety host', sourceArtifacts: modelArtifacts(model).map(item => ({ sha256: item.sha256, sourceUnchanged: true })),
    cases, tasks, fixtureDigests: Object.fromEntries(fixtures.map(item => [item.id, fixtureDigest(item)])) };
  const original = { requireRevalidation: false };
  assert.equal(validateBaselineReport(report, fixtures, original).passFraction, 1);
  assert.throws(() => validateBaselineReport(report, fixtures), /revalidation/);
  assert.throws(() => validateBaselineReport({ ...report, syntheticProvider: true }, fixtures, original));
  assert.throws(() => validateBaselineReport({ ...report, cases: cases.slice(0, 35) }, fixtures, original), /partial/);
  assert.throws(() => validateBaselineReport({ ...report, fixtureDigests: {} }, fixtures, original), /differs/);
  const duplicate = structuredClone(report); duplicate.cases[0].repeat = 2; assert.throws(() => validateBaselineReport(duplicate, fixtures, original), /repeats/);
  const weakened = structuredClone(report); weakened.tasks[0].independentChecks = []; assert.throws(() => validateBaselineReport(weakened, fixtures, original), /independent/);
  assert.throws(() => validateBaselineReport({ ...report, completedAt: undefined }, fixtures, original), /terminal/);
});

test('explicit verification commands require host receipts in the requested order after the last mutation', () => {
  const fixture = codingFixtures(process.execPath).find(item => item.id === 'react-build')!;
  const command = (command: string, exit = 0): any => ({ id: command, title: 'Run command', status: 'completed', input: { command }, output: { structuredContent: { operation: 'run_command', ok: true, exit_code: exit, exit_signal: null } } });
  const edit: any = { id: 'edit', title: 'Edit file', status: 'completed', output: { structuredContent: { ok: true, changed: true } } };
  const passes = (events: any[]) => fixtureEvidenceChecks(fixture, { answer: 'PASS', permissions: [], events }).every(check => check.passed);
  const [build, check] = fixture.allowedCommands;
  assert.equal(passes([edit, command(build), command(check)]), true);
  assert.equal(passes([]), false, 'Prose PASS cannot replace an actual receipt.');
  assert.equal(passes([command(check), command(build)]), false);
  assert.equal(passes([command(build), command(check), edit]), false);
  assert.equal(passes([edit, command(build), command(check, 1)]), false);
  const forged = command(check); delete forged.output.structuredContent.operation; assert.equal(passes([command(build), forged]), false);
});

test('repair observation requires a real failing executable receipt rather than a validation error', () => {
  const fixture = codingFixtures(process.execPath).find(item => item.id === 'test-repair')!;
  const command = (code: number): any => ({ id: 'command-' + code, title: 'Run command', status: code === 0 ? 'completed' : 'failed', input: { command: fixture.allowedCommands[0] }, output: { structuredContent: { operation: 'run_command', ok: code === 0, exit_code: code, exit_signal: null } } });
  const edit: any = { id: 'edit', title: 'Edit file', status: 'completed', output: { structuredContent: { ok: true, changed: true } } };
  const observed = (events: any[]) => fixtureEvidenceChecks(fixture, { answer: '', permissions: [], events }).find(check => check.id === 'observed-test-repair')!.passed;
  assert.equal(observed([command(1), edit, command(0)]), true);
  assert.equal(observed([command(1), command(0)]), false);
  const invalid: any = { id: 'invalid', title: 'Run command', status: 'failed', input: { command: fixture.allowedCommands[0] }, output: { errorCode: 'INVALID_ARGUMENT' } };
  assert.equal(observed([invalid, edit, command(0)]), false);
  assert.equal(observed([edit, command(1), command(0)]), false);
});

test('oracle revalidation is monotonic, recomputes false verification and preserves immutable original evidence', () => {
  const fixture = codingFixtures(process.execPath)[0], original: any = { fixtureDigests: { [fixture.id]: fixtureDigest(fixture) }, summary: { passedCases: 1 },
    tasks: [true, false].map((passed, index) => ({ taskId: 'task-' + index, fixtureId: fixture.id, iteration: index + 1, phase: 'ordinary', passed, status: 'completed', verification: 'passed', events: [], independentChecks: [{ id: 'old', passed }], falseVerified: false })),
    cases: [true, false].map((passed, index) => ({ fixtureId: fixture.id, repeat: index + 1, fixtureDigest: fixtureDigest(fixture), tasks: ['task-' + index], passed })) };
  const saved = structuredClone(original);
  const result = applyOracleRevalidation(original, [fixture], { 'task-0': [{ id: 'stronger', passed: false, detail: 'Missing LF' }], 'task-1': [{ id: 'stronger', passed: true, detail: 'Fixed artifact is still an original failed run' }] }, { originalReportPath: '/original.json', originalReportSHA: 'a'.repeat(64), completedAt: '2026-10-14T00:00:00Z' });
  assert.deepEqual(original, saved); assert.deepEqual(result.tasks.map((task: any) => task.passed), [false, false]);
  assert.deepEqual(result.cases.map((item: any) => item.passed), [false, false]); assert.equal(result.tasks[0].status, 'incomplete');
  assert.equal(result.tasks[0].falseVerified, true); assert.equal(result.cases[0].falseVerified, true); assert.equal(result.tasks[1].falseVerified, false);
  assert.equal(result.summary.passedCases, 0); assert.deepEqual(result.originalFixtureDigests, saved.fixtureDigests);
});

test('oracle versioning changes only the strengthened React fixture definition', () => {
  const prior = codingFixtures(process.execPath, '/usr/bin/python3', path.resolve('.'), 1), current = codingFixtures(process.execPath, '/usr/bin/python3', path.resolve('.'), 2);
  assert.deepEqual(current.filter((fixture, index) => fixtureDigest(fixture) !== fixtureDigest(prior[index])).map(fixture => fixture.id), ['react-build']);
});

test('fixture approval allowlist accepts only exact reviewed checks and never changed immutable scaffolding', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-permission-'))), fixture = codingFixtures(process.execPath).find(item => item.id === 'cli-inputs')!, workspace = path.join(directory, 'workspace');
  try {
    const hashes = await seedFixture(fixture, workspace);
    const request = { requestId: 'fixture', title: 'Run command', command: fixture.allowedCommands[0], cwd: workspace, arguments: { timeout_ms: 60000 } };
    assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, request), true);
    for (const command of ['curl https://example.org', 'rm -rf .', fixture.allowedCommands[0] + '; echo extra']) assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, { ...request, command }), false);
    assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, { ...request, cwd: directory }), false);
    assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, { requestId: 'file', title: 'Write', arguments: { path: '../escape', content: 'x' } }), false);
    assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, { requestId: 'file', title: 'Write', arguments: { path: 'check.mjs', content: 'console.log("PASS")' } }), false);
    await writeFile(path.join(workspace, 'check.mjs'), 'console.log("PASS")'); assert.equal(await fixturePermissionAllowed(fixture, workspace, hashes, request), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('replay evidence rejects repeated successful implementation commands but permits explicit verification or changed-input reruns', () => {
  const command = (id: string, purpose?: string, status: 'completed' | 'failed' = 'completed') => ({ id, title: 'Run command', status, input: { command: 'node check.mjs', ...(purpose ? { purpose } : {}) },
    output: { content: [], structuredContent: { ok: status === 'completed', operation: 'run_command', exit_code: status === 'completed' ? 0 : 1, ...(purpose ? { purpose } : {}) } } });
  assert.equal(fixtureReplayCheck([command('one'), command('two')]).replayCount, 1);
  assert.equal(fixtureReplayCheck([command('one'), command('one')]).replayCount, 0, 'Duplicate event delivery is not a second execution.');
  assert.equal(fixtureReplayCheck([command('one', 'verification'), command('two', 'verification')]).replayCount, 0);
  assert.equal(fixtureReplayCheck([command('one'), { id: 'edit', title: 'Edit file', status: 'completed', output: { content: [], structuredContent: { ok: true, changed: true } } }, command('two')]).replayCount, 0);
  assert.equal(fixtureReplayCheck([command('one', undefined, 'failed'), command('two')]).replayCount, 0);
});

test('independent exact LF and CRLF verifiers validate real bytes, rejecting wrong/newline-less outputs', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-verifiers-'))), fixtures = codingFixtures(process.execPath);
  try {
    const lf = fixtures[0], workspace = path.join(directory, 'lf'); await seedFixture(lf, workspace); await writeFile(path.join(workspace, 'note.txt'), 'Local agents finish tasks.\n');
    assert.equal((await runIndependentVerifier(lf, workspace, path.join(directory, 'lf-check'), process.execPath)).every(item => item.passed), true);
    await writeFile(path.join(workspace, 'note.txt'), 'Local agents finish tasks.'); assert.equal((await runIndependentVerifier(lf, workspace, path.join(directory, 'lf-bad'), process.execPath)).every(item => item.passed), false);
    const crlf = fixtures[1], second = path.join(directory, 'crlf'); await seedFixture(crlf, second); await writeFile(path.join(second, 'unicode.txt'), '\uFEFFعنوان: سلام 🌍\r\nStatus: verified.\r\n');
    assert.equal((await runIndependentVerifier(crlf, second, path.join(directory, 'crlf-check'), process.execPath)).every(item => item.passed), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent CLI verifier rejects visible PASS output and weakened check scripts', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-cli-'))), fixture = codingFixtures(process.execPath).find(item => item.id === 'cli-inputs')!, workspace = path.join(directory, 'workspace');
  try {
    await seedFixture(fixture, workspace); await writeFile(path.join(workspace, 'stats.mjs'), 'console.log("PASS");\n');
    assert.equal((await runIndependentVerifier(fixture, workspace, path.join(directory, 'bad-output'), process.execPath)).every(item => item.passed), false);
    await writeFile(path.join(workspace, 'stats.mjs'), 'try{const values=JSON.parse(process.argv[2]);if(!Array.isArray(values)||values.some(v=>typeof v!=="number"||!Number.isFinite(v)))throw Error();const sum=values.reduce((a,b)=>a+b,0);console.log(JSON.stringify({count:values.length,sum,mean:values.length?sum/values.length:null}));}catch{console.error(JSON.stringify({error:"INVALID_INPUT"}));process.exitCode=2;}\n');
    assert.equal((await runIndependentVerifier(fixture, workspace, path.join(directory, 'good-output'), process.execPath)).every(item => item.passed), true);
    await writeFile(path.join(workspace, 'check.mjs'), 'console.log("PASS")'); const checks = await runIndependentVerifier(fixture, workspace, path.join(directory, 'changed-test'), process.execPath);
    assert.equal(checks.some(item => item.id === 'immutable:check.mjs' && !item.passed), true); assert.equal(checks.some(item => item.id === 'independent-behavior'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent TypeScript and React checks build from installed dependencies without package downloads', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-builds-'))), fixtures = codingFixtures(process.execPath);
  try {
    const ts = fixtures.find(item => item.id === 'ts-multifile')!, workspace = path.join(directory, 'typescript'); await seedFixture(ts, workspace);
    await writeFile(path.join(workspace, 'parse.ts'), 'export function parseNumber(text:string):number { if(!text.trim()||!Number.isFinite(Number(text)))throw new TypeError("Invalid");return Number(text); }\n');
    await writeFile(path.join(workspace, 'index.ts'), 'import {parseNumber} from "./parse";export function sumNumbers(values:string[]):number { return values.reduce((sum,value)=>sum+parseNumber(value),0); }\n');
    assert.equal((await runIndependentVerifier(ts, workspace, path.join(directory, 'ts-hidden'), process.execPath)).every(item => item.passed), true);
    const react = fixtures.find(item => item.id === 'react-build')!, second = path.join(directory, 'react'); await seedFixture(react, second);
    await writeFile(path.join(second, 'Summary.tsx'), 'import React from "react";export function Summary({values}:{values:number[]}) {return <main><h1>Sample Stats</h1><p data-total>Total: {values.reduce((a,b)=>a+b,0)}</p><ul>{values.map((value,i)=><li key={i}>{value}</li>)}</ul></main>}\n');
    const results = await runIndependentVerifier(react, second, path.join(directory, 'react-hidden'), process.execPath);
    assert.equal(results.every(item => item.passed), true, JSON.stringify(results));
    assert.equal(await readFile(path.join(second, 'package.json'), 'utf8'), react.files['package.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('React oracle rejects wrong list values, reordered values and an incorrectly attributed total', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-react-counterexamples-'))), fixture = codingFixtures(process.execPath).find(item => item.id === 'react-build')!, workspace = path.join(directory, 'workspace');
  try {
    await seedFixture(fixture, workspace);
    const variants = [
      '<p data-total>Total: {sum}</p><ul>{values.map((v,i)=><li key={i}>wrong</li>)}</ul>',
      '<p data-total>Total: {sum}</p><ul>{[...values].reverse().map((v,i)=><li key={i}>{v}</li>)}</ul>',
      '<p>Total: {sum}</p><ul>{values.map((v,i)=><li key={i}>{v}</li>)}</ul>',
      '<p data-total>Wrong total</p><aside>Total: {sum}</aside><ul>{values.map((v,i)=><li key={i}>{v}</li>)}</ul>',
    ];
    for (const [index, body] of variants.entries()) {
      await writeFile(path.join(workspace, 'Summary.tsx'), 'import React from "react";export function Summary({values}:{values:number[]}){const sum=values.reduce((a,b)=>a+b,0);return <main><h1>Sample Stats</h1>' + body + '</main>}\n');
      const checks = await runIndependentVerifier(fixture, workspace, path.join(directory, 'hidden-' + index), process.execPath);
      assert.equal(checks.every(check => check.passed), false, 'Counterexample ' + index);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('remaining behavioral oracles accept independent correct solutions, including CSV quoting and invalid-input repair', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fixture-gold-oracles-'))), fixtures = codingFixtures(process.execPath);
  const solutions: Record<string, Record<string, string>> = {
    'python-bug': { 'pricing.py': 'def discounted_price(price, percent):\n    if price < 0 or percent < 0 or percent > 100:\n        raise ValueError("Invalid")\n    return price * (1 - percent / 100)\n' },
    'csv-transform': { 'transform.mjs': String.raw`import fs from 'node:fs';const text=fs.readFileSync(process.argv[2],'utf8');let rows=[],row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===','){row.push(field);field='';}else if(!quoted&&(c==='\r'||c==='\n')){row.push(field);rows.push(row);row=[];field='';if(c==='\r'&&text[i+1]==='\n')i++;}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}rows.shift();const output=rows.map(([name,score])=>({name,score:Number(score)})).sort((a,b)=>b.score-a.score||(a.name<b.name?-1:a.name>b.name?1:0));fs.writeFileSync(process.argv[3],JSON.stringify(output));` },
    'test-repair': { 'sum.mjs': 'export function sumEven(values){if(!Array.isArray(values)||values.some(v=>!Number.isInteger(v)))throw new TypeError("Invalid");return values.filter(v=>v%2===0).reduce((a,b)=>a+b,0);}\n' },
    'long-context': { 'config.json': '{"release":"LOCAL-ORCHID-73","retryLimit":7,"featureEnabled":true}\n' },
    'missing-prerequisite': { 'src/main.mjs': 'export function greet(name){return "Hello, "+name+"!";}\n', 'README.md': 'Run with Node. Optional coding-fixture-tool-that-is-not-installed is unavailable and was not installed.\n' },
  };
  try {
    for (const [id, files] of Object.entries(solutions)) {
      const fixture = fixtures.find(item => item.id === id)!, workspace = path.join(directory, id); await seedFixture(fixture, workspace);
      for (const [relative, source] of Object.entries(files)) { await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true }); await writeFile(path.join(workspace, relative), source); }
      const results = await runIndependentVerifier(fixture, workspace, path.join(directory, id + '-hidden'), process.execPath);
      assert.equal(results.every(item => item.passed), true, JSON.stringify({ id, results }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
