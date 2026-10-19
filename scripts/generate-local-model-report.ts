import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG, modelArtifacts } from '../local-agent/runtime/catalog.ts';

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown, limit = 12000) => typeof value === 'string' ? value.slice(0, limit) : '';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sum = (values: readonly any[], field: string) => values.reduce((total, value) => total + (number(value[field]) ?? 0), 0);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const requested = (model: string) => /^(qwen3\.8:27b|muse-glimmer:30b)(-q3-k-m)?$/.test(model);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_JSON = 16 * 1024 ** 2;
const SLOW_PROTOCOL_ID = 'local-coding-slow-system-v1';
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[depth limit]';
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item, depth + 1)]));
  return value;
}
const benchmarkContexts: Record<string, { architecture: string; conditions: string }> = {
  'Qwen3.8-27B': { architecture: '27B dense hybrid DeltaNet / attention / FFN', conditions: 'Publisher result. SWE-bench Pro uses a revised task set, Claude Code, temperature 1.0, top-p 0.95 and 256K context. Not the local Q3 result.' },
  'Muse Glimmer-30B': { architecture: 'Dense transformer; 52 layers; about 29.6B including the vision encoder', conditions: 'SWE: 500 Verified / 731 original Pro tasks, bash and file tools, four runs averaged. Terminal-Bench 2.1: 89 tasks, Terminus 2 / E2B, Artificial Analysis results. Not the local Q3 result.' },
  'Qwen3-Coder-Next': { architecture: '80B total / about 3B active; MoE hybrid; 48 layers; 512 routed experts, 10 selected plus 1 shared', conditions: 'Publisher upstream results; the official technical report is linked from the model card. Non-thinking model. Not the downloaded Q4, this Mac, or an SSD execution result.' },
  'Qwen3.6-35B-A3B': { architecture: '35B total / about 3B active; MoE hybrid; 40 layers; 256 experts, 8 routed plus 1 shared', conditions: 'SWE: internal bash / file-edit scaffold, 200K context, revised Pro tasks. Terminal-Bench 2.0: Harbor / Terminus 2, 3 hours, 32 CPU / 48GB task environment, 256K context, 80K output, mean of five runs. Not a local Q3 result.' },
  'Qwen3.5-9B /4B': { architecture: 'Smaller dense hybrid models', conditions: 'Publisher results for competition coding and function calling. These do not establish complete repository-task success. Lower-memory candidates require local qualification.' },
  'Qwen3.8-Flash-Next': { architecture: '125B language core / 6B active, plus 51B n-gram embeddings and 4B MTP', conditions: 'Publisher Claude Code / 256K context results on revised SWE-bench Pro. Not chosen for this acquisition: larger artifacts and additional runtime integration are unproven on this Mac.' },
};
const readableEngineeringConclusions = [
  'Apple CPU and Metal share one physical memory pool. CPU offload can reduce GPU residency, but it cannot keep 45 GiB of resident weights in 24 GiB RAM.',
  'Dense models use most weights per generated token. Sparse MoE models select a subset of experts and are better candidates for exact, bounded SSD streaming.',
  'Quantization changes weights and can change coding quality. Extra reasoning time and retries supply opportunities, not a guarantee of correct work or cloud-model equivalence.',
  'Smaller KV caches, context windows, batches and concurrency reduce workspace. Context reductions must retain the task requirements and verification evidence.',
  'Prompt caching can save repeated prefill only when the prefix and required recurrent state remain valid. A cache flag alone is not a measured speed benefit.',
  'An SSD route must preserve exact selected expert computation and account for cache, context, compute buffers, file mappings and OS reserve. Approximate pruning or skipped experts require separate quality tests.',
  'Planning estimates: 8 GiB systems begin with 2–4B Q4; 16 GiB with 8–9B Q4; this 24 GiB Mac with guarded 27B / 30B Q3 trials. The 80B Q4 model needs a demonstrated bounded SSD route here, or a more plausible resident-memory tier of 48–64 GiB. These are not readiness guarantees.',
];

/** Bounded ordinary-file snapshots. A changing or replaced active source is omitted with a warning. */
export class EvidenceReader {
  sources: RecordValue[] = [];
  warnings: string[] = [];
  readonly base: string;
  constructor(base: string) { this.base = base; }
  async read(file: string, maximum = MAX_JSON, tail = false): Promise<string | undefined> {
    if (!inside(this.base, file)) { this.warnings.push(`Source outside evidence directory was omitted: ${file}`); return; }
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warnings.push(`Source unavailable: ${file}`); return; }
    if (!info.isFile() || info.isSymbolicLink() || !tail && info.size > maximum || await realpath(file) !== file) {
      this.warnings.push(`Non-ordinary, symlinked or oversized source was omitted: ${file}`); return;
    }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat(); if (identity(opened) !== identity(info)) throw new Error('Source changed while opening.');
      const offset = tail ? Math.max(0, info.size - maximum) : 0, length = Math.min(info.size, maximum), bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) { const value = await handle.read(bytes, read, length - read, offset + read); if (!value.bytesRead) break; read += value.bytesRead; }
      const after = await handle.stat(), current = await lstat(file);
      if (read !== length || identity(after) !== identity(info) || identity(current) !== identity(info) || current.isSymbolicLink()) throw new Error('Source changed during snapshot.');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.sources.push({ path: file, sha256: hash(bytes), sizeBytes: info.size, snapshotBytes: bytes.length,
        snapshotOffset: offset, scope: offset ? 'bounded file tail, not whole-file digest' : 'whole ordinary file', modifiedAt: new Date(info.mtimeMs).toISOString() });
      return offset ? value.slice(value.indexOf('\n') + 1) : value;
    } catch (error) { this.warnings.push(`Source snapshot omitted: ${file}: ${text(error instanceof Error ? error.message : String(error), 250)}`); }
    finally { await handle.close(); }
  }
  async json(file: string) {
    const value = await this.read(file); if (value === undefined) return undefined;
    try { return JSON.parse(value); } catch { this.warnings.push(`Incomplete or malformed JSON omitted: ${file}`); return undefined; }
  }
  async lines(file: string, maximum = MAX_JSON, tail = false) {
    const value = await this.read(file, maximum, tail); if (value === undefined) return [];
    const lines = value.split('\n'); if (lines.at(-1)) { lines.pop(); this.warnings.push(`Unterminated active log line ignored: ${file}`); }
    const result: RecordValue[] = [];
    for (const line of lines.slice(0, 50000)) { if (!line) continue; try { result.push(object(JSON.parse(line))); } catch { this.warnings.push(`Malformed log line ignored: ${file}`); } }
    return result;
  }
}

async function children(directory: string, maximum: number): Promise<string[]> {
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) return [];
    const entries = await readdir(directory); return entries.sort().slice(0, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function normalizedTask(raw: any) {
  const task = object(raw), checks = array(task.independentChecks), profile = object(task.modelProfile);
  const independentlyPassed = task.passed === true && checks.length > 0 && checks.every(item => item.passed === true);
  const cleanup = array(task.cleanup), cleanupSucceeded = cleanup.length > 0 && cleanup.every(item => item.status === 'fulfilled');
  const rawCompletedStatus = task.status === 'completed' && Boolean(task.completedAt);
  const bindingAccepted = !Object.hasOwn(task, 'profileBindingVerified') || task.profileBindingVerified === true;
  return { taskId: text(task.taskId, 128), fixture: text(task.fixtureId, 128), phase: text(task.phase, 128), status: text(task.status, 64) || 'not recorded',
    verification: text(task.verification, 64) || 'not recorded', startedAt: text(task.startedAt, 100), completedAt: text(task.completedAt, 100),
    activeDurationMs: number(task.activeDurationMs), stopReason: text(task.stopReason, 128), error: text(task.error, 2000),
    completed: rawCompletedStatus && independentlyPassed && cleanupSucceeded && bindingAccepted,
    rawCompletedStatus, independentlyPassed, cleanupSucceeded, bindingAccepted,
    falseVerified: task.falseVerified === true, replayCount: number(task.replayCount) ?? 0,
    profileSignature: text(profile.profileSignature), profileBindingVerified: task.profileBindingVerified === true,
    generationCounts: object(task.generationCounts), continuations: number(task.continuations),
    cleanup: cleanup.map(item => ({ status: text(item.status, 128), error: text(item.error, 500) })),
    independentChecks: checks.map(item => ({ id: text(item.id, 128), passed: item.passed === true, detail: text(item.detail, 2500), sha256: text(item.sha256, 128) })),
    requestedCommandCheck: checks.find(item => item.id === 'requested-command-receipts')?.passed ?? null,
    checks: array(task.checks).map(item => ({ id: text(item.id, 128), purpose: text(item.purpose, 64), status: text(item.status, 64), evidence: object(item.evidence) })),
    cancellationException: task.phase === 'denial' || task.phase === 'cancel' ? 'Expected denial/cancellation fixture phase; judged by its independent oracle.'
      : task.status === 'cancelled' && task.falseVerified === true ? 'Raw falseVerified is retained. A file criterion passed, but this interrupted task did not complete the required readback. This is not a successful coding task.' : null };
}
/** This describes attempts; it never pools them into a qualification pass percentage. */
export function normalizeRun(raw: unknown, reportPath: string, events: readonly RecordValue[] = []) {
  const report = object(raw), model = object(report.model), final = object(report.finalRuntimeBeforeStop), observed = new Map<string, RecordValue>(), failures: RecordValue[] = [];
  const protocol = object(report.protocol), binding = object(protocol.binding), bindingDigest = Object.keys(binding).length ? hash(JSON.stringify(canonical(binding))) : null;
  const slowReliability = Object.hasOwn(report, 'slowReliability') ? object(report.slowReliability) : null;
  for (const event of events) {
    const value = object(event.value);
    if (event.kind === 'runtime' && text(value.profileSignature)) observed.set(value.profileSignature, { at: text(event.at, 100), signature: text(value.profileSignature), profile: object(value.profile), nativeMemoryPlan: object(value.nativeMemoryPlan) });
    if (event.kind === 'runtime-log' && typeof event.value === 'string' && event.value.startsWith('CODING_RESOURCE_FAILURE ')) {
      try { failures.push(object(JSON.parse(event.value.slice('CODING_RESOURCE_FAILURE '.length)))); } catch { /* Raw log remains linked. */ }
    }
  }
  const lastObserved = [...observed.values()].at(-1), signature = text(model.profileSignature) || text(final.profileSignature) || text(lastObserved?.signature), tasks = array(report.tasks).slice(0, 512).map(normalizedTask);
  let parsedSignature: RecordValue = {}; try { parsedSignature = object(JSON.parse(signature)); } catch { /* Opaque historical signatures remain exact. */ }
  const plan = Object.keys(object(model.nativeMemoryPlan)).length ? object(model.nativeMemoryPlan) : Object.keys(object(final.nativeMemoryPlan)).length ? object(final.nativeMemoryPlan) : object(lastObserved?.nativeMemoryPlan);
  const cases = array(report.cases).slice(0, 128).map(item => ({ fixture: text(item.fixtureId, 128), repeat: number(item.repeat), completedAt: text(item.completedAt, 100),
    activeDurationMs: number(item.activeDurationMs), passed: item.passed === true && Boolean(item.completedAt) && array(item.independentChecks).length > 0 && array(item.independentChecks).every(check => check.passed === true), falseVerified: item.falseVerified === true, replayCount: number(item.replayCount) ?? 0,
    taskIds: array(item.tasks).map(id => text(id, 128)), independentChecks: array(item.independentChecks).map(check => ({ id: text(check.id, 128), phase: text(check.phase, 64), passed: check.passed === true, detail: text(check.detail, 2000) })) }));
  const terminal = Boolean(report.completedAt), rawSummary = object(report.summary);
  return { runId: text(report.runId, 128), modelId: text(report.modelId, 128), label: text(report.label, 150), reportPath, eventsPath: path.join(path.dirname(reportPath), 'events.jsonl'),
    startedAt: text(report.startedAt, 100), completedAt: text(report.completedAt, 100), terminal, error: text(report.error, 2500),
    controller: text(report.controller, 500), sourceSnapshot: text(report.sourceSnapshot, 1000), executionLimitMs: number(report.executionLimitMs), budgetProfile: text(report.budgetProfile, 100) || 'historical 15-minute qualification budget',
    protocol: Object.keys(protocol).length ? protocol : null, protocolId: text(protocol.id, 150) || null, sourceResourceBindingDigest: bindingDigest,
    bindingDigestScope: bindingDigest ? 'SHA-256 of canonical recorded source/resource/machine binding; files are not rehashed by this generator.' : null,
    recordedBindingDigest: text(protocol.bindingDigest, 128) || null, slowReliability, slowFullRequested: report.slowFullRequested === true,
    expectedCases: number(report.expectedCases), referenceRecord: Object.keys(object(report.baseline)).length ? object(report.baseline) : null,
    profileSignature: signature || null, profileSignatureSHA256: signature ? hash(signature) : null, profileEvidence: model.profileSignature ? 'prepared model record' : signature ? 'runtime announced profile; readiness not established' : 'unavailable; kept in its own cohort',
    profile: parsedSignature, observedProfiles: [...observed.values()], nativeMemoryPlan: plan, calibrationMeasurements: object(model.calibrationMeasurements), measuredTokensPerSecond: number(model.measuredTokensPerSecond),
    modelDigest: text(model.digest, 128) || text(plan.modelDigest, 128), templateHash: text(model.templateHash, 128) || text(plan.templateDigest, 128), engineIdentity: text(model.engineIdentity, 128),
    setupDurationMs: number(report.setupDurationMs), totalElapsedMs: terminal && Date.parse(report.startedAt) && Date.parse(report.completedAt) ? Date.parse(report.completedAt) - Date.parse(report.startedAt) : null,
    ownedProcessesStopped: report.ownedProcessesStopped === true, nativeUIVerified: report.nativeUIVerified === true, profileStable: report.profileStable ?? null,
    sourceArtifacts: array(report.sourceArtifacts).map(item => ({ filename: text(item.filename, 250), sha256: text(item.sha256, 128), sizeBytes: number(item.sizeBytes), sourceUnchanged: item.sourceUnchanged === true })),
    memoryFailures: failures, fullRequested: report.fullRequested === true, qualificationAllowed: report.qualificationAllowed !== false, reportedQualified: report.qualified === true,
    rawSummary, tasks, cases, receipts: [] as RecordValue[],
    counts: { recordedCases: cases.length, finalizedCases: cases.filter(item => item.completedAt).length, independentlyPassedCases: cases.filter(item => item.passed).length,
      recordedTasks: tasks.length, completedTasks: tasks.filter(task => task.completed).length, rawCompletedStatusTasks: tasks.filter(task => task.rawCompletedStatus).length, independentlyPassedTasks: tasks.filter(task => task.independentlyPassed).length,
      rawFalseVerified: number(rawSummary.falseVerified) ?? cases.filter(item => item.falseVerified).length,
      rawReplayCount: number(rawSummary.replayCount) ?? sum(cases, 'replayCount'), cleanStop: report.ownedProcessesStopped === true ? 1 : 0 } };
}
export function groupRuns(runs: readonly ReturnType<typeof normalizeRun>[]) {
  const groups = new Map<string, RecordValue>();
  for (const run of runs) {
    const protocolDescriptor = run.protocol ? Object.fromEntries(['id', 'caseBudgetMs', 'oracleVersion', 'fixtureSetDigest', 'preparationSteps', 'codingSteps', 'effort'].map(key => [key, run.protocol![key]])) : null;
    const key = JSON.stringify([run.modelId, run.profileSignature ?? `unavailable:${run.runId}`, run.executionLimitMs, run.budgetProfile, protocolDescriptor,
      run.sourceResourceBindingDigest, run.recordedBindingDigest, run.controller, run.modelDigest, run.engineIdentity]);
    let group = groups.get(key);
    if (!group) { group = { cohortId: hash(key).slice(0, 16), modelId: run.modelId, profileSignature: run.profileSignature, profileSignatureSHA256: run.profileSignatureSHA256,
      executionLimitMs: run.executionLimitMs, controller: run.controller, modelDigest: run.modelDigest, engineIdentity: run.engineIdentity, runs: [], attemptCount: 0,
      budgetProfile: run.budgetProfile, protocolId: run.protocolId, protocolDescriptor, sourceResourceBindingDigest: run.sourceResourceBindingDigest,
      terminalAttempts: 0, activeSnapshots: 0, recordedCases: 0, independentlyPassedCases: 0, completedTasks: 0, rawCompletedStatusTasks: 0, rawFalseVerified: 0, rawReplayCount: 0, cleanStops: 0, pooledQualificationScore: null }; groups.set(key, group); }
    group.runs.push(run.runId); group.attemptCount++; group.terminalAttempts += Number(run.terminal); group.activeSnapshots += Number(!run.terminal);
    for (const field of ['recordedCases', 'independentlyPassedCases', 'completedTasks', 'rawCompletedStatusTasks', 'rawFalseVerified', 'rawReplayCount']) group[field] += run.counts[field as keyof typeof run.counts];
    group.cleanStops += Number(run.ownedProcessesStopped);
  }
  return [...groups.values()];
}
/** Display the validator's recorded slow outcome only; do not run or replace that validator. */
export function reportedSlowEligibility(run: ReturnType<typeof normalizeRun>) {
  const result = run.slowReliability, protocol = run.protocol;
  return Boolean(run.terminal && run.budgetProfile === 'slow-system-reliability' && run.executionLimitMs === 3600000
    && run.protocolId === SLOW_PROTOCOL_ID && run.slowFullRequested && !run.fullRequested && !run.qualificationAllowed && !run.reportedQualified
    && run.expectedCases === 36 && run.cases.length === 36 && run.tasks.length === 39 && run.sourceResourceBindingDigest
    && protocol?.bindingUnchanged === true && protocol?.memoryGuardStopped === false && protocol?.runtimeStopped === false
    && run.profileStable === true && run.ownedProcessesStopped && !run.error
    && result?.protocolId === SLOW_PROTOCOL_ID && result?.completeRun === true && result?.criteriaPassed === true
    && result?.referenceMatched === true && result?.eligibleForSlowUse === true && result?.legacyQualified === false
    && run.counts.independentlyPassedCases >= 31 && run.counts.rawFalseVerified === 0 && run.counts.rawReplayCount === 0);
}
async function receiptsForRun(reader: EvidenceReader, run: ReturnType<typeof normalizeRun>) {
  const directory = path.join(path.dirname(run.reportPath), 'profile/actions'), receipts = [];
  for (const taskId of await children(directory, 512)) {
    if (!UUID.test(taskId)) continue;
    const logs = path.join(directory, taskId, 'command-logs');
    for (const name of await children(logs, 512)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const source = path.join(logs, name), raw = await reader.json(source); if (!raw) continue;
      const item = object(raw); receipts.push({ taskId, id: text(item.id, 128), command: text(item.command, 2000), cwd: text(item.cwd, 1500), purpose: text(item.purpose, 128),
        checkIds: array(item.checkIds).map(id => text(id, 128)), state: text(item.state, 128), exitCode: number(item.exitCode), exitSignal: text(item.exitSignal, 64),
        finishedAt: text(item.finishedAt, 100), source, outputLog: source.replace(/\.json$/, '.log'), note: 'Exit code alone does not establish passing after the final mutation; the independent requested-command check is recorded per task.' });
    }
  }
  return receipts;
}
async function fileState(file: string, bytes: number) {
  try { const info = await lstat(file); return { present: true, ordinary: info.isFile() && !info.isSymbolicLink() && await realpath(file) === file, sizeBytes: info.size,
    sizeMatches: info.size === bytes, device: info.dev, inode: info.ino, modifiedAt: new Date(info.mtimeMs).toISOString() }; }
  catch { return { present: false, ordinary: false, sizeMatches: false }; }
}

export async function collectLocalModelReport(directory: string, generatedAt = new Date().toISOString()) {
  const base = await realpath(directory), reader = new EvidenceReader(base), downloads = array(await reader.json(path.join(base, 'downloads.json'))), completed = object(await reader.json(path.join(base, 'completed-model-artifacts.json'))), installed = object(await reader.json(path.join(base, 'installed-q3-models.json')));
  const research = object(await reader.json(path.join(base, 'research-large-models.json'))), status = object(await reader.json(path.join(base, 'implementation-status.json')));
  await reader.read(path.join(base, 'research-large-models.md'), 1024 ** 2);
  const baselineRaw = await reader.json(path.join(base, 'baseline-revalidated.json')), baselineObject = object(baselineRaw);
  const allRuns = [], unavailableRuns = [];
  for (const name of await children(path.join(base, 'runs'), 512)) {
    if (!UUID.test(name)) continue;
    const reportPath = path.join(base, 'runs', name, 'report.json'), raw = await reader.json(reportPath);
    if (!raw) { unavailableRuns.push({ runId: name, reportPath, note: 'No stable report snapshot; no completion claimed.' }); continue; }
    const run = normalizeRun(raw, reportPath, await reader.lines(path.join(base, 'runs', name, 'events.jsonl')));
    run.receipts = await receiptsForRun(reader, run); allRuns.push(run);
  }
  allRuns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const runs = allRuns.filter(run => requested(run.modelId)), baseline = baselineRaw ? normalizeRun(baselineRaw, path.join(base, 'baseline-revalidated.json')) : null;
  const comparisonRuns = allRuns.filter(run => !requested(run.modelId) && run.runId !== baseline?.runId && !run.sourceSnapshot
    && ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3-coder-next:80b'].includes(run.modelId));
  const slowRuns = [...runs, ...comparisonRuns].filter(run => run.budgetProfile === 'slow-system-reliability' && run.protocolId === SLOW_PROTOCOL_ID);
  if (baseline) {
    const originalRun = allRuns.find(run => run.runId === baseline.runId);
    baseline.receipts = originalRun?.receipts ?? [];
    if (originalRun) baseline.eventsPath = originalRun.eventsPath;
  }
  const original = reader.sources.find(source => source.path === baselineObject.originalReportPath), originalDigestMatches = Boolean(original && original.sha256 === baselineObject.originalReportSHA);
  const artifacts = [];
  for (const spec of MODEL_CATALOG.filter(item => requested(item.id))) {
    const known = downloads.find(item => item.model === spec.id), declaration = array(completed.models).find(item => item.model === spec.id), source = path.join(base, 'models', spec.filename), state = await fileState(source, spec.estimatedDownloadBytes);
    const matchingPin = known?.file === source && known?.sha256 === spec.sha256 && known?.revision === spec.revision && known?.bytes === spec.estimatedDownloadBytes;
    const recordedFullSHA = matchingPin && declaration?.file === source && declaration?.publisherSHA256 === spec.sha256 && declaration?.fullSHA256VerifiedByDownloader === true;
    const install = array(installed.installed).find(item => item.model === spec.id), expectedTarget = path.join(homedir(), 'Library/Application Support/Local Agent/gguf-runtime/models', spec.filename);
    const installPinMatches = install?.source === source && install?.target === expectedTarget && install?.sha256 === spec.sha256 && install?.bytes === spec.estimatedDownloadBytes;
    const targetState = installPinMatches ? await fileState(expectedTarget, spec.estimatedDownloadBytes) : null;
    artifacts.push({ modelId: spec.id, quantization: spec.quantization, repository: spec.repository, revision: spec.revision, sourceUrl: spec.sourceUrl, source,
      sizeBytes: spec.estimatedDownloadBytes, publisherSHA256: spec.sha256, knownDownloadRecordMatches: Boolean(matchingPin), fullSHARecordedByDownloader: Boolean(recordedFullSHA),
      currentFileState: state, currentWeightsRehashedByGenerator: false, recordedTemplateHash: text(declaration?.templateHash, 128),
      installedRecordMatches: Boolean(installPinMatches), installedTarget: installPinMatches ? expectedTarget : null, installedFileState: targetState,
      hardlinkStillMatches: Boolean(targetState?.ordinary && targetState?.sizeMatches && state.ordinary && state.sizeMatches && targetState.device === state.device && targetState.inode === state.inode),
      readiness: 'Artifact integrity records are separate from model startup and coding qualification.' });
  }
  const largeSpec = MODEL_CATALOG.find(item => item.id === 'qwen3-coder-next:80b')!, largeDirectory = path.join(base, 'large-models'), largeManifest = object(await reader.json(path.join(largeDirectory, 'downloads.json'))), progress = await reader.lines(path.join(base, 'download-large-model.log'), 256 * 1024, true);
  const largeFiles = [];
  for (const artifact of modelArtifacts(largeSpec)) {
    const completeState = await fileState(path.join(largeDirectory, artifact.filename), artifact.sizeBytes), partial = await fileState(path.join(largeDirectory, artifact.filename + '.part'), artifact.sizeBytes);
    largeFiles.push({ ...artifact, completeState, partialBytes: partial.ordinary ? Math.min(number(partial.sizeBytes) ?? 0, artifact.sizeBytes) : 0,
      acquiredBytes: completeState.ordinary && completeState.sizeMatches ? artifact.sizeBytes : partial.ordinary ? Math.min(number(partial.sizeBytes) ?? 0, artifact.sizeBytes) : 0 });
  }
  const pinnedLargeManifest = largeManifest.model === largeSpec.id && largeManifest.repository === largeSpec.repository && largeManifest.revision === largeSpec.revision && largeManifest.bytes === largeSpec.estimatedDownloadBytes
    && largeManifest.complete === true && array(largeManifest.files).length === 4 && largeFiles.every((artifact, index) => {
      const recorded = array(largeManifest.files)[index]; return recorded?.filename === artifact.filename && recorded?.remotePath === artifact.remotePath && recorded?.file === path.join(largeDirectory, artifact.filename)
        && recorded?.sha256 === artifact.sha256 && recorded?.sizeBytes === artifact.sizeBytes && artifact.completeState.ordinary && artifact.completeState.sizeMatches;
    });
  const counts = { terminalRequestedModelAttempts: runs.filter(run => run.terminal).length, activeRequestedModelSnapshots: runs.filter(run => !run.terminal).length,
    recordedCaseAttempts: sum(runs.map(run => run.counts), 'recordedCases'), independentlyPassedCases: sum(runs.map(run => run.counts), 'independentlyPassedCases'),
    completedTasks: sum(runs.map(run => run.counts), 'completedTasks'), rawCompletedStatusTasks: sum(runs.map(run => run.counts), 'rawCompletedStatusTasks'), rawFalseVerified: sum(runs.map(run => run.counts), 'rawFalseVerified'), rawReplayCount: sum(runs.map(run => run.counts), 'rawReplayCount'),
    cleanStops: runs.filter(run => run.terminal && run.ownedProcessesStopped).length, fullQualificationRuns: runs.filter(run => run.terminal && run.fullRequested && run.rawSummary.fullQualificationRun === true).length,
    reportedQualifiedRuns: runs.filter(run => run.terminal && run.reportedQualified && run.fullRequested && run.qualificationAllowed
      && run.rawSummary.fullQualificationRun === true && run.cases.length === 36 && run.counts.independentlyPassedCases >= 31
      && run.counts.rawFalseVerified === 0 && run.counts.rawReplayCount === 0 && run.ownedProcessesStopped && run.profileStable !== false).length };
  return { schemaVersion: 1, generatedAt, base, title: 'Free local coding model evidence', snapshot: 'Offline evidence snapshot; active partial files may advance after generation.',
    counts, pooledRequestedModelQualificationScore: null, comparisonPolicy: 'Do not pool repeated pilots, profiles, budgets, or controller changes into a full benchmark score. Publisher results are not these local quantized runs.',
    runs, cohorts: groupRuns(runs), comparisonRuns, comparisonCohorts: groupRuns(comparisonRuns),
    slowSystemReliability: { protocolId: SLOW_PROTOCOL_ID, recordedRuns: slowRuns.map(run => ({ runId: run.runId, modelId: run.modelId,
      sourceResourceBindingDigest: run.sourceResourceBindingDigest, validatorResult: run.slowReliability, eligibleForDisplay: reportedSlowEligibility(run), reportPath: run.reportPath })),
      validatorReportedEligibleRuns: slowRuns.filter(reportedSlowEligibility).length, pooledScore: null,
      policy: 'Separate fixed one-hour full 36-case protocol with matched current-controller 4B reference and exact byte binding. Legacy 15-minute qualification and selected one-hour diagnostics never qualify here.' },
    unavailableRuns, baseline: baseline ? { ...baseline, originalDigestMatches, originalReportPath: text(baselineObject.originalReportPath, 1500),
      oracleRevalidation: object(baselineObject.oracleRevalidation), comparisonScope: 'Preserved original 4B controller plus shared safety host; stronger oracle revalidated saved evidence. This is a stack comparison, not a weights-only comparison.' } : null,
    historicalOtherRuns: allRuns.filter(run => !requested(run.modelId) && run.runId !== baseline?.runId && !comparisonRuns.includes(run)), artifacts,
    largeModel: { modelId: largeSpec.id, revision: largeSpec.revision, totalBytes: largeSpec.estimatedDownloadBytes, acquiredBytes: sum(largeFiles, 'acquiredBytes'),
      completeArtifactSetRecorded: pinnedLargeManifest, nativeReadiness: false, codingQualification: false, files: largeFiles, lastCompleteLogEvent: progress.at(-1) ?? null,
      note: 'Partial bytes are unverified acquisition progress, not readiness. No weight checksums were recomputed by this generator.' },
    publishedBenchmarks: array(research.benchmarks).map((item): RecordValue => ({ ...object(item), reportedConditions: item.conditions,
      ...(benchmarkContexts[item.model] ?? {}) })), runtimeSources: array(research.runtimeSources), engineeringConclusions: readableEngineeringConclusions,
    applicationStatusSnapshot: { recordedAt: text(status.recordedAt, 100), package: object(status.package), regression: object(status.regression), nativeUI: object(status.nativeUI), remaining: array(status.remaining) },
    provenance: reader.sources, warnings: reader.warnings };
}

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const time = (milliseconds: unknown) => typeof milliseconds === 'number' ? `${(milliseconds / 60000).toFixed(2)} min` : 'not recorded';
const bytes = (value: unknown) => typeof value === 'number' ? `${(value / 1024 ** 3).toFixed(3)} GiB` : 'not recorded';
function localLink(base: string, target: string, label: string) { return inside(base, target) ? `<a href="${escape(path.relative(base, target).split(path.sep).map(encodeURIComponent).join('/'))}">${escape(label)}</a>` : escape(label); }
function primaryLink(target: unknown, label: string) {
  try { const url = new URL(String(target)); if (url.protocol === 'https:' && !url.username && !url.password && ['huggingface.co', 'github.com', 'research.meta.ai', 'nodejs.org', 'unsloth.ai'].includes(url.hostname)) return `<a href="${escape(url.href)}" rel="noopener noreferrer">${escape(label)}</a>`; } catch { /* Untrusted URLs render as plain text. */ }
  return escape(label);
}
const table = (headers: readonly string[], rows: readonly string[][]) => `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">No recorded evidence.</td></tr>`}</tbody></table></div>`;
export function renderLocalModelReport(report: Awaited<ReturnType<typeof collectLocalModelReport>>): string {
  const { base, counts } = report;
  const receipts = (run: ReturnType<typeof normalizeRun>) => table(['Task / receipt', 'Command and purpose', 'Result / finished', 'Evidence'], run.receipts.map(item => [escape(`${item.taskId}\n${item.id}`), `<code>${escape(item.command)}</code><br>${escape(item.purpose)} / checks ${escape(item.checkIds.join(', '))}`, escape(`${item.state}; exit ${item.exitCode ?? 'not recorded'}; ${item.finishedAt}`), localLink(base, item.source, 'Host receipt') + '<br>' + localLink(base, item.outputLog, 'Command output')]));
  const details = (run: ReturnType<typeof normalizeRun>) => `<details ${run.tasks.length && requested(run.modelId) ? 'open' : ''}><summary>${escape(run.label || run.runId)} — exact evidence</summary><p>${localLink(base, run.reportPath, run.reportPath)}<br>${localLink(base, run.eventsPath, 'Runtime and action events')}</p>
    <p>Signature evidence: ${escape(run.profileEvidence)}. Model SHA: <code>${escape(run.modelDigest || 'unavailable')}</code>. Template: <code>${escape(run.templateHash || 'unavailable')}</code>.</p>
    <p>Budget: ${escape(run.budgetProfile)} / ${escape(time(run.executionLimitMs))}. Protocol: ${escape(run.protocolId || 'no slow protocol recorded')}. Source/resource/machine binding digest: <code>${escape(run.sourceResourceBindingDigest || 'not recorded')}</code>.</p>
    ${run.protocol ? `<details><summary>Recorded protocol and separate slow-reliability validator outcome</summary><pre>${escape(JSON.stringify({ protocol: run.protocol, slowReliability: run.slowReliability, eligibleForDisplay: reportedSlowEligibility(run) }, null, 2))}</pre><p>Recorded byte bindings are not recomputed by this report generator. This outcome never upgrades the legacy benchmark.</p></details>` : ''}
    <details><summary>Exact profile signature and observed historical transitions</summary><pre>${escape(run.profileSignature || 'Unavailable')}</pre><pre>${escape(JSON.stringify(run.observedProfiles, null, 2))}</pre></details>
    ${table(['Task / fixture', 'Outcome', 'Latency / generations', 'Independent checks'], run.tasks.map(task => [escape(`${task.taskId}\n${task.fixture} / ${task.phase}`), `<strong>${escape(task.status)}</strong>; plan checks ${escape(task.verification)}<br>${escape(task.error)}${task.cancellationException ? `<p class="warn">${escape(task.cancellationException)}</p>` : ''}`, escape(`${time(task.activeDurationMs)}; ${JSON.stringify(task.generationCounts)}; continuations ${task.continuations ?? 'not recorded'}`), task.independentChecks.map(check => `${check.passed ? 'PASS' : 'FAIL'} ${escape(check.id)}${check.sha256 ? `<br><code>${escape(check.sha256)}</code>` : ''}`).join('<br>')]))}
    ${run.receipts.length ? receipts(run) : '<p>No command-test receipts were recorded for this attempt.</p>'}<p>Owned model cleanup: ${run.ownedProcessesStopped ? 'confirmed stopped' : 'not confirmed'}; native GUI verification: ${run.nativeUIVerified ? 'recorded' : 'not established'}.</p></details>`;
  const baseline = report.baseline;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Free local coding model benchmark evidence</title><style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18212b;background:#eef2f5}body{max-width:1180px;margin:0 auto;padding:34px}h1{font-size:32px;line-height:1.1;margin:0 0 12px}h2{margin-top:32px;font-size:22px}h3{font-size:17px}p,li{line-height:1.55}header{background:#122738;color:#fff;padding:28px;border-radius:12px}header p{color:#dbe7ef}a{color:#16537d}header a{color:#d4eaff}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.card{background:#fff;border:1px solid #d5dfe6;padding:18px;border-radius:8px}.value{font-size:29px;font-weight:700}.caption{font-size:13px;color:#46545f}.notice{padding:16px;background:#fff4d5;border-left:5px solid #bc7b00}.warn{color:#7a4900;background:#fff4d5;padding:10px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;margin:14px 0}th,td{text-align:left;vertical-align:top;border:1px solid #d5dfe6;padding:9px;white-space:pre-line;overflow-wrap:anywhere}th{background:#e5edf3;font-weight:650}tbody tr:nth-child(even){background:#f7fafc}details{background:#fff;border:1px solid #d5dfe6;border-radius:6px;padding:12px;margin:12px 0}summary{font-weight:650;cursor:pointer}pre,code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f0f4f7;padding:12px}footer{font-size:12px;color:#46545f;margin-top:30px}@media print{:root{background:white}body{padding:0;font-size:10pt}header{background:white;color:#18212b;padding:0}header p{color:#46545f}.cards{grid-template-columns:repeat(4,1fr)}.card{padding:10px}.value{font-size:20pt}table{font-size:8pt}.table-wrap{overflow:visible}tr{break-inside:avoid}h2,h3,summary{break-after:avoid}a{color:#18212b}details{break-inside:auto}pre{font-size:7pt}footer{font-size:8pt}@page{size:A4 landscape;margin:12mm}
    </style></head><body><header><h1>Free local coding model evidence</h1><p>Apple M5 · 24 GiB unified memory · Free and local inference</p><p>Generated ${escape(report.generatedAt)}. ${escape(report.snapshot)}</p></header>
    <div class="cards"><div class="card"><div class="value">${counts.completedTasks}</div><div class="caption">Completed requested-model tasks</div></div><div class="card"><div class="value">${counts.independentlyPassedCases}</div><div class="caption">Independently passed case attempts</div></div><div class="card"><div class="value">${counts.terminalRequestedModelAttempts}</div><div class="caption">Terminal requested-model attempts</div></div><div class="card"><div class="value">${counts.reportedQualifiedRuns}</div><div class="caption">Reported qualified full runs</div></div></div>
    <p class="notice">${counts.completedTasks ? 'Completed tasks are listed with their independent evidence below.' : 'Neither requested model has a recorded completed coding task in this snapshot.'} Successful task completion requires completed status, passing independent oracles, successful cleanup, and profile binding when recorded. Raw completed-status records: ${counts.rawCompletedStatusTasks}. A finalized failed or cancelled case record is not successful completion. No pilot attempts are pooled into a qualification percentage.</p>
    <h2>Local attempts by exact model, signature and budget</h2><p>Each cohort also preserves controller and engine/model identity. Counts describe repeated attempts; they are not a full benchmark score. Missing signatures stay in separate cohorts. ${escape(report.comparisonPolicy)}</p>
    ${table(['Model / cohort', 'Budget / protocol', 'Attempts / active', 'Recorded cases / independently passed', 'Successful tasks / raw completed status', 'Raw falseVerified / replay', 'Clean stops'], report.cohorts.map(group => [escape(`${group.modelId}\n${group.cohortId}`), escape(`${time(group.executionLimitMs)}\n${group.budgetProfile}\n${group.protocolId || 'no slow protocol'}`), escape(`${group.terminalAttempts} terminal / ${group.activeSnapshots} active`), escape(`${group.recordedCases} / ${group.independentlyPassedCases}`), escape(`${group.completedTasks} / ${group.rawCompletedStatusTasks}`), escape(`${group.rawFalseVerified} / ${group.rawReplayCount}`), escape(`${group.cleanStops} / ${group.terminalAttempts}`)]))}
    <h2>Attempt outcomes and memory evidence</h2>${table(['Model / attempt', 'Phase and result', 'Setup / total elapsed', 'Calibration decode', 'Last memory failure', 'Source'], report.runs.map(run => {
      const failure = run.memoryFailures.at(-1), outcomes = run.tasks.map(task => task.status).join(', ');
      const state = run.terminal ? `terminal; ${outcomes || 'no task result recorded'}`
        : `active snapshot; ${outcomes ? `recorded task results: ${outcomes}; run not finalized` : 'no task result recorded yet'}`;
      return [escape(`${run.modelId}\n${run.label}`), escape(`${state}\n${run.error}`), escape(`${time(run.setupDurationMs)} / ${time(run.totalElapsedMs)}`), escape(run.measuredTokensPerSecond === null ? 'not established' : `${run.measuredTokensPerSecond.toFixed(2)} tokens/s (probe, not coding completion)`), failure ? escape(`${failure.pressure}; available ${bytes(failure.availableMemoryBytes)}; RSS ${bytes(failure.rssBytes)}; footprint ${bytes(failure.physicalFootprintBytes)}; plan ${bytes(failure.planWorkingBytes)}`) : 'No structured failure sample recorded; see raw source.', localLink(base, run.reportPath, run.runId)];
    }))}
    ${report.runs.map(details).join('')}
    <h2>Preserved original 4B baseline — separate comparison</h2>${baseline ? `<p><strong>${baseline.rawSummary.passedCases} / ${baseline.rawSummary.completedCases}</strong> cases passed in its complete recorded baseline; ${baseline.tasks.length} phase tasks. ${escape(baseline.comparisonScope)} Original raw report digest match: ${baseline.originalDigestMatches ? 'yes' : 'not established'}. No requested-model pilot percentage is compared against this denominator.</p>${details(baseline)}` : '<p>No stable revalidated baseline snapshot was available.</p>'}
    <h2>Current-controller comparisons: 4B, 9B and 80B</h2><p>The preserved original 4B baseline above is not a matched current-controller slow reference. Current 4B, 9B and 80B runs appear here only when actual reports exist; downloads and publisher numbers cannot create comparison results.</p>
    ${table(['Actual model / cohort', 'Budget / protocol', 'Terminal / active', 'Passed case attempts / successful tasks', 'Recorded byte binding'], report.comparisonCohorts.map(group => [escape(`${group.modelId}\n${group.cohortId}`), escape(`${group.budgetProfile}\n${time(group.executionLimitMs)}\n${group.protocolId || 'diagnostic or legacy; no slow protocol'}`), escape(`${group.terminalAttempts} / ${group.activeSnapshots}`), escape(`${group.independentlyPassedCases} / ${group.completedTasks}`), `<code>${escape(group.sourceResourceBindingDigest || 'not recorded')}</code>`]))}
    ${report.comparisonRuns.map(details).join('')}
    <h2>Separate slow-system reliability protocol</h2><p><code>${escape(report.slowSystemReliability.protocolId)}</code>: ${escape(report.slowSystemReliability.policy)} No attempts or profiles are pooled here. Validator-reported eligible complete runs accepted for display: <strong>${report.slowSystemReliability.validatorReportedEligibleRuns}</strong>.</p>
    ${table(['Actual run / model', 'Recorded validator outcome', 'Source/resource/machine binding', 'Evidence'], report.slowSystemReliability.recordedRuns.map(item => [escape(`${item.runId}\n${item.modelId}`), escape(item.validatorResult ? `completeRun: ${item.validatorResult.completeRun}; criteriaPassed: ${item.validatorResult.criteriaPassed}; referenceMatched: ${item.validatorResult.referenceMatched}; eligibleForSlowUse: ${item.validatorResult.eligibleForSlowUse}; reason: ${item.validatorResult.reason || 'none'}` : 'No validator outcome recorded yet.'), `<code>${escape(item.sourceResourceBindingDigest || 'not recorded')}</code>`, localLink(base, item.reportPath, 'Raw protocol report')]))}
    <h2>Published upstream model benchmarks</h2><p>These publisher numbers are not the exact quantized local model results. Terminal-Bench 2.0 and 2.1, original and revised SWE-bench Pro, and competition coding are distinct. They do not establish cloud-model equivalence.</p>
    ${table(['Model / architecture', 'Published scores', 'Evaluation conditions / limitations', 'Primary sources'], report.publishedBenchmarks.map(item => [escape(`${item.model}\n${item.architecture}`), Object.entries(object(item.scores)).map(([name, score]) => escape(`${name.replace(/^(Terminal-Bench|LiveCodeBench|BFCL)(v?\d)/, '$1 $2')}: ${score}`)).join('<br>'), escape(item.conditions), primaryLink(item.source, 'Model card') + (item.methodologySource ? '<br>' + primaryLink(item.methodologySource, 'Methodology') : '')]))}
    <h2>Downloaded and installed artifact records</h2><p>Known publisher pins and saved full-SHA verification records are shown. Current ordinary-file sizes and Q3 hardlink identities are checked; this generator does not rehash multi-gigabyte weights or establish runtime readiness.</p>
    ${table(['Model / precision', 'Size / local state', 'SHA-256 and revision', 'Recorded verification / installed copy', 'Source'], report.artifacts.map(item => [escape(`${item.modelId}\n${item.quantization}`), escape(`${bytes(item.sizeBytes)}; ${item.currentFileState.ordinary && item.currentFileState.sizeMatches ? 'ordinary file, matching size' : 'missing or changed'}`), `<code>${escape(item.publisherSHA256)}<br>${escape(item.revision)}</code>`, escape(`full SHA recorded: ${item.fullSHARecordedByDownloader}; current hardlink matches: ${item.hardlinkStillMatches}\n${item.installedTarget || 'no installation record'}`), primaryLink(item.sourceUrl, item.repository)]))}
    <h2>80B acquisition — separate from readiness</h2><p>${escape(report.largeModel.modelId)}: ${bytes(report.largeModel.acquiredBytes)} acquired of ${bytes(report.largeModel.totalBytes)} (${(report.largeModel.acquiredBytes / report.largeModel.totalBytes * 100).toFixed(2)}%). Complete pinned artifact set recorded: <strong>${report.largeModel.completeArtifactSetRecorded ? 'yes' : 'no'}</strong>. Native readiness and coding qualification are not established. ${escape(report.largeModel.note)}</p>
    ${table(['Shard', 'Acquired bytes', 'Complete file size matches', 'Publisher SHA-256'], report.largeModel.files.map(item => [escape(item.filename), escape(bytes(item.acquiredBytes)), escape(item.completeState.ordinary && item.completeState.sizeMatches), `<code>${escape(item.sha256)}</code>`]))}
    <h2>Memory and weaker-system limits</h2><p>Normal memory pressure, at least 1 GiB retained headroom, and measured allocation/footprint bounds remain required. Apple CPU and Metal share physical RAM. Slower CPU placement does not add memory capacity. A passed startup probe does not establish coding completion. Exact SSD expert streaming is experimental and requires a bounded working set and actual coding tests.</p><ul>${report.engineeringConclusions.map(item => `<li>${escape(item)}</li>`).join('')}</ul>
    <p>${report.runtimeSources.map(item => primaryLink(item.source, item.stateAtResearch || 'Runtime research source')).join(' · ')}</p>
    <h2>Snapshot warnings and provenance</h2><p>Changing, malformed, oversized or symlinked evidence is omitted rather than trusted. Refresh after active tasks or downloads finish.</p>${report.warnings.length ? `<ul>${report.warnings.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p>No source snapshot warnings.</p>'}
    ${report.unavailableRuns.length ? `<p>Unavailable run snapshots: ${escape(report.unavailableRuns.map(item => item.runId).join(', '))}</p>` : ''}
    <details><summary>Source paths, snapshot hashes and timestamps (${report.provenance.length} files)</summary>${table(['Local source', 'Snapshot size / scope', 'SHA-256', 'Modified'], report.provenance.map(item => [localLink(base, item.path, item.path), escape(`${item.snapshotBytes} bytes; ${item.scope}`), `<code>${escape(item.sha256)}</code>`, escape(item.modifiedAt)]))}</details>
    <footer>Refresh: <code>node scripts/generate-local-model-report.ts</code>. The adjacent JSON contains normalized evidence and exact signatures. This report runs no model, command from source evidence, network request, cloud inference or benchmark workload.</footer></body></html>`;
}

async function atomicOutput(file: string, value: string) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Report output must be an ordinary file.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function generateLocalModelReport(base = path.join(process.cwd(), '.cache/coding-reliability')) {
  const report = await collectLocalModelReport(base), json = path.join(report.base, 'local-model-benchmark-report.json'), html = path.join(report.base, 'local-model-benchmark-report.html');
  await atomicOutput(json, JSON.stringify(report, null, 2) + '\n'); await atomicOutput(html, renderLocalModelReport(report));
  return { json, html, counts: report.counts, warnings: report.warnings.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('This offline report generator uses the fixed workspace evidence directory and accepts no arguments.');
  console.log(JSON.stringify(await generateLocalModelReport()));
}
