import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODEL_CATALOG, modelArtifacts } from '../../runtime/catalog.ts';
import { ENGINE_COMMIT } from '../../runtime/index.ts';
import { bytesDigest, codingFixtures, fixtureDigest, fixtureEvidenceChecks } from '../../../scripts/coding-reliability-fixtures.ts';
import { captureSlowBenchmarkBinding, harnessBudget, parseHarnessOptions, slowProtocolRecord, slowReliabilityResult,
  validateSlowRunReport, validateSlowReferenceReport, slowReadbackEvidence, type SlowBenchmarkBinding } from '../../../scripts/validate-local-coding.ts';
import { parseQualificationOptions, runCodingQualification } from '../../../scripts/run-local-coding-qualification.ts';

// Small source-format records for validator/orchestration tests. They never load
// weights, infer, execute fixture commands or certify real model performance.
const sourceFiles = ['scripts/validate-local-coding.ts', 'scripts/coding-reliability-fixtures.ts', 'scripts/run-local-coding-qualification.ts',
  'local-agent/desktop/coding-task.ts', 'local-agent/desktop/task-verification.ts', 'local-agent/desktop/actions.ts', 'local-agent/desktop/approvals.ts',
  'local-agent/desktop/inference-gateway.ts', 'local-agent/desktop/transcript.ts', 'local-agent/desktop/backend.ts', 'local-agent/runtime/index.ts',
  'local-agent/runtime/memory.ts', 'local-agent/runtime/generation.ts', 'package.json', 'package-lock.json'];
const resourceFiles = ['engine/manifest.json', 'engine/metal/llama-server', 'goose', 'bridge', 'node', 'python', 'skills/coding.md', 'research/worker'];
const binding: SlowBenchmarkBinding = { schemaVersion: 1,
  source: Object.fromEntries(sourceFiles.map(file => [file, { sha256: 'a'.repeat(64), sizeBytes: 1 }])),
  resources: Object.fromEntries(resourceFiles.map(file => [file, { sha256: 'b'.repeat(64), sizeBytes: 1 }])),
  machine: { platform: 'darwin', architecture: 'arm64', cpuModel: 'Fixture', cpuCores: 4, totalMemoryBytes: 24 * 1024 ** 3, osRelease: '25.6.0', nodeVersion: process.version } };
const fixtures = codingFixtures(process.execPath);
function evidenceReport(modelId = 'qwen3.5:4b', passing = false): any {
  const spec = MODEL_CATALOG.find(model => model.id === modelId)!, templateHash = 'c'.repeat(64), engineIdentity = 'd'.repeat(64);
  const descriptor = { engineCommit: ENGINE_COMMIT, contextTokens: 8192, outputTokens: 2048, slots: 1 };
  const plan = modelId.endsWith('-q3-k-m') ? { noAlloc: true, model: modelId, modelDigest: spec.sha256, templateDigest: templateHash, engineDigest: engineIdentity, profileSignature: JSON.stringify(descriptor) } : null;
  const profileSignature = JSON.stringify({ ...descriptor, ...(plan ? { memoryPlanDigest: bytesDigest(JSON.stringify(plan)) } : {}) });
  const modelProfile = { sourceModel: modelId, digest: spec.sha256, templateHash, engineIdentity, profileSignature, contextTokens: 8192, outputTokens: 2048 };
  const runId = randomUUID(), tasks: any[] = [], cases = fixtures.flatMap(fixture => [1, 2, 3].map(iteration => {
    const phases = fixture.safety ? ['deny', 'cancel'] : ['ordinary'], taskIds: string[] = [];
    for (const phase of phases) {
      const taskId = randomUUID(), events: any[] = [];
      const command = (text: string, exitCode: number) => events.push({ id: `command-${events.length}`, title: 'Run command', status: exitCode ? 'failed' : 'completed', input: { command: text, purpose: 'verification' }, output: { structuredContent: { operation: 'run_command', ok: exitCode === 0, exit_code: exitCode, exit_signal: null, purpose: 'verification' } } });
      if (passing && !fixture.safety) {
        if (fixture.id === 'test-repair') { command(fixture.allowedCommands[0], 1); events.push({ id: 'write', title: 'Write file', status: 'completed', output: { structuredContent: { changed: true } } }); }
        for (const text of fixture.allowedCommands) command(text, fixture.expectedBlocker ? 127 : 0);
      }
      const task: any = { taskId, workspace: `/fixture/runs/${runId}/${fixture.id}-${iteration}-${phase}`, activeDurationMs: 0, generationCounts: { preparation: 1, execution: 3, finalization: 0 }, transcriptIncomplete: false, fixtureId: fixture.id, iteration, phase, completedAt: '2026-10-14T00:00:00Z', cleanup: Array.from({ length: 3 }, () => ({ status: 'fulfilled' })),
        modelProfile, profileBindingVerified: true, events, answer: fixture.expectedBlocker ? 'The prerequisite executable is unavailable.' : 'Completed.',
        status: passing && !fixture.safety && !fixture.expectedBlocker ? 'completed' : 'blocked', stopReason: 'end_turn', verification: passing && !fixture.safety && !fixture.expectedBlocker ? 'passed' : 'unverified',
        continuations: 0, permissions: fixture.safety && passing ? [{ decision: phase === 'deny' ? 'denied' : 'cancelled', request: {} }] : [], ...(phase === 'cancel' ? { lateApproval: { status: 'expired' } } : {}),
        falseVerified: false, replayCount: 0, passed: passing, independentChecks: [{ id: 'independent-behavior', passed: passing },
          ...fixture.protectedFiles.map(file => ({ id: `immutable:${file}`, passed: passing, sha256: bytesDigest(fixture.files[file]) })),
          ...(passing ? fixtureEvidenceChecks(fixture, { events, answer: 'The prerequisite executable is unavailable.', permissions: [] }) : []),
          ...(fixture.safety ? [{ id: `approval-${phase}`, passed: passing }] : [])] };
      task.tools = []; task.toolsTruncated = false;
      const readbacks: Record<string, { file: string; text: string }> = { 'exact-lf': { file: 'note.txt', text: 'Local agents finish tasks.\n' }, 'unicode-crlf': { file: 'unicode.txt', text: '\uFEFFعنوان: سلام 🌍\r\nStatus: verified.\r\n' }, 'no-op': { file: 'ready.txt', text: 'Already correct.\n' } };
      const readback = readbacks[fixture.id];
      if (passing && readback) {
        if (fixture.id !== 'no-op') { task.events.push({ id: 'file-write', title: 'Write file', status: 'completed', output: { structuredContent: { changed: true } } }); task.tools.push({ id: 'write', title: 'reviewed actions: write file', status: 'completed', output: { changed: true, action_id: 'file-write' } }); }
        const size = Buffer.byteLength(readback.text);
        task.tools.push({ id: 'read', title: 'local files and research: read file', status: 'completed', input: { path: readback.file }, output: { ok: true, path: path.join(task.workspace, readback.file), text: readback.text, sha256: bytesDigest(readback.text), size, start_byte: 0, end_byte: size, encoding: 'utf-8', eof: true, truncated: false, next_cursor: null } });
      }
      const supplement = slowReadbackEvidence(fixture, task); if (supplement) task.independentChecks.push(supplement);
      tasks.push(task); taskIds.push(taskId);
    }
    return { activeDurationMs: 0, fixtureId: fixture.id, repeat: iteration, fixtureDigest: fixtureDigest(fixture), tasks: taskIds, completedAt: '2026-10-14T00:00:00Z', passed: passing, falseVerified: false, replayCount: 0 };
  }));
  return { schemaVersion: 1, runId, modelId, syntheticProvider: false, sourceSnapshot: null, controller: 'desktop prepareCodingTask/runVerifiedCodingTask',
    budgetProfile: 'slow-system-reliability', executionLimitMs: 3600000, qualificationAllowed: false, slowFullRequested: true, fullRequested: false, expectedCases: 36, qualified: false,
    inferenceLoopbackEnforced: true, webResearchEnabled: false, commandNetworkPolicy: 'macOS local-only; IPv4/IPv6 loopback only',
    protocol: { ...slowProtocolRecord(binding, fixtures), bindingUnchanged: true }, profileStable: true, ownedProcessesStopped: true, completedAt: '2026-10-14T00:00:00Z',
    model: { id: modelId, ...modelProfile, nativeMemoryPlan: plan, calibrationMeasurements: { pressure: 'normal' } }, hardwareBeforeLoad: binding.machine,
    sourceArtifacts: modelArtifacts(spec).map(artifact => ({ filename: artifact.filename, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, sourceUnchanged: true })),
    fixtureDigests: Object.fromEntries(fixtures.map(fixture => [fixture.id, fixtureDigest(fixture)])), tasks, cases, passed: passing };
}

test('slow full-run selection remains distinct from default qualification and selected desktop diagnostics', () => {
  const base = ['--model', 'qwen3.8:27b-q3-k-m', '--source-dir', '.cache/models'];
  assert.equal(harnessBudget(parseHarnessOptions(base)).limitMs, 900000);
  const slow = harnessBudget(parseHarnessOptions([...base, '--budget-profile', 'slow-system-reliability']));
  assert.equal(slow.limitMs, 3600000); assert.equal(slow.qualificationAllowed, false); assert.equal(slow.slowReliabilityAllowed, true);
  for (const extra of [['--cases', 'exact-lf'], ['--repeat', '1'], ['--source-snapshot', '.cache/baseline']]) assert.throws(() => parseHarnessOptions([...base, '--budget-profile', 'slow-system-reliability', ...extra]), /Slow reliability/);
  const diagnostic = parseHarnessOptions([...base, '--budget-profile', 'desktop-task', '--cases', 'exact-lf', '--repeat', '1']); assert.equal(harnessBudget(diagnostic).slowReliabilityAllowed, false);
});

test('fresh slow reference admits real failures but rejects cross-budget, cross-source and partial evidence', () => {
  const original = evidenceReport(); assert.equal(validateSlowReferenceReport(original, fixtures, binding).passFraction, 0);
  for (const change of [{ budgetProfile: 'desktop-task' }, { executionLimitMs: 900000 }, { sourceSnapshot: '/old/snapshot' }, { fullRequested: true }, { qualified: true },
    { cases: original.cases.slice(0, 35) }, { tasks: original.tasks.slice(0, 38) }, { profileStable: false }, { ownedProcessesStopped: false }, { baseline: {} }]) assert.throws(() => validateSlowReferenceReport({ ...original, ...change }, fixtures, binding));
  for (const field of ['source', 'resources']) { const altered = structuredClone(original); altered.protocol.binding[field][Object.keys(altered.protocol.binding[field])[0]].sha256 = 'e'.repeat(64); assert.throws(() => validateSlowReferenceReport(altered, fixtures, binding), /differ/); }
  const duplicate = structuredClone(original); duplicate.cases[0].repeat = 2; assert.throws(() => validateSlowReferenceReport(duplicate, fixtures, binding), /repeats/);
  const drift = structuredClone(original); drift.tasks[0].modelProfile.profileSignature = 'wrong'; assert.throws(() => validateSlowReferenceReport(drift, fixtures, binding), /profile/);
});

test('slow eligibility recomputes complete evidence and never grants legacy qualification', () => {
  const candidate = evidenceReport('qwen3.8:27b-q3-k-m', true), reference = { passFraction: 0, unchanged: true };
  const result = slowReliabilityResult(candidate, fixtures, binding, reference); assert.equal(result.eligibleForSlowUse, true); assert.equal(result.legacyQualified, false); assert.equal(result.summary!.qualified, false);
  assert.equal(slowReliabilityResult(candidate, fixtures, binding).eligibleForSlowUse, false);
  assert.equal(slowReliabilityResult(candidate, fixtures, binding, { passFraction: 0.81, unchanged: true }).eligibleForSlowUse, false);
  assert.equal(slowReliabilityResult(candidate, fixtures, binding, { passFraction: 0, unchanged: false }).eligibleForSlowUse, false);
  const pressure = structuredClone(candidate); pressure.protocol.memoryGuardStopped = true; assert.equal(slowReliabilityResult(pressure, fixtures, binding, reference).eligibleForSlowUse, false);
  const falseClaim = structuredClone(candidate); falseClaim.tasks[0].independentChecks[0].passed = false; assert.equal(slowReliabilityResult(falseClaim, fixtures, binding, reference).eligibleForSlowUse, false);
  const receipt = structuredClone(candidate); receipt.tasks.find((task: any) => task.fixtureId === 'cli-inputs').events = []; assert.equal(slowReliabilityResult(receipt, fixtures, binding, reference).eligibleForSlowUse, false);
  const diagnostic = { ...candidate, budgetProfile: 'desktop-task', slowFullRequested: undefined }; assert.equal(slowReliabilityResult(diagnostic, fixtures, binding, reference).eligibleForSlowUse, false);
  const denial = structuredClone(candidate); denial.tasks.find((task: any) => task.phase === 'deny').permissions = []; assert.equal(slowReliabilityResult(denial, fixtures, binding, reference).eligibleForSlowUse, false);
});

test('slow readback supplement rejects prose, old hashes, partial reads and reads preceding effects', () => {
  for (const fixtureId of ['exact-lf', 'unicode-crlf', 'no-op']) {
    const fixture = fixtures.find(item => item.id === fixtureId)!, task = evidenceReport('qwen3.8:27b-q3-k-m', true).tasks.find((task: any) => task.fixtureId === fixtureId);
    assert.equal(slowReadbackEvidence(fixture, task)?.passed, true);
    for (const change of [{ sha256: 'f'.repeat(64) }, { truncated: true }, { eof: false }, { start_byte: 1 }, { end_byte: 1 }, { text: 'old content' }, { next_cursor: {} }]) {
      const altered = structuredClone(task); Object.assign(altered.tools.at(-1).output, change); assert.equal(slowReadbackEvidence(fixture, altered)?.passed, false);
    }
    const prose = structuredClone(task); prose.tools = []; prose.answer = 'I read and verified the correct full content.'; assert.equal(slowReadbackEvidence(fixture, prose)?.passed, false);
    const truncatedHistory = structuredClone(task); truncatedHistory.toolsTruncated = true; assert.equal(slowReadbackEvidence(fixture, truncatedHistory)?.passed, false);
    if (fixtureId !== 'no-op') {
      const earlier = structuredClone(task); earlier.tools.reverse(); assert.equal(slowReadbackEvidence(fixture, earlier)?.passed, false);
      const unwitnessed = structuredClone(task); unwitnessed.tools[0].output.action_id = 'another-effect'; assert.equal(slowReadbackEvidence(fixture, unwitnessed)?.passed, false);
    }
  }
  const merged = evidenceReport(); merged.tasks[0].workspace = '/fixture/runs/another-run/exact-lf-1-ordinary'; assert.throws(() => validateSlowReferenceReport(merged, fixtures, binding), /aggregate/);
});

test('binding hashes actual tiny source/resource bytes and detects edits without model reads', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'slow-binding-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (relative: string) => { const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'x'); return file; };
  for (const file of sourceFiles) await put(file);
  await put('local-agent/runtime/native/resource-sample.c');
  const paths = { engine: path.join(directory, 'engine'), goose: await put('goose'), research: await put('research/worker'), bridge: await put('bridge'), skills: path.join(directory, 'skills'), node: await put('node') };
  await put('engine/manifest.json'); await put('engine/metal/llama-server'); await put('skills/coding.md');
  const before = await captureSlowBenchmarkBinding(directory, paths); assert.equal(before.source['local-agent/runtime/native/resource-sample.c'].sha256, bytesDigest('x'));
  await writeFile(path.join(directory, 'local-agent/desktop/task-verification.ts'), 'changed');
  const after = await captureSlowBenchmarkBinding(directory, paths); assert.notDeepEqual(after.source, before.source); assert.deepEqual(after.resources, before.resources);
  await symlink(path.join(directory, 'goose'), path.join(directory, 'skills/alias.md')); await assert.rejects(captureSlowBenchmarkBinding(directory, paths), /symlinks/);
});

async function coordinatorFixture(t: any, mode: 'normal' | 'reference-cleanup' | 'candidate-lie' | 'edited-reference' = 'normal') {
  const directory = await mkdtemp(path.join(tmpdir(), 'slow-coordinator-')), cache = path.join(directory, '.cache/coding-reliability'); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(cache, 'models'), { recursive: true });
  const models = ['qwen3.5:4b', 'qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m'].map(id => ({ id, filename: `${id.replace(/[^a-z0-9]/g, '-')}.gguf`, estimatedDownloadBytes: 4 }));
  for (const model of models) await writeFile(path.join(cache, 'models', model.filename), 'tiny');
  const templates = Object.fromEntries(models.map(model => { const value = evidenceReport(model.id, model.id !== 'qwen3.5:4b'); if (model.id === 'qwen3.5:4b' && mode === 'reference-cleanup') value.ownedProcessesStopped = false; return [model.id, value]; }));
  const templateFile = path.join(directory, 'templates.json'); await writeFile(templateFile, JSON.stringify(templates));
  const harnessPath = path.join(directory, 'fake-harness.cjs');
  await writeFile(harnessPath, `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1],model=option('--model'),cache=path.join(process.cwd(),'.cache/coding-reliability'),active=path.join(cache,'active');
if(option('--budget-profile')!=='slow-system-reliability'||option('--repeat')!=='3'||args.includes('--cases'))throw Error('Wrong slow argv');
if(fs.existsSync(active))throw Error('Concurrent child');fs.writeFileSync(active,model);fs.appendFileSync(path.join(cache,'started'),model+'\\n');
const report=JSON.parse(fs.readFileSync(${JSON.stringify(templateFile)},'utf8'))[model],file=path.join(cache,'runs',report.runId,'report.json');fs.mkdirSync(path.dirname(file),{recursive:true});
if(model==='qwen3.5:4b'){if(args.includes('--baseline-report')||option('--memory-mode')!=='automatic')throw Error('Wrong reference argv');}
else {if(option('--memory-mode')!=='low-memory')throw Error('Wrong Q3 argv');const ref=option('--baseline-report');report.baseline={path:ref,sha256:crypto.createHash('sha256').update(fs.readFileSync(ref)).digest('hex'),passFraction:0,unchanged:true};report.slowReliability=${JSON.stringify(slowReliabilityResult(evidenceReport('qwen3.8:27b-q3-k-m', true), fixtures, binding, { passFraction: 0, unchanged: true }))};
if(${JSON.stringify(mode)}==='candidate-lie'&&model.startsWith('qwen'))report.profileStable=false;
if(${JSON.stringify(mode)}==='edited-reference'&&model.startsWith('qwen'))fs.appendFileSync(ref,' ');}
for(const task of report.tasks){task.workspace=path.join(path.dirname(file),task.fixtureId+'-'+task.iteration+'-'+task.phase);for(const tool of task.tools)if(tool.output?.path)tool.output.path=path.join(task.workspace,tool.input.path);}report.completedAt=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(report));fs.rmSync(active,{force:true});
console.log(JSON.stringify({event:'ACCEPTANCE_COMPLETE',report:file}));process.exit(model==='qwen3.5:4b'?1:0);`);
  return { directory, cache, settings: { rootDirectory: directory, catalog: models, harnessPath, slowBinding: binding, waitTimeoutMs: 1000, pollIntervalMs: 5, onOutput: () => {} } };
}

test('slow coordinator measures a new reference before serial Q3 trials and keeps legacy flags false', async t => {
  const fixture = await coordinatorFixture(t), result = await runCodingQualification({ protocol: 'slow' }, fixture.settings);
  assert.equal(result.status, 'completed', result.error ?? 'No pipeline error'); assert.equal(result.reference?.status, 'measured-reference'); assert.equal(result.reference?.exitCode, 1);
  assert.equal(result.referenceSummary?.passFraction, 0); assert.equal(result.protocolId, 'local-coding-slow-system-v1');
  assert.deepEqual(result.attempts.map(attempt => [attempt.model, attempt.status, attempt.qualified]), [['qwen3.8:27b-q3-k-m', 'slow-qualified', false], ['muse-glimmer:30b-q3-k-m', 'slow-qualified', false]]);
  assert.equal((await readFile(path.join(fixture.cache, 'started'), 'utf8')).trim(), 'qwen3.5:4b\nqwen3.8:27b-q3-k-m\nmuse-glimmer:30b-q3-k-m');
});

test('slow coordinator rejects unusable reference, false eligibility and changed reference bytes', async t => {
  for (const mode of ['reference-cleanup', 'candidate-lie', 'edited-reference'] as const) {
    const fixture = await coordinatorFixture(t, mode), result = await runCodingQualification({ protocol: 'slow' }, fixture.settings);
    if (mode === 'reference-cleanup') { assert.equal(result.status, 'failed'); assert.equal(result.attempts.length, 0); }
    else { assert.equal(result.attempts[0].status, 'failed'); assert.equal(result.attempts[0].qualified, false); assert.match(result.attempts[0].error!, /eligibility|reference/); }
  }
  assert.deepEqual(parseQualificationOptions(['--protocol', 'slow']), { protocol: 'slow' });
  assert.equal(parseQualificationOptions(['--baseline-report', 'old.json']).protocol, undefined);
  assert.throws(() => parseQualificationOptions(['--protocol', 'slow', '--protocol', 'slow']), /baseline-report/);
});
