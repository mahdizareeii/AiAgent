// Fixed driver schedules only. This module performs no app/model/process work.
const CONTEXT_DIAGNOSTIC = 'context-diagnostic-v1';
const HOST_CONTEXT_DIAGNOSTIC = 'host-context-diagnostic-v1';
const ALL_FIXTURE_IDS = Object.freeze(['exact-lf', 'cli-inputs', 'js-repair', 'python-repair', 'csv-unicode', 'two-file-change', 'bounded-retrieval', 'unicode-edit', 'schedule-reasoning', 'already-correct', 'denied-write', 'network-denied']);
const DIAGNOSTIC_FIXTURE_IDS = Object.freeze(['exact-lf', 'python-repair']);
const DIAGNOSTIC_MODEL_IDS = Object.freeze(['qwen3.5:4b', 'qwen3.5:9b-q3-k-s', 'qwen3.5:9b-ud-iq3-xxs', 'qwen3.5:9b-ud-iq2-m']);
const HOST_DIAGNOSTIC_MODEL_IDS = Object.freeze(DIAGNOSTIC_MODEL_IDS.slice(1));
const FULL = Object.freeze({ id: undefined, fixtureIds: ALL_FIXTURE_IDS, repeats: 3, liveControls: true });
const DIAGNOSTIC = Object.freeze({ id: CONTEXT_DIAGNOSTIC, fixtureIds: DIAGNOSTIC_FIXTURE_IDS, repeats: 1, liveControls: false });
const HOST_DIAGNOSTIC = Object.freeze({ id: HOST_CONTEXT_DIAGNOSTIC, fixtureIds: DIAGNOSTIC_FIXTURE_IDS, repeats: 1, liveControls: false });
const sameIds = (fixtures, ids) => Array.isArray(fixtures) && fixtures.length === ids.length && fixtures.every((fixture, index) => fixture?.id === ids[index]);

function driverMode(id) {
  if (id === undefined) return FULL;
  if (id === CONTEXT_DIAGNOSTIC) return DIAGNOSTIC;
  if (id === HOST_CONTEXT_DIAGNOSTIC) return HOST_DIAGNOSTIC;
  throw new Error('Unknown or forged driver mode; only the complete suite or explicit fixed context diagnostic is supported.');
}
function selectDriverFixtures(fixtures, id) {
  const mode = driverMode(id);
  if (!sameIds(fixtures, ALL_FIXTURE_IDS)) throw new Error('The driver requires the unchanged complete frozen fixture order before selecting its fixed mode.');
  return mode === FULL ? fixtures : DIAGNOSTIC_FIXTURE_IDS.map(fixtureId => fixtures.find(fixture => fixture.id === fixtureId));
}
function validateDriverPlan(plan) {
  const mode = driverMode(plan?.runMode);
  if (!sameIds(plan?.fixtures, mode.fixtureIds)) throw new Error('The driver plan does not match the exact fixed fixture order for its mode.');
  if (mode !== FULL && !(mode === HOST_DIAGNOSTIC ? HOST_DIAGNOSTIC_MODEL_IDS : DIAGNOSTIC_MODEL_IDS).includes(plan?.model?.id)) throw new Error('The diagnostic requires one exact whitelisted model identity.');
  if (mode === HOST_DIAGNOSTIC && plan.environment !== 'physical') throw new Error('Host context diagnostics require declared physical hardware, never a whole-OS VM or memory override.');
  if ('repeats' in plan || 'cases' in plan || 'models' in plan) throw new Error('Arbitrary case, repeat and model dispatch is unavailable.');
  return mode;
}
async function runDriverSequence(plan, callbacks) {
  const mode = validateDriverPlan(plan);
  await callbacks.acceptance('cold'); await callbacks.acceptance('warm');
  if (mode.liveControls) { await callbacks.fixtureCase(plan.control, 1); await callbacks.fixtureCase(plan.stopControl, 1); }
  for (const fixture of plan.fixtures) for (let repeat = 1; repeat <= mode.repeats; repeat++) await callbacks.fixtureCase(fixture, repeat);
}
function markDriverReport(report, id) {
  const mode = driverMode(id);
  if (mode === FULL) return report;
  const host = mode === HOST_DIAGNOSTIC;
  return { ...report, ...(host ? { protocolId: HOST_CONTEXT_DIAGNOSTIC, originProtocolId: report.protocolId,
      actual8GBModelEvidence: false, qualityClaimEstablished: false } : {}),
    classification: host ? 'host-context-diagnostic' : 'context-diagnostic', attemptClassification: report.classification,
    complete: false, eligibleForIndependentSupportReview: false, qualified: false, supportClaimEstablished: false,
    ...(report.driver ? { driver: { ...report.driver, controlsPassed: false } } : {}),
    diagnostic: { id: mode.id, fixtureIds: DIAGNOSTIC_FIXTURE_IDS, repeats: 1,
      liveControls: 'not-run-unvalidated', fullSuite: 'not-run-ineligible-as-reference-or-candidate' } };
}
function diagnosticComparison(reports, id = CONTEXT_DIAGNOSTIC) {
  const mode = driverMode(id);
  if (mode === FULL) throw new Error('Diagnostic comparison requires an explicit fixed diagnostic mode.');
  const reason = 'Fixed context diagnostic is intentionally incomplete and cannot serve as a qualification reference or candidate.';
  const candidates = mode === HOST_DIAGNOSTIC ? reports : reports.slice(1);
  const comparisons = candidates.map(report => ({ modelId: report.modelId, eligibleForIndependentSupportReview: false,
    error: reason, qualified: false, supportClaimEstablished: false }));
  return { comparisons, selection: { ranking: [], excluded: candidates.map(report => ({ modelId: report.modelId, reason })),
    recommendedForIndependentReview: null, qualified: false, supportClaimEstablished: false } };
}
/** Policy over real probes only. Neither parent nor child accepts caller RAM as a probe. */
function hostContextHardware(actual) {
  const number = value => typeof value === 'string' && /^\d+\s*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const sysctlMemoryBytes = number(actual.sysctlMemory), hypervisorPresent = number(actual.hypervisor);
  const available = actual.platform === 'darwin' && actual.architecture === 'arm64'
    && actual.totalMemoryBytes === 24 * 1024 ** 3 && sysctlMemoryBytes === actual.totalMemoryBytes && hypervisorPresent === 0;
  return { ...actual, target: `${actual.platform}-${actual.architecture}/cpu`, sysctlMemoryBytes, hypervisorPresent,
    physicalHostConfirmed: hypervisorPresent === 0, available, networkIsolationAvailable: actual.platform === 'darwin',
    reason: available ? null : 'Host context diagnostic requires actual darwin/arm64 physical24GiB, matching OS/sysctl memory and kern.hv_vmm_present=0; caller memory declarations cannot substitute.',
    supported: false, actual8GBModelEvidence: false, hostContextDiagnosticOnly: true };
}
function validateHostHardwareEvidence(evidence, actual) {
  if (!actual?.available || evidence?.environment !== 'physical' || evidence?.memoryScope !== 'whole-os'
    || evidence?.actual?.totalMemoryBytes !== actual.totalMemoryBytes || evidence?.actual?.sysctlMemoryBytes !== actual.sysctlMemoryBytes
    || evidence?.actual?.hypervisorPresent !== 0 || evidence?.actual?.platform !== actual.platform || evidence?.actual?.architecture !== actual.architecture) {
    throw new Error('Host hardware declaration must match the independently probed physical24GiB host; it cannot override a failed actual gate.');
  }
}
function observedNativeSamples(samples, modelPid, controllerPid) {
  const rows = Number.isSafeInteger(modelPid) && modelPid > 0 ? samples.filter(row => row.pid === modelPid && row.parentPid === controllerPid
    && Number.isSafeInteger(row.rssBytes) && row.rssBytes > 0 && Number.isSafeInteger(row.physicalFootprintBytes) && row.physicalFootprintBytes > 0) : [];
  const times = rows.map(row => Date.parse(row.sampledAt));
  return { requestedIntervalMs: 1000, observedSamples: rows.length, uniqueSampleTimestamps: new Set(times).size,
    maximumObservedGapMs: times.reduce((maximum, at, index) => index ? Math.max(maximum, at - times[index - 1]) : maximum, 0),
    observedMaximumResidentBytes: Math.max(0, ...rows.map(row => row.residentBytes)),
    observedMaximumRSSBytes: Math.max(0, ...rows.map(row => row.rssBytes)),
    observedMaximumPhysicalFootprintBytes: Math.max(0, ...rows.map(row => row.physicalFootprintBytes)),
    scope: 'Fresh owned PID/parent native-helper snapshots; observed maxima are not allocation high-water marks. Runtime watchdog samples are separate.' };
}
module.exports = { CONTEXT_DIAGNOSTIC, HOST_CONTEXT_DIAGNOSTIC, DIAGNOSTIC_MODEL_IDS, HOST_DIAGNOSTIC_MODEL_IDS,
  driverMode, selectDriverFixtures, validateDriverPlan, runDriverSequence, markDriverReport, diagnosticComparison, hostContextHardware, validateHostHardwareEvidence, observedNativeSamples };
