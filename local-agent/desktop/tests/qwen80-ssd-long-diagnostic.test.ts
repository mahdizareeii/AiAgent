import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertHarnessSSDOptions, captureSlowBenchmarkBinding, harnessBudget, harnessSummary, parseHarnessOptions,
  recordSSDSelectedComputation, runLocalCodingAcceptance, ssdSelectedProtocolRecord, SSD_SELECTED_DIAGNOSTIC_PROTOCOL,
  type HarnessOptions, type SlowBenchmarkBinding } from '../../../scripts/validate-local-coding.ts';
import { bytesDigest, codingFixtures } from '../../../scripts/coding-reliability-fixtures.ts';
import { QWEN80_SSD_MODEL, QWEN80_SSD_ARTIFACT_SET, QWEN80_SSD_TEMPLATE, QWEN80_SSD_SCOPE, QWEN80_SSD_COMPUTATION,
  QWEN80_SSD_PROFILE, QWEN80_SSD_PROTOCOL, QWEN80_SSD_WORKER_PATCH, SSD_BASE_COMMIT, ssdNumericalNativeBinding } from '../../runtime/ssd-contract.ts';
import type { PreparedModel } from '../../runtime/index.ts';

// Synthetic bounded fixtures only. These tests do not load weights or grant numerical/quality evidence.
const valid: HarnessOptions = { model: QWEN80_SSD_MODEL, sourceDirectory: '.', memoryMode: 'ssd-experts',
  budgetProfile: SSD_SELECTED_DIAGNOSTIC_PROTOCOL, cases: ['exact-lf', 'cli-inputs'], repeat: 1 };
const runIdentity = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: '2026-10-15T00:00:00.000Z' };
const argv = ['--model', QWEN80_SSD_MODEL, '--source-dir', '.cache/models', '--memory-mode', 'ssd-experts',
  '--budget-profile', SSD_SELECTED_DIAGNOSTIC_PROTOCOL, '--cases', 'exact-lf,cli-inputs', '--repeat', '1'];
const fixtures = codingFixtures(process.execPath), selected = valid.cases!.map(id => fixtures.find(fixture => fixture.id === id)!);

test('four-hour SSD opt-in preserves every old budget and cannot earn qualification', () => {
  const parsed = parseHarnessOptions(argv), budget = harnessBudget(parsed);
  assert.equal(budget.limitMs, 14400000); assert.equal(budget.qualificationAllowed, false); assert.equal(budget.slowReliabilityAllowed, false);
  assert.equal(harnessBudget({ ...valid, budgetProfile: 'desktop-task' }).limitMs, 3600000);
  assert.equal(harnessBudget({ ...valid, budgetProfile: 'qualification' }).limitMs, 900000);
  assert.equal(harnessBudget({ ...valid, budgetProfile: 'slow-system-reliability', cases: undefined, repeat: 3 }).limitMs, 3600000);
  const fakeAllPassing = fixtures.flatMap(fixture => [1, 2, 3].map(() => ({ fixtureId: fixture.id, passed: true })));
  assert.equal(harnessSummary(budget, fixtures, 3, fakeAllPassing).qualified, false);
  assert.throws(() => assertHarnessSSDOptions({ ...valid, budgetProfile: 'slow-system-reliability', cases: undefined, repeat: 3 }), /SSD diagnostics/);
});

test('cross-mode and selected-source gates reject parser and direct-call bypasses before startup', async () => {
  for (const change of [{ model: 'qwen3.5:4b' }, { model: 'muse-glimmer:30b-q3-k-m' }, { model: 'gemma4:26b' },
    { memoryMode: 'automatic' }, { memoryMode: 'low-memory' }, { memoryMode: undefined }, { cases: undefined }, { cases: [] },
    { cases: ['exact-lf', 'exact-lf'] }, { cases: ['not-a-fixture'] }, { repeat: 2 }, { repeat: 3 },
    { sourceSnapshot: '/snapshot' }, { packagePath: '/app' }, { baselineReport: '/baseline' }])
    assert.throws(() => assertHarnessSSDOptions({ ...valid, ...change } as HarnessOptions));
  for (const [flag, value] of [['--model', 'qwen3.5:4b'], ['--memory-mode', 'automatic'], ['--memory-mode', 'low-memory'],
    ['--cases', 'unknown'], ['--cases', 'exact-lf,exact-lf'], ['--repeat', '2']]) {
    const changed = [...argv]; changed[changed.indexOf(flag) + 1] = value; assert.throws(() => parseHarnessOptions(changed));
  }
  for (const extra of [['--package', '/app'], ['--baseline-report', '/baseline'], ['--source-snapshot', '/snapshot'],
    ['--hours', '4'], ['--budget-profile', SSD_SELECTED_DIAGNOSTIC_PROTOCOL]]) assert.throws(() => parseHarnessOptions([...argv, ...extra]));
  const withoutMode = argv.filter((_value, index) => index !== 4 && index !== 5); assert.throws(() => parseHarnessOptions(withoutMode));
  // This direct invalid call fails in the common pure budget gate even on non-native CI.
  await assert.rejects(runLocalCodingAcceptance({ ...valid, cases: ['unknown'] }), /unique known cases/);
});

test('direct public run API cannot give a non-SSD model the four-hour budget', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  await assert.rejects(runLocalCodingAcceptance({ ...valid, model: 'qwen3.5:4b', memoryMode: 'automatic' }), /Four-hour SSD diagnostics/);
});

function protocolFixture(change: { failedCertificate?: boolean; changedNative?: boolean; wrongProfile?: boolean } = {}) {
  const manifest: any = { schemaVersion: 1, baseCommit: SSD_BASE_COMMIT, patchSha256: QWEN80_SSD_WORKER_PATCH, target: 'darwin-arm64',
    backends: [{ id: 'cpu', executable: 'worker/llama-server-ssd', libraryDirectory: 'worker', arguments: [] }],
    planner: { schemaVersion: 1, executable: 'worker/llama-plan-ssd', sourceSha256: 'a'.repeat(64) },
    integrity: { schemaVersion: 1, executable: 'worker/llama-hash-ssd', sourceSha256: 'b'.repeat(64) },
    files: ['llama-server-ssd', 'llama-plan-ssd', 'llama-hash-ssd', 'libllama.0.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib']
      .map((name, index) => ({ path: 'worker/' + name, size: 128 + index, sha256: String(index + 1).repeat(64) })) };
  const native = ssdNumericalNativeBinding(manifest)!;
  const configuration: any = { schemaVersion: 1, modelSha256: QWEN80_SSD_ARTIFACT_SET, templateSha256: QWEN80_SSD_TEMPLATE,
    architecture: 'qwen3next', backend: 'cpu', cpuKernel: 'standard', useExtraBufts: false, cpuRepackTensorCount: 0,
    baseCommit: SSD_BASE_COMMIT, workerPatchSha256: QWEN80_SSD_WORKER_PATCH, scope: QWEN80_SSD_SCOPE,
    profile: { ...QWEN80_SSD_COMPUTATION, ...(change.wrongProfile ? { contextTokens: 4096 } : {}) },
    report: 'validation/qwen3-coder-next-80b-standard-cpu-8k.json', reportSha256: 'f'.repeat(64) };
  const certificate = { ...configuration, passed: !change.failedCertificate, absoluteTolerance: 1e-5, relativeTolerance: 1e-5,
    nativeResourceIdentity: native.identity, nativeResourceDigest: native.digest,
    resolvedNativeLayout: { contextTokens: 8192, contextPerSequence: 8192, batchTokens: 64, microBatchTokens: 16, slots: 1, kvUnified: true, nRsSeq: 0, cacheTypeK: 'f16', cacheTypeV: 'f16' },
    measuredProof: { protocol: QWEN80_SSD_PROTOCOL, sourceArtifactSetVerified: true, expertParityPassed: true, completeHybridEvidence: true,
      sourceFingerprintUnchanged: true, ownedProcessesStopped: true, selectedPairsContributeOnce: true, nodesCompared: 1, elementsCompared: 1,
      expertLayoutsSurveyed: 2, representativeGroupsCompared: 4, elementsOutsideTolerance: 0, mismatchedIds: 0, nonfinite: 0,
      comparisonSha256: 'a'.repeat(64), processReportSha256: 'b'.repeat(64), expertParityLogSha256: 'c'.repeat(64) },
    measuredRun: { resourceSummary: { sampleCount: 2, ownedChildSampleCount: 1, minimumAvailableRamBytes: 2 * 1024 ** 3,
      maximumControllerRssBytes: 1024, maximumControllerPhysicalFootprintBytes: 2048, maximumOwnedChildRssBytes: 4096,
      maximumOwnedChildPhysicalFootprintBytes: 8192, allPressureNormal: true } } };
  const certificateText = JSON.stringify(certificate), digest = bytesDigest(certificateText);
  if (change.changedNative) manifest.files[0].sha256 = 'e'.repeat(64);
  manifest.files.push({ path: configuration.report, size: Buffer.byteLength(certificateText), sha256: digest });
  manifest.validatedConfigurations = [{ ...configuration, reportSha256: digest }];
  const manifestText = JSON.stringify(manifest), resources = Object.fromEntries(manifest.files.map((file: any) => [`ssd-engine/${file.path}`, { sizeBytes: file.size, sha256: file.sha256 }]));
  resources['ssd-engine/manifest.json'] = { sizeBytes: Buffer.byteLength(manifestText), sha256: bytesDigest(manifestText) };
  const binding: SlowBenchmarkBinding = { schemaVersion: 1, source: { 'host.ts': { sha256: 'a'.repeat(64), sizeBytes: 1 } }, resources,
    machine: { platform: 'darwin', architecture: 'arm64', cpuModel: 'Synthetic fixture', cpuCores: 1, totalMemoryBytes: 24 * 1024 ** 3, osRelease: 'fixture', nodeVersion: process.version } };
  return { binding, saved: { manifest: manifestText, certificate: certificateText } };
}

test('new protocol binds exact current metadata and keeps native numerical scope separate from host time', () => {
  const fixture = protocolFixture(), protocol = ssdSelectedProtocolRecord(fixture.binding, selected, valid, fixture.saved, runIdentity);
  assert.equal(protocol.id, SSD_SELECTED_DIAGNOSTIC_PROTOCOL); assert.equal(protocol.caseBudgetMs, 14400000);
  assert.deepEqual(protocol.selectedFixtureIds, ['exact-lf', 'cli-inputs']); assert.equal(protocol.repeat, 1); assert.equal(protocol.oracleVersion, 2);
  assert.equal(protocol.preparationSteps, 24); assert.equal(protocol.codingSteps, 40); assert.equal(protocol.finalizationSteps, 1);
  assert.equal(protocol.continuationLimit, 3); assert.equal(protocol.certificate.scope, QWEN80_SSD_SCOPE);
  assert.equal(protocol.bindingUnchanged, false); assert.equal(protocol.computationBinding, null);
  for (const change of [{ failedCertificate: true }, { changedNative: true }, { wrongProfile: true }]) {
    const bad = protocolFixture(change); assert.throws(() => ssdSelectedProtocolRecord(bad.binding, selected, valid, bad.saved, runIdentity), /certificate/);
  }
  assert.throws(() => ssdSelectedProtocolRecord(fixture.binding, selected, valid, { ...fixture.saved, manifest: fixture.saved.manifest + '\n' }, runIdentity), /binding changed/);
  assert.throws(() => ssdSelectedProtocolRecord(fixture.binding, [...selected].reverse(), valid, fixture.saved, runIdentity), /fixture order/);
  assert.throws(() => ssdSelectedProtocolRecord(fixture.binding, selected, { ...valid, budgetProfile: 'desktop-task' }, fixture.saved, runIdentity));
});

test('reversed explicit selected cases remain accepted in the requested protocol order', () => {
  const args = [...argv]; args[args.indexOf('--cases') + 1] = 'cli-inputs,exact-lf';
  const parsed = parseHarnessOptions(args), actual = [selected[1], selected[0]], fixture = protocolFixture();
  assert.deepEqual(actual.map(value => value.id), ['cli-inputs', 'exact-lf']);
  assert.notDeepEqual(actual.map(value => value.id), selected.map(value => value.id));
  const protocol = ssdSelectedProtocolRecord(fixture.binding, actual, parsed, fixture.saved, runIdentity);
  assert.deepEqual(protocol.selectedFixtureIds, ['cli-inputs', 'exact-lf']);
});

test('fresh trial computation recording rejects profile drift, stale identity and missing probes', () => {
  const fixture = protocolFixture(), protocol = ssdSelectedProtocolRecord(fixture.binding, selected, valid, fixture.saved, runIdentity);
  const profile = { ...QWEN80_SSD_PROFILE, memoryMode: 'ssd-experts', engineCommit: SSD_BASE_COMMIT, cpuKernel: 'standard', useExtraBufts: false,
    decodeThreads: 4, batchThreads: 4, parityReportDigest: protocol.certificate.sha256, engineDigest: 'd'.repeat(64), patchDigest: QWEN80_SSD_WORKER_PATCH,
    artifactSetDigest: QWEN80_SSD_ARTIFACT_SET, templateDigest: QWEN80_SSD_TEMPLATE, slots: 1, workers: 2, ioMode: 'darwin-nocache',
    expectedGroups: 48, minimumSlotsPerLayer: 30, cacheTypeK: 'f16', cacheTypeV: 'f16', localOnly: true };
  const prepared = { sourceModel: QWEN80_SSD_MODEL, digest: QWEN80_SSD_ARTIFACT_SET, templateHash: QWEN80_SSD_TEMPLATE,
    contextTokens: 8192, outputTokens: 2048, verificationIO: 'darwin-nocache', engineIdentity: profile.engineDigest, profileSignature: JSON.stringify(profile) } as PreparedModel;
  const trial = { id: '11111111-1111-4111-8111-111111111111', startedAt: '2026-10-15T00:00:01.000Z', mode: 'ssd-experts', state: 'passed',
    probePassed: true, toolProbePassed: true, model: prepared.sourceModel, digest: prepared.digest, profileSignature: prepared.profileSignature,
    backendValidation: 'validated', parityReportDigest: protocol.certificate.sha256, engineDigest: prepared.engineIdentity, patchDigest: QWEN80_SSD_WORKER_PATCH,
    measurements: { sampledAt: '2026-10-15T00:00:02.500Z', pressure: 'normal', rssBytes: 4 * 1024 ** 3, residentBytes: 4 * 1024 ** 3,
      physicalFootprintBytes: 4 * 1024 ** 3 - 16 * 1024 ** 2, availableMemoryBytes: 8 * 1024 ** 3 },
    streaming: { pid: 321, stage: 'ready', stopped: false, sampledAt: '2026-10-15T00:00:02Z', rssBytes: 4 * 1024 ** 3,
      physicalFootprintBytes: 4 * 1024 ** 3 - 16 * 1024 ** 2, streamedGroups: 48, expectedGroups: 48, cacheSlotsPerLayer: 30, ioMode: 'darwin-nocache',
      cpuKernel: 'standard', useExtraBufts: false, cpuRepackTensorCount: 0, decodeThreads: 4, batchThreads: 4 } };
  recordSSDSelectedComputation(protocol, prepared, trial); assert.equal(protocol.computationBinding?.trialId, trial.id);
  assert.equal(protocol.computationBinding?.diagnosticRunId, runIdentity.runId);
  assert.equal(protocol.computationBinding?.diagnosticStartedAt, runIdentity.startedAt);
  assert.deepEqual(protocol.computationBinding?.startupMeasurements, trial.measurements);
  for (const change of [{ id: '' }, { toolProbePassed: false }, { parityReportDigest: 'f'.repeat(64) }, { profileSignature: '{}' },
    { startedAt: '2026-10-14T23:59:59.999Z' }, { measurements: undefined },
    { measurements: { ...trial.measurements, sampledAt: undefined } }, { measurements: { ...trial.measurements, sampledAt: '2026-10-15T00:00:00.999Z' } },
    { measurements: { ...trial.measurements, rssBytes: 0 } }, { measurements: { ...trial.measurements, physicalFootprintBytes: undefined } },
    { measurements: { ...trial.measurements, availableMemoryBytes: 1024 ** 3 - 1 } }, { measurements: { ...trial.measurements, pressure: 'warning' } },
    { streaming: { ...trial.streaming, pid: 0 } }, { streaming: { ...trial.streaming, stage: 'loading' } }, { streaming: { ...trial.streaming, stopped: true } },
    { streaming: { ...trial.streaming, sampledAt: '2026-10-15T00:00:00.999Z' } }, { streaming: { ...trial.streaming, rssBytes: 0 } },
    { streaming: { ...trial.streaming, physicalFootprintBytes: undefined } }, { streaming: { ...trial.streaming, decodeThreads: 8 } },
    { streaming: { ...trial.streaming, batchThreads: 8 } }, { streaming: { ...trial.streaming, streamedGroups: 47 } }])
    assert.throws(() => recordSSDSelectedComputation(protocol, prepared, { ...trial, ...change }));
  const changed = JSON.stringify({ ...profile, batchThreads: 8 });
  assert.throws(() => recordSSDSelectedComputation(protocol, { ...prepared, profileSignature: changed }, { ...trial, profileSignature: changed }), /computation profile/);
});

const sourceFiles = ['scripts/validate-local-coding.ts', 'scripts/coding-reliability-fixtures.ts', 'scripts/run-local-coding-qualification.ts',
  'local-agent/desktop/coding-task.ts', 'local-agent/desktop/task-verification.ts', 'local-agent/desktop/actions.ts', 'local-agent/desktop/approvals.ts',
  'local-agent/desktop/inference-gateway.ts', 'local-agent/desktop/transcript.ts', 'local-agent/desktop/backend.ts', 'local-agent/runtime/index.ts',
  'local-agent/runtime/memory.ts', 'local-agent/runtime/generation.ts', 'package.json', 'package-lock.json'];
test('optional SSD binding uses only the fixed ordinary resource root and leaves old binding output unchanged', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssd-selected-binding-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (relative: string) => { const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'x'); return file; };
  for (const file of sourceFiles) await put(file);
  const paths = { engine: path.join(directory, 'engine'), goose: await put('goose'), research: await put('research/worker'), bridge: await put('bridge'), skills: path.join(directory, 'skills'), node: await put('node') };
  await put('engine/manifest.json'); await put('skills/coding.md');
  const before = await captureSlowBenchmarkBinding(directory, paths);
  const certificate = await put('resources/ssd-inference/darwin-arm64/validation/qwen.json');
  await put('resources/ssd-inference/darwin-arm64/worker/llama-server-ssd');
  const withSSD = await captureSlowBenchmarkBinding(directory, paths, true);
  assert.deepEqual(withSSD.source, before.source); assert(withSSD.resources['ssd-engine/validation/qwen.json']);
  assert.deepEqual(Object.fromEntries(Object.entries(withSSD.resources).filter(([key]) => !key.startsWith('ssd-engine/'))), before.resources);
  await writeFile(certificate, 'changed'); assert.notDeepEqual((await captureSlowBenchmarkBinding(directory, paths, true)).resources, withSSD.resources);
  assert.deepEqual(await captureSlowBenchmarkBinding(directory, paths), before);
  const weight = await put('resources/ssd-inference/darwin-arm64/worker/unexpected.gguf');
  await assert.rejects(captureSlowBenchmarkBinding(directory, paths, true), /model-weight/); await rm(weight);
  await symlink(certificate, path.join(directory, 'resources/ssd-inference/darwin-arm64/validation/alias'));
  await assert.rejects(captureSlowBenchmarkBinding(directory, paths, true), /symlinks/);
});
