import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { collectLocalModelReport, EvidenceReader, generateLocalModelReport, groupRuns, normalizeRun, renderLocalModelReport, reportedSlowEligibility } from '../../../scripts/generate-local-model-report.ts';

const runId = '11111111-1111-4111-8111-111111111111', otherId = '22222222-2222-4222-8222-222222222222';
const signature = JSON.stringify({ contextTokens: 16384, cacheTypeK: 'q8_0', nativePlacement: { cpuBlockIndices: [0, 1] } });
function failedRun(id = runId, budget = 900000) {
  return { runId: id, modelId: 'qwen3.8:27b-q3-k-m', label: 'cancelled exact LF', startedAt: '2026-10-14T14:00:00Z', completedAt: '2026-10-14T14:10:00Z',
    executionLimitMs: budget, ownedProcessesStopped: true, controller: 'desktop controller', model: { profileSignature: signature, digest: 'a'.repeat(64) },
    summary: { completedCases: 1, passedCases: 0, falseVerified: 1, replayCount: 0, qualified: false, fullQualificationRun: false },
    tasks: [{ taskId: otherId, fixtureId: 'exact-lf', phase: 'ordinary', status: 'cancelled', verification: 'passed', completedAt: '2026-10-14T14:10:00Z',
      activeDurationMs: 600000, falseVerified: true, passed: false, independentChecks: [{ id: 'required-readback', passed: false }], modelProfile: { profileSignature: signature } }],
    cases: [{ fixtureId: 'exact-lf', repeat: 1, completedAt: '2026-10-14T14:10:00Z', passed: false, falseVerified: true, tasks: [otherId], independentChecks: [{ id: 'required-readback', passed: false }] }] };
}
async function directory(t: TestContext) { const base = await realpath(await mkdtemp(path.join(tmpdir(), 'local-model-report-test-'))); t.after(() => rm(base, { recursive: true, force: true })); return base; }
async function saveRun(base: string, data: ReturnType<typeof failedRun>) { const root = path.join(base, 'runs', data.runId); await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'report.json'), JSON.stringify(data)); await writeFile(path.join(root, 'events.jsonl'), ''); return root; }

test('report keeps cancelled exact-LF raw false verification and does not convert finalized records into completed tasks', () => {
  const run = normalizeRun(failedRun(), '/tmp/report.json');
  assert.equal(run.counts.recordedCases, 1); assert.equal(run.counts.completedTasks, 0); assert.equal(run.counts.independentlyPassedCases, 0);
  assert.equal(run.counts.rawFalseVerified, 1); assert.equal(run.tasks[0].verification, 'passed');
  assert.match(run.tasks[0].cancellationException!, /required readback/);
  const expectedCancel = normalizeRun({ ...failedRun(), tasks: [{ ...failedRun().tasks[0], phase: 'cancel' }] }, '/tmp/report.json');
  assert.match(expectedCancel.tasks[0].cancellationException!, /Expected denial\/cancellation/);
});

test('an incorrect completed-status claim, failed cleanup or failed profile binding never counts as successful completion', () => {
  const original = failedRun(), task = { ...original.tasks[0], status: 'completed', passed: true, falseVerified: false,
    profileBindingVerified: true, cleanup: [{ status: 'fulfilled' }], independentChecks: [{ id: 'independent-behavior', passed: true }] };
  const normalized = (change: Record<string, unknown>) => normalizeRun({ ...original, tasks: [{ ...task, ...change }] }, '/tmp/report.json');
  assert.equal(normalized({}).counts.completedTasks, 1);
  for (const change of [{ passed: false }, { independentChecks: [{ id: 'independent-behavior', passed: false }] },
    { independentChecks: [] }, { cleanup: [{ status: 'rejected' }] }, { cleanup: [] }, { profileBindingVerified: false }]) {
    const run = normalized(change); assert.equal(run.counts.completedTasks, 0); assert.equal(run.counts.rawCompletedStatusTasks, 1);
  }
});

test('report cohorts separate exact signatures, unknown signatures, budgets and controller identity without pooled scores', () => {
  const first = normalizeRun(failedRun(), '/tmp/first.json'), longer = normalizeRun(failedRun(otherId, 3600000), '/tmp/longer.json');
  const changed = normalizeRun({ ...failedRun(otherId), model: { profileSignature: signature + ' ' } }, '/tmp/changed.json');
  const unavailableA = normalizeRun({ ...failedRun(), model: {} }, '/tmp/unknown-a.json'), unavailableB = normalizeRun({ ...failedRun(otherId), model: {} }, '/tmp/unknown-b.json');
  const groups = groupRuns([first, longer, changed, unavailableA, unavailableB]);
  assert.equal(groups.length, 5); assert(groups.every(group => group.pooledQualificationScore === null));
  const merged = groupRuns([first, { ...first, runId: otherId }]); assert.equal(merged.length, 1); assert.equal(merged[0].rawFalseVerified, 2);
});

test('runtime event profiles preserve historical failed-start signatures without claiming prepared readiness', () => {
  const event = { kind: 'runtime', at: '2026-10-14T14:00:02Z', value: { profileSignature: signature, profile: { contextTokens: 16384 }, nativeMemoryPlan: { workingBytes: 1234 } } };
  const run = normalizeRun({ ...failedRun(), model: {} }, '/tmp/report.json', [event,
    { kind: 'runtime-log', value: 'CODING_RESOURCE_FAILURE {"pressure":"warning","availableMemoryBytes":456}' }]);
  assert.equal(run.profileSignature, signature); assert.match(run.profileEvidence, /readiness not established/);
  assert.equal(run.memoryFailures[0].pressure, 'warning'); assert.equal(run.observedProfiles.length, 1);
});

test('slow-system protocol preserves only recorded validator results and separates exact source/resource bindings from diagnostics', () => {
  const binding = { schemaVersion: 1, source: { 'host.ts': { sha256: 'a'.repeat(64), sizeBytes: 12 } }, resources: { engine: { sha256: 'b'.repeat(64), sizeBytes: 23 } }, machine: { cpuModel: 'fixture' } };
  const protocol = { id: 'local-coding-slow-system-v1', caseBudgetMs: 3600000, oracleVersion: 3, fixtureSetDigest: 'c'.repeat(64), binding };
  const slow = normalizeRun({ ...failedRun(), executionLimitMs: 3600000, budgetProfile: 'slow-system-reliability', protocol, slowFullRequested: true, qualificationAllowed: false }, '/tmp/slow.json');
  assert.equal(slow.slowReliability, null); assert(slow.sourceResourceBindingDigest); assert.equal(reportedSlowEligibility(slow), false);
  const diagnostic = normalizeRun({ ...failedRun(otherId, 3600000), budgetProfile: 'desktop-task' }, '/tmp/diagnostic.json');
  const changed = normalizeRun({ ...failedRun(otherId, 3600000), budgetProfile: 'slow-system-reliability', protocol: { ...protocol, binding: { ...binding, resources: { engine: { sha256: 'd'.repeat(64), sizeBytes: 23 } } } } }, '/tmp/changed.json');
  assert.equal(groupRuns([slow, diagnostic, changed]).length, 3);
  const injected = normalizeRun({ ...failedRun(), budgetProfile: 'desktop-task', protocol, slowReliability: { protocolId: protocol.id, eligibleForSlowUse: true, completeRun: true, criteriaPassed: true, referenceMatched: true } }, '/tmp/injected.json');
  assert.equal(injected.slowReliability!.eligibleForSlowUse, true); assert.equal(reportedSlowEligibility(injected), false);
});

test('bounded evidence reader omits symlinks, oversized and incomplete JSON and ignores unterminated active log lines', async t => {
  const base = await directory(t), outside = await directory(t), reader = new EvidenceReader(base);
  const external = path.join(outside, 'outside.json'); await writeFile(external, '{"outside":true}'); await symlink(external, path.join(base, 'linked.json'));
  assert.equal(await reader.json(path.join(base, 'linked.json')), undefined); assert.equal(await reader.json(external), undefined);
  await writeFile(path.join(base, 'oversized.txt'), 'x'.repeat(100)); assert.equal(await reader.read(path.join(base, 'oversized.txt'), 10), undefined);
  await writeFile(path.join(base, 'partial.json'), '{"active":'); assert.equal(await reader.json(path.join(base, 'partial.json')), undefined);
  await writeFile(path.join(base, 'active.jsonl'), '{"completed":17}\n{"status":"success');
  assert.deepEqual(await reader.lines(path.join(base, 'active.jsonl')), [{ completed: 17 }]);
  assert(reader.warnings.some(warning => warning.includes('Unterminated')));
});

test('offline report keeps full baseline separate, records actual receipts and escapes untrusted HTML and URL content', async t => {
  const base = await directory(t), original = { ...failedRun(), modelId: 'qwen3.5:4b', label: 'original baseline', sourceSnapshot: '/preserved/baseline',
    summary: { ...failedRun().summary, completedCases: 36, passedCases: 12, falseVerified: 0, fullQualificationRun: true },
    cases: Array.from({ length: 36 }, (_, index) => ({ ...failedRun().cases[0], fixtureId: `case-${index}`, passed: index < 12, falseVerified: false, independentChecks: [{ id: 'independent-behavior', passed: index < 12 }] })) };
  const originalRoot = await saveRun(base, original), originalPath = path.join(originalRoot, 'report.json');
  await writeFile(path.join(base, 'baseline-revalidated.json'), JSON.stringify({ ...original, originalReportPath: originalPath,
    originalReportSHA: createHash('sha256').update(await readFile(originalPath)).digest('hex'), oracleRevalidation: { monotonic: true, savedWorkspacesUnchanged: true } }));
  const requestedRun = { ...failedRun(otherId), label: '<script>alert("bad")</script>' }, root = await saveRun(base, requestedRun);
  const logs = path.join(root, 'profile/actions', runId, 'command-logs'); await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, otherId + '.json'), JSON.stringify({ id: otherId, command: 'node check.mjs', purpose: 'verification', checkIds: ['test'], state: 'failed', exitCode: 1 }));
  await writeFile(path.join(base, 'research-large-models.json'), JSON.stringify({ benchmarks: [{ model: 'untrusted <img>', scores: { test: 99 }, source: 'javascript:alert(1)' }] }));
  const report = await collectLocalModelReport(base, '2026-10-14T18:00:00Z');
  assert.equal(report.counts.terminalRequestedModelAttempts, 1); assert.equal(report.counts.completedTasks, 0); assert.equal(report.pooledRequestedModelQualificationScore, null);
  assert.equal(report.baseline!.rawSummary.passedCases, 12); assert.equal(report.baseline!.originalDigestMatches, true); assert.equal(report.runs[0].receipts[0].exitCode, 1);
  const html = renderLocalModelReport(report);
  assert(!html.includes('<script')); assert(!html.includes('href="javascript:')); assert(html.includes('&lt;script&gt;')); assert(html.includes('Content-Security-Policy'));
  assert.match(html, /No pilot attempts are pooled/); assert.match(html, /12 \/ 36/); assert.match(html, /required readback/);
  const result = await generateLocalModelReport(base); assert.equal(result.counts.completedTasks, 0);
  assert((await readFile(result.html, 'utf8')).startsWith('<!doctype html>')); assert.equal(JSON.parse(await readFile(result.json, 'utf8')).pooledRequestedModelQualificationScore, null);
});

test('active incomplete reports and bare qualified flags cannot create measured full qualification', async t => {
  const base = await directory(t), root = await saveRun(base, { ...failedRun(), qualified: true, fullRequested: true } as ReturnType<typeof failedRun>);
  const other = path.join(base, 'runs', otherId); await mkdir(other, { recursive: true }); await writeFile(path.join(other, 'report.json'), '{"runId":');
  const report = await collectLocalModelReport(base); assert.equal(report.counts.reportedQualifiedRuns, 0); assert.equal(report.unavailableRuns.length, 1);
  assert.equal(report.counts.independentlyPassedCases, 0); assert.equal(report.largeModel.completeArtifactSetRecorded, false);
  const before = await readFile(path.join(root, 'report.json')); await generateLocalModelReport(base); assert.deepEqual(await readFile(path.join(root, 'report.json')), before);
});


test('active empty snapshots show no result yet without inventing a stopped task', async t => {
  const base = await directory(t), active = { ...failedRun(), label: 'active empty snapshot', ownedProcessesStopped: false,
    summary: { ...failedRun().summary, completedCases: 0, falseVerified: 0 }, tasks: [], cases: [] };
  delete (active as Partial<typeof active>).completedAt;
  await saveRun(base, active);
  const report = await collectLocalModelReport(base), run = report.runs[0], html = renderLocalModelReport(report);
  assert.equal(run.terminal, false); assert.equal(run.ownedProcessesStopped, false);
  assert.equal(report.counts.activeRequestedModelSnapshots, 1); assert.equal(report.counts.terminalRequestedModelAttempts, 0);
  assert.equal(report.counts.completedTasks, 0); assert.equal(report.counts.reportedQualifiedRuns, 0);
  assert.match(html, /active snapshot; no task result recorded yet/);
  assert.doesNotMatch(html, /stopped before task/);
});

test('a finalized blocked repair stays visible while its run has a later active CLI phase', async t => {
  const base = await directory(t), original = failedRun();
  const active = { ...original, modelId: 'muse-glimmer:30b-q3-k-m', label: 'mixed active Muse', ownedProcessesStopped: false,
    summary: { ...original.summary, falseVerified: 0 },
    tasks: [{ ...original.tasks[0], fixtureId: 'test-repair', status: 'blocked', verification: 'unverified', falseVerified: false,
      error: 'Command denied <before execution>', profileBindingVerified: true, cleanup: [{ status: 'fulfilled' }],
      independentChecks: [{ id: 'independent-behavior', passed: false }] }],
    cases: [{ ...original.cases[0], fixtureId: 'test-repair', falseVerified: false,
      independentChecks: [{ id: 'independent-behavior', passed: false }] }] };
  delete (active as Partial<typeof active>).completedAt;
  const runRoot = await saveRun(base, active);
  await writeFile(path.join(runRoot, 'events.jsonl'), JSON.stringify({ at: '2026-10-14T14:12:00Z', kind: 'stage',
    value: { taskId: '33333333-3333-4333-8333-333333333333', stage: 'Implement' } }) + '\n');
  const report = await collectLocalModelReport(base), run = report.runs[0];
  const retained = JSON.stringify({ tasks: run.tasks, cases: run.cases, counts: report.counts });
  const html = renderLocalModelReport(report);
  assert.equal(run.terminal, false); assert.equal(run.tasks[0].status, 'blocked'); assert.equal(run.tasks[0].verification, 'unverified');
  assert.equal(run.cases[0].passed, false); assert.equal(run.counts.finalizedCases, 1);
  assert.equal(report.counts.terminalRequestedModelAttempts, 0); assert.equal(report.counts.activeRequestedModelSnapshots, 1);
  assert.equal(report.counts.completedTasks, 0); assert.equal(report.counts.cleanStops, 0);
  assert.equal(report.counts.rawFalseVerified, 0); assert.equal(report.counts.rawReplayCount, 0); assert.equal(report.counts.reportedQualifiedRuns, 0);
  assert.match(html, /active snapshot; recorded task results: blocked; run not finalized/);
  assert.match(html, /<strong>blocked<\/strong>; plan checks unverified/);
  assert.match(html, /FAIL independent-behavior/); assert.match(html, /Command denied &lt;before execution&gt;/);
  assert.doesNotMatch(html, /stopped before task/);
  assert.equal(JSON.stringify({ tasks: run.tasks, cases: run.cases, counts: report.counts }), retained);
});

test('terminal rows retain failures and distinguish a missing task record from an inferred stop', async t => {
  const base = await directory(t), failed = { ...failedRun(), error: 'Retained terminal error <literal>' };
  const empty = { ...failedRun(otherId), label: 'terminal with no task result', tasks: [], cases: [],
    summary: { ...failedRun().summary, completedCases: 0, falseVerified: 0 } };
  await saveRun(base, failed); await saveRun(base, empty);
  const report = await collectLocalModelReport(base), before = JSON.stringify({ counts: report.counts, cohorts: report.cohorts });
  const html = renderLocalModelReport(report);
  assert.equal(report.counts.terminalRequestedModelAttempts, 2); assert.equal(report.counts.activeRequestedModelSnapshots, 0);
  assert.equal(report.counts.completedTasks, 0); assert.equal(report.counts.rawFalseVerified, 1); assert.equal(report.counts.cleanStops, 2);
  assert.equal(report.counts.reportedQualifiedRuns, 0); assert.equal(report.pooledRequestedModelQualificationScore, null);
  assert.match(html, /terminal; cancelled/); assert.match(html, /terminal; no task result recorded/);
  assert.match(html, /Retained terminal error &lt;literal&gt;/); assert.match(html, /required readback/);
  assert.doesNotMatch(html, /stopped before task/);
  assert.equal(JSON.stringify({ counts: report.counts, cohorts: report.cohorts }), before);
});


test('four-hour selected SSD diagnostics remain separate from one-hour runs and cannot report slow eligibility', () => {
  const oneHour = normalizeRun({ ...failedRun(), modelId: 'qwen3-coder-next:80b', executionLimitMs: 3600000,
    budgetProfile: 'desktop-task', qualificationAllowed: false }, '/tmp/one-hour.json');
  const fourHours = normalizeRun({ ...failedRun(otherId), modelId: 'qwen3-coder-next:80b', executionLimitMs: 14400000,
    budgetProfile: 'ssd-selected-4h-v1', qualificationAllowed: false, diagnosticOnly: true, fullRequested: false,
    protocol: { id: 'ssd-selected-4h-v1', caseBudgetMs: 14400000, oracleVersion: 2, binding: { source: { host: 'fixture' } } },
    slowFullRequested: true, slowReliability: { protocolId: 'local-coding-slow-system-v1', eligibleForSlowUse: true,
      completeRun: true, criteriaPassed: true, referenceMatched: true } }, '/tmp/four-hour.json');
  assert.equal(groupRuns([oneHour, fourHours]).length, 2);
  assert.equal(fourHours.protocolId, 'ssd-selected-4h-v1'); assert.equal(fourHours.executionLimitMs, 14400000);
  assert.equal(fourHours.counts.completedTasks, 0); assert.equal(reportedSlowEligibility(fourHours), false);
  assert(groupRuns([oneHour, fourHours]).every(group => group.pooledQualificationScore === null));
});
