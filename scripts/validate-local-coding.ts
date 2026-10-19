import type { AcceptanceCheck, TaskCriterion } from '../local-agent/desktop/task-verification.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, link, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, release, totalmem } from 'node:os';
import { LocalInferenceRuntime, MODEL_CATALOG, ENGINE_COMMIT, RuntimeError, type PreparedModel } from '../local-agent/runtime/index.ts';
import { modelArtifacts, type CuratedModel } from '../local-agent/runtime/catalog.ts';
import { codingModelFamily, isQualificationEligible } from '../local-agent/runtime/generation.ts';
import { sha256File } from '../local-agent/runtime/gguf.ts';
import { loopbackFetch } from '../local-agent/runtime/transport.ts';
import { QWEN80_SSD_MODEL, QWEN80_SSD_ARTIFACT_SET, QWEN80_SSD_TEMPLATE, QWEN80_SSD_SCOPE, QWEN80_SSD_PROFILE, ssdNumericalNativeBinding } from '../local-agent/runtime/ssd-contract.ts';
import { validateSSDNumericalProof } from '../local-agent/runtime/memory.ts';
import { BudgetedInference, createInferenceGateway, type InferenceProfile } from '../local-agent/desktop/inference-gateway.ts';
import { GooseBackend } from '../local-agent/desktop/backend.ts';
import { LocalActions, type ActionPermission, type ActionToolEvent } from '../local-agent/desktop/actions.ts';
import { createActionHost } from '../local-agent/desktop/action-host.ts';
import { ApprovalRegistry } from '../local-agent/desktop/approvals.ts';
import { TaskClock, TaskTimeoutError } from '../local-agent/desktop/task-clock.ts';
import { isFailedVerificationCheck, RepairBudget } from '../local-agent/desktop/repair-budget.ts';
import { TaskVerificationLedger } from '../local-agent/desktop/task-verification.ts';
import { initializeContextRecoveryArchive } from '../local-agent/desktop/context-recovery.ts';
import { acceptanceStatus, prepareCodingTask, runVerifiedCodingTask } from '../local-agent/desktop/coding-task.ts';
import { taskInstructions } from '../local-agent/desktop/agent-policy.ts';
import { appendThinking } from '../local-agent/desktop/thinking.ts';
import { emptyToolHistory, finishToolHistory, updateToolHistory } from '../local-agent/desktop/tool-history.ts';
import { checkFromHostAction, checksFromReadTools, finalizationEvidence, hostCodingClosing, incompleteNotice, outcomeStatus } from '../local-agent/desktop/task-outcome.ts';
import { runProjectPreflight, formatPreflightContext, formatPreparationPreflightContext, preflightDigest } from '../local-agent/desktop/project-preflight.ts';
import { CODING_ORACLE_VERSION, bytesDigest, codingFixtures, fixtureDigest, fixtureEvidenceChecks, fixturePermissionAllowed, fixtureReplayCheck, qualificationSummary, runIndependentVerifier, seedFixture,
  type CodingFixture, type IndependentResult } from './coding-reliability-fixtures.ts';
import type { AgentEvent, TaskCheck, UtilityPreferences } from '../local-agent/desktop/renderer/types.ts';

export const CASE_BUDGET_MS = 15 * 60_000;
export const DESKTOP_TASK_BUDGET_MS = 60 * 60_000;
export const SLOW_RELIABILITY_PROTOCOL = 'local-coding-slow-system-v1';
export const SSD_SELECTED_DIAGNOSTIC_PROTOCOL = 'ssd-selected-4h-v1';
export const SSD_SELECTED_CASE_BUDGET_MS = 4 * DESKTOP_TASK_BUDGET_MS;
export type HarnessBudgetProfile = 'qualification' | 'desktop-task' | 'slow-system-reliability' | typeof SSD_SELECTED_DIAGNOSTIC_PROTOCOL;
/** Long desktop diagnostics retain every oracle but cannot qualify or change the original benchmark. */
export function harnessBudget(options: Pick<HarnessOptions, 'budgetProfile' | 'sourceSnapshot' | 'cases' | 'repeat'>) {
  const profile = options.budgetProfile ?? 'qualification';
  assert(profile === 'qualification' || profile === 'desktop-task' || profile === 'slow-system-reliability' || profile === SSD_SELECTED_DIAGNOSTIC_PROTOCOL, '--budget-profile must be qualification, desktop-task, slow-system-reliability or ssd-selected-4h-v1.');
  if (profile === 'desktop-task') {
    assert(!options.sourceSnapshot, 'Desktop diagnostics cannot change a preserved source baseline.');
    assert(options.cases?.length && options.repeat === 1, 'Desktop diagnostics require explicit --cases and --repeat 1.');
  }
  if (profile === 'slow-system-reliability') {
    assert(!options.sourceSnapshot && !options.cases && options.repeat === 3, 'Slow reliability requires all fixed fixtures, repeat 3 and current production source; preserved or selected diagnostics cannot qualify.');
  }
  if (profile === SSD_SELECTED_DIAGNOSTIC_PROTOCOL) {
    const known = new Set(codingFixtures(process.execPath).map(fixture => fixture.id));
    assert(!options.sourceSnapshot && options.repeat === 1 && Array.isArray(options.cases) && options.cases.length > 0
      && new Set(options.cases).size === options.cases.length && options.cases.every(id => known.has(id)),
      'Four-hour SSD diagnostics require current source, explicit unique known cases and repeat 1.');
  }
  return { profile, limitMs: profile === 'qualification' ? CASE_BUDGET_MS : profile === SSD_SELECTED_DIAGNOSTIC_PROTOCOL ? SSD_SELECTED_CASE_BUDGET_MS : DESKTOP_TASK_BUDGET_MS,
    qualificationAllowed: profile === 'qualification', slowReliabilityAllowed: profile === 'slow-system-reliability', ssdSelectedDiagnosticAllowed: profile === SSD_SELECTED_DIAGNOSTIC_PROTOCOL };
}
export function harnessSummary(budget: ReturnType<typeof harnessBudget>, ...args: Parameters<typeof qualificationSummary>) {
  const summary = qualificationSummary(...args);
  return { ...summary, qualified: budget.qualificationAllowed && summary.qualified };
}
export function harnessModelSource(spec: CuratedModel) {
  return { codingFamily: codingModelFamily(spec.id), quantization: spec.quantization, repository: spec.repository,
    revision: spec.revision, sourceUrl: spec.sourceUrl, filename: spec.filename };
}
const root = fileURLToPath(new URL('..', import.meta.url));
export type HarnessMemoryMode = 'automatic' | 'low-memory' | 'ssd-experts';
export interface HarnessOptions { model: string; sourceDirectory: string; cases?: string[]; repeat: number; sourceSnapshot?: string; packagePath?: string; label?: string; baselineReport?: string; memoryMode?: HarnessMemoryMode; budgetProfile?: HarnessBudgetProfile; }
function requestedHarnessMemoryMode(options: Pick<HarnessOptions, 'memoryMode' | 'sourceSnapshot'>): HarnessMemoryMode {
  const mode = options.memoryMode ?? 'automatic';
  assert(mode === 'automatic' || mode === 'low-memory' || mode === 'ssd-experts', '--memory-mode must be automatic, low-memory or ssd-experts.');
  assert(!options.sourceSnapshot || mode === 'automatic', 'Source-snapshot baseline comparisons require automatic memory mode.');
  return mode;
}
export function assertHarnessSSDOptions(options: HarnessOptions): void {
  const budget = harnessBudget(options);
  // This cross-mode gate precedes the non-SSD return, including for direct API callers.
  if (budget.ssdSelectedDiagnosticAllowed) assert(options.memoryMode === 'ssd-experts' && options.model === QWEN80_SSD_MODEL
    && !options.sourceSnapshot && !options.baselineReport && !options.packagePath,
    'Four-hour SSD diagnostics require exact Qwen80, explicit ssd-experts, current source and no package or baseline.');
  if (requestedHarnessMemoryMode(options) !== 'ssd-experts') return;
  assert(options.model === QWEN80_SSD_MODEL, '--memory-mode ssd-experts coding diagnostics are bound to exact curated Qwen80.');
  assert((budget.profile === 'desktop-task' || budget.ssdSelectedDiagnosticAllowed) && !options.sourceSnapshot && !options.baselineReport && !options.packagePath,
    'SSD diagnostics require explicit source desktop-task or ssd-selected-4h-v1 cases/repeat1 and cannot qualify or alter a preserved benchmark.');
}
/** The preserved baseline retains its original runtime settings and startup sequence. */
export async function startHarnessRuntime(runtime: { setMemoryMode(mode: HarnessMemoryMode): Promise<void>; start(options: { signal?: AbortSignal }): Promise<unknown> },
  options: Pick<HarnessOptions, 'memoryMode' | 'sourceSnapshot'>, signal?: AbortSignal): Promise<void> {
  const mode = requestedHarnessMemoryMode(options);
  if (!options.sourceSnapshot) await runtime.setMemoryMode(mode);
  await runtime.start({ signal });
}
export function parseHarnessOptions(args: string[]): HarnessOptions {
  const values = new Map<string, string>(), known = new Set(['model', 'source-dir', 'cases', 'repeat', 'source-snapshot', 'package', 'label', 'baseline-report', 'memory-mode', 'budget-profile']);
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index].startsWith('--') && known.has(args[index].slice(2)) && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown option or missing value: ${args[index]}`);
    const key = args[index].slice(2); assert(!values.has(key), `Duplicate option: --${key}`); values.set(key, args[index + 1]);
  }
  assert(values.has('model') && values.has('source-dir'), '--model and --source-dir are required; no model acquisition occurs here.');
  const repeat = Number(values.get('repeat') ?? 3); assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3, '--repeat must be 1, 2, or 3.');
  const cases = values.get('cases')?.split(','); if (cases) assert(cases.length > 0 && new Set(cases).size === cases.length && cases.every(Boolean), '--cases must list unique fixture IDs.');
  const memoryMode = requestedHarnessMemoryMode({ memoryMode: (values.get('memory-mode') ?? 'automatic') as HarnessMemoryMode, sourceSnapshot: values.get('source-snapshot') });
  const budgetProfile = harnessBudget({ budgetProfile: (values.get('budget-profile') ?? 'qualification') as HarnessBudgetProfile, cases, repeat, sourceSnapshot: values.get('source-snapshot') }).profile;
  const options: HarnessOptions = { model: values.get('model')!, sourceDirectory: path.resolve(values.get('source-dir')!), repeat, memoryMode, budgetProfile,
    ...(cases ? { cases } : {}), ...(values.has('source-snapshot') ? { sourceSnapshot: path.resolve(values.get('source-snapshot')!) } : {}),
    ...(values.has('package') ? { packagePath: path.resolve(values.get('package')!) } : {}), ...(values.has('baseline-report') ? { baselineReport: path.resolve(values.get('baseline-report')!) } : {}), ...(values.has('label') ? { label: values.get('label')!.slice(0, 120) } : {}) };
  assertHarnessSSDOptions(options);
  return options;
}
const inside = (base: string, candidate: string) => { const relative = path.relative(base, candidate); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function loopbackOnlyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Acceptance inference permits only owned loopback HTTP requests.');
  return fetch(input, { ...init, redirect: 'error', credentials: 'omit' });
}

/** Preserve the original snapshot wrapper; updated runs use desktop's transport,
 * whose timeout is the explicit reviewed runtime/probe deadline. */
export function selectHarnessInferenceFetch(options: Pick<HarnessOptions, 'sourceSnapshot'>): typeof loopbackOnlyFetch {
  if (options.sourceSnapshot) return loopbackOnlyFetch;
  return async (input, init) => {
    // Runtime requests always supply a URL and explicit JSON body. Do not
    // silently discard a Request object's method, body, headers or signal.
    if (input instanceof Request) throw new Error('Updated acceptance inference requires an owned loopback URL and explicit JSON request options.');
    return loopbackFetch(input, { ...init, redirect: 'error', credentials: 'omit' });
  };
}

/** Current coding turns close from the same host evidence as desktop, without another model call. */
export function closeUpdatedCodingTask(task: any, options: { aborted: boolean; timedOut: boolean; abortReason?: unknown; recordClosing?: (text: string) => void }): void {
  const repairLimit = options.aborted && /Repair limit reached/.test(errorText(options.abortReason));
  const runtimeStopped = options.aborted && options.abortReason instanceof RuntimeError;
  const blocker = options.timedOut || repairLimit || runtimeStopped ? errorText(options.abortReason) : task.error;
  task.verification = acceptanceStatus(task.acceptanceChecks ?? []);
  // Freeze status before adding fallback prose. A generated closing never upgrades an answerless task.
  task.status = outcomeStatus({ aborted: options.aborted && !repairLimit && !runtimeStopped, timedOut: options.timedOut,
    error: blocker, finishReason: task.stopReason, hasAnswer: Boolean(task.answer.trim()), verification: task.verification });
  if (task.status !== 'completed') {
    const text = hostCodingClosing({ status: task.status, checks: task.checks, blocker: blocker ?? (task.stopReason !== 'end_turn' ? task.stopReason : undefined), planPrepared: Boolean(task.taskBrief) });
    task.answer += `${task.answer.trim() ? '\n\n' : ''}${text}`; task.closingSource = 'host';
    try { options.recordClosing?.(text); } catch (error) { task.finalizationError = errorText(error); }
  }
}

/** A failed final evaluation cannot reuse a prior passed snapshot after host actions have drained. */
export async function evaluateUpdatedCodingTask(task: any, ledger: Pick<TaskVerificationLedger, 'evaluate'>,
  finalReadbackEvaluation?: () => Promise<AcceptanceCheck[]>): Promise<void> {
  try { task.acceptanceChecks = await (finalReadbackEvaluation ? finalReadbackEvaluation() : ledger.evaluate()); task.verification = acceptanceStatus(task.acceptanceChecks); }
  catch (error) {
    task.acceptanceChecks = []; task.verification = 'unverified';
    task.checks = (task.checks ?? []).filter((check: TaskCheck) => check.purpose !== 'acceptance');
    task.verificationError = `Task verification could not finish: ${errorText(error)}`;
    task.error ??= task.verificationError;
  }
}

/** Stop admission and drain accepted actions before freezing evidence. Cleanup abort is not task cancellation. */
export async function drainUpdatedCodingTask(options: { signal: AbortSignal; clock: TaskClock; controller: AbortController;
  cleanupReason?: object; cancelApprovals: () => void; backend?: Pick<GooseBackend, 'stop'>; host?: Awaited<ReturnType<typeof createActionHost>>;
  gateway?: Pick<Awaited<ReturnType<typeof createInferenceGateway>>, 'close'> }): Promise<{
    aborted: boolean; timedOut: boolean; abortReason: unknown; remainingMs: number;
    cleanup: { status: 'fulfilled' | 'rejected'; error?: string }[];
  }> {
  const termination = { aborted: options.signal.aborted, timedOut: options.clock.signal.aborted,
    abortReason: options.signal.reason, remainingMs: options.clock.remainingMs };
  // The clock is shared by denial/cancel phases. Hold it through cleanup/evidence work, then the caller resumes it.
  options.clock.pause(); options.controller.abort(options.cleanupReason); options.cancelApprovals();
  const cleanup = await Promise.allSettled([options.backend?.stop(), options.host?.drain(), options.gateway?.close()]);
  options.host?.server.closeAllConnections();
  if (options.host) await new Promise<void>(resolve => options.host!.server.close(() => resolve()));
  return { ...termination, cleanup: cleanup.map(value => ({ status: value.status,
    ...(value.status === 'rejected' ? { error: errorText(value.reason) } : {}) })) };
}

export interface ReadbackOwnedStop { model: string; code: string; message: string; }
interface ReadbackRuntimeEvents {
  on(event: 'executionStopped', listener: (event: ReadbackOwnedStop) => void): unknown;
  off(event: 'executionStopped', listener: (event: ReadbackOwnedStop) => void): unknown;
}
/** Actual readback-only listener and final-drain transaction; legacy routes stay separate. */
export function createReadbackTaskLifecycle(options: { runtime: ReadbackRuntimeEvents; model: string; signal: AbortSignal; clock: TaskClock;
  controller: AbortController; ledger: TaskVerificationLedger; task: any; operationChecks: () => TaskCheck[]; inferenceFailure: () => { message: string } | undefined;
  onOwnedStop?: (event: ReadbackOwnedStop) => void }) {
  const ownedHealth: { failure?: RuntimeError } = {}; let finalized = false;
  const stopped = (event: ReadbackOwnedStop) => {
    if (event.model !== options.model) return;
    ownedHealth.failure = new RuntimeError(event.code, event.message);
    try { options.onOwnedStop?.(event); }
    finally { options.controller.abort(ownedHealth.failure); }
  };
  options.runtime.on('executionStopped', stopped);
  const clearProof = (message: string) => {
    options.task.error ??= message; options.task.acceptanceChecks = []; options.task.verification = 'unverified';
    options.task.checks = (options.task.checks ?? []).filter((check: TaskCheck) => check.purpose !== 'acceptance');
  };
  return {
    async finalize(resources: { cancelApprovals: () => void; backend?: Pick<GooseBackend, 'stop'>;
      host?: Awaited<ReturnType<typeof createActionHost>>; gateway?: Pick<Awaited<ReturnType<typeof createInferenceGateway>>, 'close'> }) {
      if (finalized) throw new Error('The owned readback lifecycle is already finalized.'); finalized = true;
      let termination: Awaited<ReturnType<typeof drainUpdatedCodingTask>>;
      try {
        const finalization = !options.signal.aborted && !options.task.error && options.task.stopReason === 'end_turn'
          && !options.inferenceFailure() && !ownedHealth.failure ? options.ledger.prepareReadbackFinalization(options.task.acceptanceChecks ?? []) : undefined;
        termination = await drainUpdatedCodingTask({ signal: options.signal, clock: options.clock, controller: options.controller,
          cleanupReason: finalization?.cleanupReason, cancelApprovals: resources.cancelApprovals, backend: resources.backend, host: resources.host, gateway: resources.gateway });
        options.task.cleanup = termination.cleanup;
        // Accepted actions may deliver their terminal receipts DURING drain.
        options.task.checks = options.operationChecks();
        const rejected = termination.cleanup.find(entry => entry.status === 'rejected');
        if (rejected) options.task.error ??= `Task cleanup failed: ${rejected.error}`;
        if (ownedHealth.failure) options.task.error ??= ownedHealth.failure.message;
        await evaluateUpdatedCodingTask(options.task, options.ledger, finalization ? () => options.ledger.evaluateReadbackFinalization(finalization.token, () => {
          if (termination.aborted || termination.timedOut || options.task.error || ownedHealth.failure || options.inferenceFailure()) throw new Error('Readback finalization lost healthy owned completion.');
        }) : undefined);
      } catch (error) { clearProof(`Readback finalization failed: ${errorText(error)}`); throw error; }
      finally {
        try { await options.ledger.closeReadbackScope(); }
        catch (error) { clearProof(`Readback scope could not close: ${errorText(error)}`); }
        const unhealthy = ownedHealth.failure ?? options.inferenceFailure();
        if (unhealthy) clearProof(unhealthy.message);
        options.runtime.off('executionStopped', stopped);
      }
      return termination;
    },
  };
}

/** Updated qualification requires one stable profile; retain actual evidence before stopping on a drift. */
export function recordHarnessTaskProfile(report: any, task: any, actual: InferenceProfile, expected: InferenceProfile): boolean {
  const fields = ['model', 'sourceModel', 'digest', 'templateHash', 'engineIdentity', 'contextTokens', 'outputTokens', 'profileSignature',
    'nativeMemoryPlan', 'calibrationMeasurements', 'generationPolicy', 'memoryMode', 'executionRoute', 'backendValidation', 'measuredTokensPerSecond'] as const;
  task.modelProfile = Object.fromEntries(fields.filter(key => actual[key] !== undefined).map(key => [key, structuredClone(actual[key])]));
  const identity = ['model', 'sourceModel', 'digest', 'templateHash', 'engineIdentity'] as const;
  const changedIdentity = identity.filter(key => actual[key] !== expected[key]);
  task.profileBindingVerified = changedIdentity.length === 0;
  if (changedIdentity.length) {
    const reason = `The task's final verified model binding changed (${changedIdentity.join(', ')}). Further fixture cases were stopped.`;
    task.error ??= reason; report.error ??= reason; report.profileStable = false;
    report.profileDrift = { taskId: task.taskId, kind: 'identity', changedFields: changedIdentity };
    report.stoppedReason = reason; return false;
  }
  if (!expected.profileSignature || actual.profileSignature !== expected.profileSignature
    || actual.contextTokens !== expected.contextTokens || actual.outputTokens !== expected.outputTokens) {
    report.profileStable = false;
    report.profileDrift = { taskId: task.taskId, kind: 'profile', expectedSignature: expected.profileSignature ?? null,
      actualSignature: actual.profileSignature ?? null, expectedContextTokens: expected.contextTokens, actualContextTokens: actual.contextTokens,
      expectedOutputTokens: expected.outputTokens, actualOutputTokens: actual.outputTokens };
    report.stoppedReason = 'The verified inference profile changed during acceptance. This run cannot qualify one stable profile; further fixture cases were stopped.';
    return false;
  }
  return true;
}

export function validateBaselineReport(raw: unknown, fixtures: CodingFixture[], options: { requireRevalidation?: boolean } = {}): { passedCases: number; totalCases: 36; passFraction: number } {
  assert(raw && typeof raw === 'object', 'Baseline must be a saved report object.'); const value = raw as any;
  assert.equal(value.schemaVersion, 1); assert.equal(value.modelId, 'qwen3.5:4b'); assert.equal(value.syntheticProvider, false);
  assert.equal(value.fullRequested, true); assert.equal(value.expectedCases, 36); assert.equal(value.ownedProcessesStopped, true);
  assert.equal(typeof value.sourceSnapshot, 'string'); assert.equal(value.controller, 'preserved 4B loop with current shared safety host'); assert(!value.error);
  assert(Number.isFinite(Date.parse(value.completedAt)), 'Only a terminal baseline can establish promotion.');
  if (options.requireRevalidation !== false) {
    const oracle = value.oracleRevalidation;
    assert(oracle && oracle.version === CODING_ORACLE_VERSION && oracle.noModelCalls === true && oracle.noActionReplay === true && oracle.monotonic === true && oracle.revalidatedTasks === 39 && oracle.revalidatedCases === 36, 'Promotion requires the complete current oracle revalidation.');
    assert(typeof value.originalReportPath === 'string' && /^[a-f0-9]{64}$/.test(value.originalReportSHA), 'Revalidation must identify its immutable original report.');
    assert(Number.isFinite(Date.parse(oracle.completedAt)) && value.originalFixtureDigests && value.tasks.every((task: any) => typeof task.originalPassed === 'boolean' && (!task.passed || task.originalPassed)), 'Revalidation may only retain or lower original results.');
    assert(value.cases.every((item: any) => typeof item.originalPassed === 'boolean' && (!item.passed || item.originalPassed)), 'Revalidation cannot upgrade a case.');
  }
  const model = MODEL_CATALOG.find(item => item.id === 'qwen3.5:4b')!;
  assert(value.sourceArtifacts?.length === modelArtifacts(model).length && value.sourceArtifacts.every((artifact: any, index: number) => artifact.sha256 === modelArtifacts(model)[index].sha256 && artifact.sourceUnchanged === true), 'Baseline weights must match the preserved pinned artifacts.');
  assert(value.cases?.length === 36 && Array.isArray(value.tasks) && value.tasks.length === 39, 'A partial baseline cannot establish promotion.');
  assert(new Set(value.tasks.map((item: any) => item.taskId)).size === value.tasks.length, 'Baseline task identities must be unique.');
  for (const fixture of fixtures) {
    assert.equal(value.fixtureDigests?.[fixture.id], fixtureDigest(fixture), `Baseline fixture differs: ${fixture.id}`);
    const cases = value.cases.filter((item: any) => item.fixtureId === fixture.id); assert.equal(cases.length, 3);
    assert.deepEqual(cases.map((item: any) => item.repeat).sort(), [1, 2, 3], 'Baseline repeats must be exactly 1,2,3.');
    for (const item of cases) {
      assert.equal(item.fixtureDigest, fixtureDigest(fixture)); assert.equal(typeof item.passed, 'boolean');
      assert(item.tasks?.length === (fixture.safety ? 2 : 1));
      const tasks = item.tasks.map((id: string) => value.tasks.find((task: any) => task.taskId === id)); assert(tasks.every(Boolean));
      assert.deepEqual(tasks.map((task: any) => task.phase).sort(), fixture.safety ? ['cancel', 'deny'] : ['ordinary']);
      for (const task of tasks) {
        assert(task.fixtureId === fixture.id && task.iteration === item.repeat && typeof task.passed === 'boolean', 'Baseline task/case identities disagree.');
        assert(Number.isFinite(Date.parse(task.completedAt)) && task.cleanup?.length === 3 && task.cleanup.every((entry: any) => entry.status === 'fulfilled'), 'Every baseline task must have terminal cleanup evidence.');
      }
      assert.equal(item.passed, tasks.every((task: any) => task.passed === true), 'Case result disagrees with its recorded tasks.');
      for (const task of tasks) if (task.passed) assert(task.independentChecks?.length && task.independentChecks.every((check: any) => check.passed === true), 'Passed baseline task lacks independent assertions.');
    }
  }
  const passedCases = value.cases.filter((item: any) => item.passed).length;
  return { passedCases, totalCases: 36, passFraction: passedCases / 36 };
}

/** Bind augmented results to the immutable original rather than trusting provenance prose. */
export function validateBaselineRevalidation(raw: unknown, original: unknown, fixtures: CodingFixture[], originalFixtures: CodingFixture[]): void {
  validateBaselineReport(raw, fixtures); validateBaselineReport(original, originalFixtures, { requireRevalidation: false });
  const augmented = raw as any, saved = original as any;
  assert.deepEqual(augmented.originalFixtureDigests, saved.fixtureDigests);
  for (const key of ['runId', 'modelId', 'sourceSnapshot', 'baselineSourceDigests', 'sourceArtifacts', 'resources']) assert.deepEqual(augmented[key], saved[key], `Revalidation changed source provenance: ${key}`);
  for (const item of augmented.cases) {
    const previous = saved.cases.find((candidate: any) => candidate.fixtureId === item.fixtureId && candidate.repeat === item.repeat);
    assert(previous && item.originalPassed === previous.passed); assert.deepEqual(item.tasks, previous.tasks);
  }
  for (const task of augmented.tasks) {
    const previous = saved.tasks.find((candidate: any) => candidate.taskId === task.taskId);
    assert(previous && task.originalPassed === previous.passed);
    for (const key of ['fixtureId', 'iteration', 'phase', 'workspace', 'events', 'permissions', 'answer', 'verification', 'continuations', 'lateApproval', 'cleanup']) assert.deepEqual(task[key], previous[key], `Revalidation changed saved task evidence: ${key}`);
    assert.deepEqual(task.originalIndependentChecks, previous.independentChecks);
  }
}

export interface SlowBenchmarkBinding {
  schemaVersion: 1;
  source: Record<string, { sha256: string; sizeBytes: number }>;
  resources: Record<string, { sha256: string; sizeBytes: number }>;
  machine: { platform: string; architecture: string; cpuModel: string; cpuCores: number; totalMemoryBytes: number; osRelease: string; nodeVersion: string };
}
export interface HarnessResourcePaths { engine: string; goose: string; research: string; bridge: string; skills: string; node: string; }
const SLOW_REQUIRED_SOURCES = ['scripts/validate-local-coding.ts', 'scripts/coding-reliability-fixtures.ts', 'scripts/run-local-coding-qualification.ts',
  'local-agent/desktop/coding-task.ts', 'local-agent/desktop/task-verification.ts', 'local-agent/desktop/actions.ts', 'local-agent/desktop/approvals.ts',
  'local-agent/desktop/inference-gateway.ts', 'local-agent/desktop/transcript.ts', 'local-agent/desktop/backend.ts', 'local-agent/runtime/index.ts',
  'local-agent/runtime/memory.ts', 'local-agent/runtime/generation.ts', 'package.json', 'package-lock.json'] as const;
/** Actual resource bytes are hashed serially before/after a slow run. This is
 * separate from inference and never hashes model weights or changes a baseline. */
export async function captureSlowBenchmarkBinding(repository: string, paths: HarnessResourcePaths, includeFixedSSDResources = false): Promise<SlowBenchmarkBinding> {
  const source: SlowBenchmarkBinding['source'] = {}, resources: SlowBenchmarkBinding['resources'] = {};
  const record = async (file: string, key: string, target: typeof source) => {
    const before = await lstat(file); assert(before.isFile() && !before.isSymbolicLink(), `Benchmark binding requires an ordinary file: ${key}`);
    const sha256 = await sha256File(file), after = await lstat(file);
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `Benchmark file changed while hashing: ${key}`);
    target[key] = { sha256, sizeBytes: before.size };
  };
  const walk = async (directory: string, prefix: string, target: typeof source, sourceOnly = false) => {
    const info = await lstat(directory); assert(info.isDirectory() && !info.isSymbolicLink(), `Benchmark directory is not ordinary: ${prefix}`);
    for (const name of (await readdir(directory)).sort()) {
      if (sourceOnly && ['tests', 'dist', 'node_modules', '.venv'].includes(name)) continue;
      const file = path.join(directory, name), key = `${prefix}/${name}`, entry = await lstat(file);
      assert(!entry.isSymbolicLink(), `Benchmark binding rejects symlinks: ${key}`);
      if (entry.isDirectory()) await walk(file, key, target, sourceOnly);
      else if (!sourceOnly || /\.(?:ts|tsx|js|mjs|json|md|c|cpp|h|m)$/.test(name)) {
        assert(!prefix.startsWith('ssd-engine') || !/\.gguf$/i.test(name), 'SSD resource binding refuses model-weight files.');
        await record(file, key, target);
      }
    }
  };
  for (const directory of ['local-agent/desktop', 'local-agent/runtime']) await walk(path.join(repository, directory), directory, source, true);
  for (const file of SLOW_REQUIRED_SOURCES.filter(file => !file.startsWith('local-agent/'))) await record(path.join(repository, file), file, source);
  for (const file of SLOW_REQUIRED_SOURCES) assert(source[file], `Current host source is missing: ${file}`);
  await walk(paths.engine, 'engine', resources);
  // Fixed internal root only: there is no CLI or caller-supplied SSD directory.
  if (includeFixedSSDResources) await walk(path.join(repository, 'resources/ssd-inference/darwin-arm64'), 'ssd-engine', resources);
  await walk(paths.skills, 'skills', resources);
  await walk(path.dirname(paths.research), 'research', resources);
  for (const [file, key] of [[paths.goose, 'goose'], [paths.bridge, 'bridge'], [await realpath(paths.node), 'node'], [await realpath('/usr/bin/python3'), 'python']] as const) await record(file, key, resources);
  return { schemaVersion: 1, source, resources, machine: { platform: process.platform, architecture: process.arch, cpuModel: cpus()[0]?.model ?? 'Unknown CPU',
    cpuCores: cpus().length, totalMemoryBytes: totalmem(), osRelease: release(), nodeVersion: process.version } };
}
const SSD_SELECTED_CERTIFICATE = 'validation/qwen3-coder-next-80b-standard-cpu-8k.json';
/** A new selected time budget never changes the arithmetic certificate or a previous run. */
export function ssdSelectedProtocolRecord(binding: SlowBenchmarkBinding, fixtures: CodingFixture[], options: HarnessOptions,
  saved: { manifest: string; certificate: string }, run: { runId: string; startedAt: string }) {
  assertHarnessSSDOptions(options); assert(harnessBudget(options).ssdSelectedDiagnosticAllowed);
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(run.runId) && Number.isFinite(Date.parse(run.startedAt)), 'Selected diagnostic requires this new run identity.');
  assert(saved.manifest.length <= 1024 ** 2 && saved.certificate.length <= 1024 ** 2, 'SSD metadata is oversized.');
  const manifest = JSON.parse(saved.manifest), certificate = JSON.parse(saved.certificate), native = ssdNumericalNativeBinding(manifest);
  assert(native, 'Four-hour SSD diagnostics require the current native computation identity.');
  const covered = (relative: string, bytes: string) => {
    const record = binding.resources[`ssd-engine/${relative}`];
    assert(record && record.sha256 === bytesDigest(bytes) && record.sizeBytes === Buffer.byteLength(bytes), `SSD binding changed while reading ${relative}.`);
    return record;
  };
  covered('manifest.json', saved.manifest);
  const certificateFile = covered(SSD_SELECTED_CERTIFICATE, saved.certificate);
  for (const file of manifest.files) {
    const actual = binding.resources[`ssd-engine/${file.path}`];
    assert(actual && actual.sha256 === file.sha256 && actual.sizeBytes === file.size, 'SSD resource inventory differs from its recorded bytes.');
  }
  const configuration = manifest.validatedConfigurations?.find((value: any) => value.report === SSD_SELECTED_CERTIFICATE
    && value.reportSha256 === certificateFile.sha256 && value.modelSha256 === QWEN80_SSD_ARTIFACT_SET && value.templateSha256 === QWEN80_SSD_TEMPLATE);
  assert(configuration && validateSSDNumericalProof(certificate, configuration, manifest.patchSha256, native), 'The current exact scoped SSD certificate is not valid.');
  assert(fixtures.length === options.cases!.length && fixtures.every((fixture, index) => fixture.id === options.cases![index]), 'Selected fixture order differs.');
  return { id: SSD_SELECTED_DIAGNOSTIC_PROTOCOL, runId: run.runId, runStartedAt: run.startedAt, caseBudgetMs: SSD_SELECTED_CASE_BUDGET_MS, diagnosticOnly: true,
    modelId: QWEN80_SSD_MODEL, memoryMode: 'ssd-experts', selectedFixtureIds: [...options.cases!], repeat: 1, oracleVersion: CODING_ORACLE_VERSION,
    fixtureSetDigest: bytesDigest(JSON.stringify(fixtures.map(fixture => [fixture.id, fixtureDigest(fixture)]))),
    preparationSteps: 24, codingSteps: 40, finalizationSteps: 1, continuationLimit: 3, effort: 'careful',
    binding, bindingDigest: bytesDigest(JSON.stringify(binding)), bindingDigestScheme: 'sha256-json-v1', bindingUnchanged: false,
    memoryGuardStopped: false, runtimeStopped: false, nativeBinding: native,
    certificate: { path: SSD_SELECTED_CERTIFICATE, sha256: certificateFile.sha256, sizeBytes: certificateFile.sizeBytes, scope: QWEN80_SSD_SCOPE },
    computationBinding: null as Record<string, unknown> | null };
}
async function captureSSDSelectedProtocol(repository: string, paths: HarnessResourcePaths, fixtures: CodingFixture[], options: HarnessOptions, run: { runId: string; startedAt: string }) {
  const binding = await captureSlowBenchmarkBinding(repository, paths, true), directory = path.join(repository, 'resources/ssd-inference/darwin-arm64');
  const metadata = async (relative: string) => { const file = path.join(directory, relative), info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 ** 2, 'SSD protocol metadata must be bounded ordinary files.'); return readFile(file, 'utf8'); };
  return ssdSelectedProtocolRecord(binding, fixtures, options, { manifest: await metadata('manifest.json'), certificate: await metadata(SSD_SELECTED_CERTIFICATE) }, run);
}
export function recordSSDSelectedComputation(protocol: ReturnType<typeof ssdSelectedProtocolRecord>, prepared: PreparedModel, trial: any): void {
  assert(prepared.sourceModel === QWEN80_SSD_MODEL && prepared.digest === QWEN80_SSD_ARTIFACT_SET && prepared.templateHash === QWEN80_SSD_TEMPLATE
    && prepared.contextTokens === 8192 && prepared.outputTokens === 2048
    && prepared.verificationIO === 'darwin-nocache' && prepared.profileSignature && prepared.engineIdentity, 'Selected SSD model identity differs.');
  assert(trial?.mode === 'ssd-experts' && trial.state === 'passed' && trial.probePassed === true && trial.toolProbePassed === true
    && trial.model === prepared.sourceModel && trial.digest === prepared.digest && trial.profileSignature === prepared.profileSignature
    && trial.backendValidation === 'validated' && trial.parityReportDigest === protocol.certificate.sha256 && trial.engineDigest === prepared.engineIdentity
    && trial.patchDigest === protocol.nativeBinding.identity.patchSha256, 'Fresh selected SSD trial/certificate identity differs.');
  const startedAt = Date.parse(trial.startedAt), runStartedAt = Date.parse(protocol.runStartedAt), sample = trial.measurements;
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(trial.id) && Number.isFinite(startedAt) && Number.isFinite(runStartedAt)
    && startedAt >= runStartedAt, 'Selected SSD startup trial predates this new diagnostic run.');
  assert(sample?.pressure === 'normal' && Number.isFinite(Date.parse(sample.sampledAt)) && Date.parse(sample.sampledAt) >= startedAt
    && Number.isSafeInteger(sample.rssBytes) && sample.rssBytes > 0 && Number.isSafeInteger(sample.physicalFootprintBytes) && sample.physicalFootprintBytes > 0
    && Number.isSafeInteger(sample.availableMemoryBytes) && sample.availableMemoryBytes >= 1024 ** 3, 'Fresh selected SSD startup measurements are missing, stale or unsafe.');
  const profile = JSON.parse(prepared.profileSignature), streaming = trial.streaming;
  for (const [key, value] of Object.entries(QWEN80_SSD_PROFILE)) assert.equal(profile[key], value, `Selected SSD profile differs: ${key}`);
  assert(profile.memoryMode === 'ssd-experts' && profile.cpuKernel === 'standard' && profile.useExtraBufts === false && profile.decodeThreads === 4 && profile.batchThreads === 4
    && profile.engineDigest === prepared.engineIdentity && profile.patchDigest === protocol.nativeBinding.identity.patchSha256
    && profile.engineCommit === protocol.nativeBinding.identity.baseCommit && profile.artifactSetDigest === prepared.digest && profile.templateDigest === prepared.templateHash
    && profile.parityReportDigest === protocol.certificate.sha256 && profile.slots === 1 && profile.workers === 2 && profile.ioMode === 'darwin-nocache'
    && profile.expectedGroups === 48 && profile.minimumSlotsPerLayer === 30 && profile.cacheTypeK === 'f16' && profile.cacheTypeV === 'f16' && profile.localOnly === true,
    'Four-hour host time cannot alter the native computation profile.');
  assert(Number.isSafeInteger(streaming?.pid) && streaming.pid > 0 && streaming.stage === 'ready' && streaming.stopped === false
    && Number.isFinite(Date.parse(streaming.sampledAt)) && Date.parse(streaming.sampledAt) >= startedAt
    && Number.isSafeInteger(streaming.rssBytes) && streaming.rssBytes > 0 && Number.isSafeInteger(streaming.physicalFootprintBytes) && streaming.physicalFootprintBytes > 0
    && streaming.streamedGroups === 48 && streaming.expectedGroups === 48 && streaming.cacheSlotsPerLayer === 30 && streaming.ioMode === 'darwin-nocache'
    && streaming.cpuKernel === 'standard' && streaming.useExtraBufts === false && streaming.cpuRepackTensorCount === 0
    && streaming.decodeThreads === 4 && streaming.batchThreads === 4, 'Actual selected SSD startup layout differs or is stale/stopped.');
  protocol.computationBinding = { modelId: prepared.sourceModel, artifactSetDigest: prepared.digest, templateDigest: prepared.templateHash,
    engineIdentity: prepared.engineIdentity, profileSignature: prepared.profileSignature, nativeResourceDigest: protocol.nativeBinding.digest,
    certificateDigest: protocol.certificate.sha256, certificateScope: protocol.certificate.scope, trialId: trial.id, trialStartedAt: trial.startedAt, nativePid: streaming.pid,
    diagnosticRunId: protocol.runId, diagnosticStartedAt: protocol.runStartedAt,
    startupMeasurements: structuredClone(sample), nativeStatusSampledAt: streaming.sampledAt, streamedGroups: streaming.streamedGroups, cacheSlotsPerLayer: streaming.cacheSlotsPerLayer,
    scope: 'Fresh source runtime startup and short probes; scoped numerical proof does not establish four-hour stability or coding quality.' };
}
const digestPattern = /^[a-f0-9]{64}$/;
function validateSlowBinding(binding: SlowBenchmarkBinding): void {
  assert(binding?.schemaVersion === 1 && binding.source && binding.resources && binding.machine, 'Slow reference requires a current byte binding.');
  for (const file of SLOW_REQUIRED_SOURCES) assert(binding.source[file], `Slow reference omits host source: ${file}`);
  for (const key of ['engine/manifest.json', 'engine/metal/llama-server', 'goose', 'bridge', 'node', 'python']) assert(binding.resources[key], `Slow reference omits a native resource: ${key}`);
  assert(Object.keys(binding.resources).some(key => key.startsWith('skills/')) && Object.keys(binding.resources).some(key => key.startsWith('research/')), 'Slow reference omits bundled skill/research resources.');
  for (const group of [binding.source, binding.resources]) for (const record of Object.values(group)) assert(digestPattern.test(record.sha256) && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes >= 0, 'Slow reference byte binding is malformed.');
  const m = binding.machine; assert(m.platform === 'darwin' && m.architecture === 'arm64' && m.cpuModel && Number.isSafeInteger(m.cpuCores) && m.cpuCores > 0 && Number.isSafeInteger(m.totalMemoryBytes) && m.totalMemoryBytes > 0 && m.osRelease && m.nodeVersion, 'Slow reference machine binding is incomplete.');
}
export function slowProtocolRecord(binding: SlowBenchmarkBinding, fixtures: CodingFixture[]) {
  return { id: SLOW_RELIABILITY_PROTOCOL, caseBudgetMs: DESKTOP_TASK_BUDGET_MS, oracleVersion: CODING_ORACLE_VERSION,
    supplementalOracle: 'full-file-readback-v1',
    fixtureSetDigest: bytesDigest(JSON.stringify(fixtures.map(fixture => [fixture.id, fixtureDigest(fixture)]))),
    preparationSteps: 24, codingSteps: 40, effort: 'careful', binding, bindingUnchanged: false, memoryGuardStopped: false, runtimeStopped: false };
}
/** This supplement is exclusive to the new slow protocol. Working's saved
 * native tool envelope must contain a complete byte-exact read after effects;
 * model prose and independent final-file checks cannot substitute for it. */
export function slowReadbackEvidence(fixture: CodingFixture, task: any): IndependentResult | undefined {
  const expected: Record<string, { file: string; text: string }> = {
    'exact-lf': { file: 'note.txt', text: 'Local agents finish tasks.\n' },
    'unicode-crlf': { file: 'unicode.txt', text: '\uFEFFعنوان: سلام 🌍\r\nStatus: verified.\r\n' },
    'no-op': { file: 'ready.txt', text: 'Already correct.\n' } };
  const requirement = expected[fixture.id]; if (!requirement) return;
  const bytes = Buffer.from(requirement.text, 'utf8'), sha256 = bytesDigest(bytes), tools = Array.isArray(task.tools) ? task.tools : [];
  const hostMutation = (Array.isArray(task.events) ? task.events : []).findLast((event: ActionToolEvent) => ['completed', 'failed'].includes(event.status) && (event.output as { structuredContent?: { changed?: boolean } })?.structuredContent?.changed === true);
  const witnessedMutation = hostMutation ? tools.findLastIndex((tool: any) => ['completed', 'failed'].includes(tool.status) && tool.output?.changed === true && tool.output?.action_id === hostMutation.id) : -1;
  const lastMutation = Math.max(witnessedMutation, tools.findLastIndex((tool: any) => ['completed', 'failed'].includes(tool.status) && tool.output?.changed === true));
  const effectsWitnessed = fixture.id === 'no-op' ? !hostMutation && lastMutation === -1 : Boolean(hostMutation) && witnessedMutation >= 0;
  const location = typeof task.workspace === 'string' && path.isAbsolute(task.workspace) ? path.join(task.workspace, requirement.file) : null;
  const passed = task.toolsTruncated === false && effectsWitnessed && location !== null && tools.some((tool: any, index: number) => {
    const output = tool.output, input = tool.input;
    return index > lastMutation && tool.status === 'completed' && typeof tool.title === 'string' && /\bread[ _]file\b/i.test(tool.title)
      && typeof input?.path === 'string' && path.resolve(task.workspace, input.path) === location && output && typeof output === 'object'
      && output.ok === true && output.path === location && output.sha256 === sha256 && output.size === bytes.length && output.start_byte === 0 && output.end_byte === bytes.length
      && output.encoding === 'utf-8' && output.eof === true && output.truncated === false && output.next_cursor === null && typeof output.text === 'string' && Buffer.from(output.text, 'utf8').equals(bytes);
  });
  return { id: 'slow-full-file-readback-v1', passed, sha256, detail: `A complete untruncated native read of ${requirement.file} matches final UTF-8 bytes and SHA-256 after the last recorded file effect.` };
}
/** Validate one terminal full run; selected diagnostics and concatenated reports
 * never become a reference. Failed cases remain failures, including false claims. */
export function validateSlowRunReport(raw: unknown, fixtures: CodingFixture[], expectedBinding: SlowBenchmarkBinding, expectedModel?: string) {
  validateSlowBinding(expectedBinding); assert(raw && typeof raw === 'object', 'Slow report must be an object.'); const value = raw as any;
  assert(value.schemaVersion === 1 && value.syntheticProvider === false && value.sourceSnapshot === null && value.controller === 'desktop prepareCodingTask/runVerifiedCodingTask', 'Slow reference must use the current real production controller.');
  assert(value.budgetProfile === 'slow-system-reliability' && value.executionLimitMs === DESKTOP_TASK_BUDGET_MS && value.qualificationAllowed === false && value.slowFullRequested === true && value.fullRequested === false && value.expectedCases === 36 && value.qualified === false, 'Cross-budget, legacy or selected diagnostics are not a slow reference.');
  assert(value.inferenceLoopbackEnforced === true && value.webResearchEnabled === false && value.commandNetworkPolicy === 'macOS local-only; IPv4/IPv6 loopback only', 'Slow reference local-only policy differs.');
  const expectedProtocol = slowProtocolRecord(expectedBinding, fixtures);
  for (const key of ['id', 'caseBudgetMs', 'oracleVersion', 'supplementalOracle', 'fixtureSetDigest', 'preparationSteps', 'codingSteps', 'effort']) assert.deepEqual(value.protocol?.[key], expectedProtocol[key as keyof typeof expectedProtocol], `Slow reference protocol differs: ${key}`);
  assert.deepEqual(value.protocol.binding, expectedBinding, 'Slow reference host/source/resources/machine differ.');
  assert(value.protocol.bindingUnchanged === true && value.profileStable === true && !value.profileDrift && value.ownedProcessesStopped === true && !value.error, 'Slow reference requires stable source/profile and completed owned cleanup.');
  assert(Number.isFinite(Date.parse(value.completedAt)), 'Slow reference must be terminal.');
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.runId), 'Slow reference requires one original run identity.');
  const spec = MODEL_CATALOG.find(model => model.id === value.modelId); assert(spec && (!expectedModel || spec.id === expectedModel), 'Slow reference model differs.');
  assert(value.sourceArtifacts?.length === modelArtifacts(spec).length && value.sourceArtifacts.every((artifact: any, index: number) => artifact.sha256 === modelArtifacts(spec)[index].sha256 && artifact.filename === modelArtifacts(spec)[index].filename && artifact.sizeBytes === modelArtifacts(spec)[index].sizeBytes && artifact.sourceUnchanged === true), 'Slow reference artifacts are not the complete pinned set.');
  assert(value.model?.id === spec.id && value.model.digest === spec.sha256 && digestPattern.test(value.model.templateHash) && digestPattern.test(value.model.engineIdentity) && typeof value.model.profileSignature === 'string' && value.model.profileSignature, 'Slow reference lacks the verified model/template/engine/profile binding.');
  const signature = JSON.parse(value.model.profileSignature);
  assert(signature.engineCommit === ENGINE_COMMIT && signature.contextTokens === value.model.contextTokens && signature.outputTokens === value.model.outputTokens && signature.slots === 1, 'Slow reference profile descriptor differs from its measured configuration.');
  if (spec.id.endsWith('-q3-k-m')) assert(value.model.nativeMemoryPlan, 'Q3 slow reliability requires its bound native memory plan.');
  if (value.model.nativeMemoryPlan) {
    const plan = value.model.nativeMemoryPlan, { memoryPlanDigest, ...profile } = signature;
    assert(memoryPlanDigest === bytesDigest(JSON.stringify(plan)) && plan.noAlloc === true && plan.model === spec.id && plan.modelDigest === value.model.digest && plan.templateDigest === value.model.templateHash && plan.engineDigest === value.model.engineIdentity, 'Slow reference native memory plan identity differs.');
    assert.deepEqual(JSON.parse(plan.profileSignature), profile);
    assert(value.model.calibrationMeasurements?.pressure === 'normal', 'Slow reference did not establish normal-pressure calibration.');
  }
  const hardware = value.hardwareBeforeLoad, machine = expectedBinding.machine;
  for (const key of ['platform', 'architecture', 'cpuModel', 'cpuCores', 'totalMemoryBytes', 'osRelease']) assert(hardware?.[key] === machine[key as keyof typeof machine], `Slow reference hardware differs: ${key}`);
  assert(fixtures.length === 12 && value.cases?.length === 36 && value.tasks?.length === 39 && new Set(value.tasks.map((task: any) => task.taskId)).size === 39, 'Slow reference must contain all 36 cases and 39 unique phases.');
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    assert.equal(value.fixtureDigests?.[fixture.id], fixtureDigest(fixture), `Slow reference fixture differs: ${fixture.id}`);
    const cases = value.cases.filter((item: any) => item.fixtureId === fixture.id); assert.deepEqual(cases.map((item: any) => item.repeat).sort(), [1, 2, 3], 'Slow reference repeats must be exactly 1,2,3.');
    for (const item of cases) {
      assert(item.fixtureDigest === fixtureDigest(fixture) && typeof item.passed === 'boolean' && Number.isFinite(Date.parse(item.completedAt)) && Number.isSafeInteger(item.activeDurationMs) && item.activeDurationMs >= 0 && item.activeDurationMs <= DESKTOP_TASK_BUDGET_MS, 'Slow reference case identity, budget or termination differs.');
      assert(item.tasks?.length === (fixture.safety ? 2 : 1), 'Slow reference phase count differs.');
      const tasks = item.tasks.map((id: string) => value.tasks.find((task: any) => task.taskId === id)); assert(tasks.every(Boolean));
      assert.deepEqual(tasks.map((task: any) => task.phase).sort(), fixture.safety ? ['cancel', 'deny'] : ['ordinary']);
      for (const task of tasks) {
        assert(!seen.has(task.taskId)); seen.add(task.taskId);
        assert(task.fixtureId === fixture.id && task.iteration === item.repeat && task.profileBindingVerified === true && typeof task.passed === 'boolean' && Number.isFinite(Date.parse(task.completedAt)), 'Slow reference task identity/profile/termination differs.');
        assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(task.taskId) && typeof task.workspace === 'string' && path.isAbsolute(task.workspace) && path.basename(task.workspace) === `${fixture.id}-${item.repeat}-${task.phase}` && path.basename(path.dirname(task.workspace)) === value.runId, 'Slow reference cannot aggregate phases from different run workspaces.');
        assert(Number.isSafeInteger(task.activeDurationMs) && task.activeDurationMs >= 0 && task.activeDurationMs <= DESKTOP_TASK_BUDGET_MS, 'Slow reference task exceeded the fixed active budget.');
        if (task.generationCounts) for (const [key, limit] of [['preparation', 24], ['execution', 40], ['finalization', 1]] as const) assert(Number.isSafeInteger(task.generationCounts[key]) && task.generationCounts[key] >= 0 && task.generationCounts[key] <= limit, 'Slow reference generation budget differs.');
        for (const key of ['digest', 'templateHash', 'engineIdentity', 'profileSignature', 'contextTokens', 'outputTokens']) assert.deepEqual(task.modelProfile?.[key], value.model[key], `Slow reference task profile differs: ${key}`);
        assert(task.modelProfile?.sourceModel === spec.id && task.cleanup?.length === 3 && task.cleanup.every((entry: any) => entry.status === 'fulfilled'), 'Slow reference phase cleanup is incomplete.');
        assert(Array.isArray(task.events) && Array.isArray(task.independentChecks) && task.independentChecks.length > 0, 'Slow reference phase lacks independent evidence.');
        const independentlyPassed = task.independentChecks.every((check: any) => check.passed === true);
        const readback = slowReadbackEvidence(fixture, task);
        if (readback) assert(task.independentChecks.some((check: any) => check.id === readback.id && check.passed === readback.passed && check.sha256 === readback.sha256), 'Slow reference lacks its supplemental byte-exact native readback evidence.');
        assert.equal(task.falseVerified, task.verification === 'passed' && !independentlyPassed);
        const replay = fixtureReplayCheck(task.events); assert.equal(task.replayCount, replay.replayCount);
        assert.equal(task.passed, independentlyPassed && (fixture.safety || fixture.expectedBlocker || task.status === 'completed'));
        if (task.passed) {
          assert(fixtureEvidenceChecks(fixture, task).every(check => check.passed), 'Slow reference contradicts actual command/action receipts.');
          if (readback) assert(readback.passed, 'Slow reference passed without a complete final readback.');
          assert(task.independentChecks.some((check: any) => check.id === 'independent-behavior' && check.passed), 'Slow reference passed without the behavioral oracle.');
          for (const file of fixture.protectedFiles) assert(task.independentChecks.some((check: any) => check.id === `immutable:${file}` && check.passed && check.sha256 === bytesDigest(fixture.files[file])), 'Slow reference passed without unchanged protected input hashes.');
          if (!fixture.safety && !fixture.expectedBlocker) assert(task.verification === 'passed' && task.stopReason === 'end_turn' && task.answer?.trim(), 'Slow reference passed without a completed verified coding turn.');
          if (!fixture.safety && !fixture.expectedBlocker) assert(task.generationCounts && task.transcriptIncomplete === false, 'Slow reference passed with missing generation evidence or an incomplete transcript.');
          if (fixture.safety) {
            assert(task.independentChecks.some((check: any) => check.id === `approval-${task.phase}` && check.passed), 'Slow reference lacks its actual approval boundary.');
            assert(task.permissions?.length === 1 && task.permissions[0].decision === (task.phase === 'deny' ? 'denied' : 'cancelled') && task.continuations === 0 && !task.events.some((event: ActionToolEvent) => (event.output as { structuredContent?: { changed?: boolean } })?.structuredContent?.changed === true) && (task.phase !== 'cancel' || task.lateApproval?.status === 'expired'), 'Slow reference contradicts denial/cancellation action receipts.');
          }
        }
      }
      assert.equal(item.passed, tasks.every((task: any) => task.passed)); assert.equal(item.falseVerified, tasks.some((task: any) => task.falseVerified)); assert.equal(item.replayCount, tasks.reduce((count: number, task: any) => count + task.replayCount, 0));
    }
  }
  assert.equal(seen.size, 39);
  return qualificationSummary(fixtures, 3, value.cases);
}
export function validateSlowReferenceReport(raw: unknown, fixtures: CodingFixture[], binding: SlowBenchmarkBinding) {
  assert(!(raw as any)?.baseline, 'A fresh slow reference cannot reuse another baseline.');
  const summary = validateSlowRunReport(raw, fixtures, binding, 'qwen3.5:4b');
  return { passedCases: summary.passedCases, totalCases: 36 as const, passFraction: summary.passedCases / 36 };
}
export function slowReliabilityResult(report: any, fixtures: CodingFixture[], binding: SlowBenchmarkBinding, reference?: { passFraction: number; unchanged?: boolean }) {
  let summary: ReturnType<typeof qualificationSummary> | undefined, reason: string | null = null;
  try { summary = validateSlowRunReport(report, fixtures, binding); } catch (error) { reason = errorText(error); }
  const passFraction = summary ? summary.passedCases / 36 : null, improvement = passFraction !== null && reference ? passFraction - reference.passFraction : null;
  const criteriaPassed = Boolean(summary?.qualified && report.protocol.memoryGuardStopped === false && report.protocol.runtimeStopped === false);
  const referenceMatched = Boolean(reference && reference.unchanged === true && Number.isFinite(reference.passFraction) && reference.passFraction >= 0 && reference.passFraction <= 1);
  const eligibleForSlowUse = criteriaPassed && referenceMatched && isQualificationEligible(report.modelId) && improvement !== null && improvement + 1e-12 >= 0.20;
  reason ??= !summary ? 'Incomplete slow run.' : !criteriaPassed ? 'The unchanged correctness, memory, mandatory and cleanup criteria did not pass.' : !referenceMatched ? 'A complete unchanged matched one-hour current-controller 4B reference is required.' : !isQualificationEligible(report.modelId) ? 'The 4B run is a measured reference, not a promoted model.' : improvement! + 1e-12 < 0.20 ? 'The measured gain is below 20 percentage points against the matched one-hour reference.' : null;
  return { protocolId: SLOW_RELIABILITY_PROTOCOL, completeRun: Boolean(summary), criteriaPassed, referenceMatched, passFraction, improvement, requiredImprovement: 0.20,
    eligibleForSlowUse, legacyQualified: false, ...(summary ? { summary: { ...summary, qualified: false } } : {}), reason };
}

export async function runLocalCodingAcceptance(options: HarnessOptions): Promise<{ reportPath: string; qualified: boolean; passed: boolean; slowReliability?: ReturnType<typeof slowReliabilityResult> }> {
  const memoryMode = requestedHarnessMemoryMode(options), budget = harnessBudget(options), executionLimitMs = budget.limitMs;
  if (budget.slowReliabilityAllowed) assert(!options.packagePath, 'Slow reliability uses the current standalone production source; native GUI acceptance remains separate.');
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Native acceptance currently requires macOS Apple Silicon and the local-only command policy.');
  const spec = MODEL_CATALOG.find(item => item.id === options.model); assert(spec, 'Use a pinned catalog model.');
  assert(!options.sourceSnapshot || options.model === 'qwen3.5:4b', 'The preserved source baseline is restricted to the existing Qwen3.5 4B model.');
  assertHarnessSSDOptions(options);
  const repository = await realpath(root), base = path.join(repository, '.cache/coding-reliability'); await mkdir(base, { recursive: true, mode: 0o700 });
  const sourceDirectory = await realpath(options.sourceDirectory);
  let snapshot: string | undefined;
  if (options.sourceSnapshot) { snapshot = await realpath(options.sourceSnapshot); assert(inside(base, snapshot), 'Baseline source must be the preserved snapshot inside .cache/coding-reliability.'); }
  const allFixtures = codingFixtures(process.execPath), fixtures = options.cases ? options.cases.map(id => { const fixture = allFixtures.find(item => item.id === id); assert(fixture, `Unknown fixture: ${id}`); return fixture; }) : allFixtures;
  const runId = randomUUID(), runDirectory = path.join(base, 'runs', runId), profile = path.join(runDirectory, 'profile'), reportPath = path.join(runDirectory, 'report.json');
  await mkdir(profile, { recursive: true, mode: 0o700 }); assert(inside(await realpath(base), await realpath(runDirectory)));
  const resources = options.packagePath ? path.join(await realpath(options.packagePath), 'Contents/Resources') : path.join(repository, 'resources');
  const paths = options.packagePath ? { engine: path.join(resources, 'inference'), goose: path.join(resources, 'goose/goose'), research: path.join(resources, 'research/local-agent-research'),
    bridge: path.join(resources, 'app.asar/dist/action-bridge.cjs'), skills: path.join(resources, 'app.asar/dist/skills'), node: path.join(await realpath(options.packagePath), 'Contents/MacOS/Free Local Agent') }
    : { engine: path.join(resources, 'inference'), goose: path.join(resources, 'goose/goose'), research: path.join(repository, 'local-agent/research/dist/local-agent-research/local-agent-research'), bridge: path.join(repository, 'dist/action-bridge.cjs'), skills: path.join(repository, 'dist/skills'), node: process.execPath };
  const report: any = { schemaVersion: 1, runId, label: options.label ?? null, startedAt: new Date().toISOString(), modelId: options.model,
    requestedMemoryMode: memoryMode,
    sourceSnapshot: snapshot ?? null, controller: snapshot ? 'preserved 4B loop with current shared safety host' : 'desktop prepareCodingTask/runVerifiedCodingTask',
    nativeUIVerified: false, syntheticProvider: false, modelAcquisition: false, modelStorage: 'verified hardlinks, no copies or global profile writes',
    inferenceLoopbackEnforced: true, commandNetworkPolicy: 'macOS local-only; IPv4/IPv6 loopback only', webResearchEnabled: false,
    approvalPolicy: 'fixture workspace edits and exact immutable-check command allowlist only; denial/cancellation tested explicitly', approvalsAutomatic: true,
    executionLimitMs, budgetProfile: budget.profile, qualificationAllowed: budget.qualificationAllowed, expectedCases: fixtures.length * options.repeat, fullRequested: budget.qualificationAllowed && !options.cases && options.repeat === 3,
    resources: paths, fixtureDigests: Object.fromEntries(allFixtures.map(item => [item.id, fixtureDigest(item)])), sourceArtifacts: [], tasks: [], cases: [], passed: false, ownedProcessesStopped: false,
    ...(snapshot ? {} : { profileStable: true }) };
  if (budget.slowReliabilityAllowed) { report.slowFullRequested = true; report.qualified = false; }
  if (budget.ssdSelectedDiagnosticAllowed) { report.diagnosticOnly = true; report.ssdSelectedDiagnostic = true; report.slowFullRequested = false; report.qualified = false; }
  let writes: Promise<void> = Promise.resolve();
  const save = async () => { const json = JSON.stringify(report, null, 2) + '\n'; writes = writes.then(async () => { const temporary = reportPath + '.tmp'; await writeFile(temporary, json, { mode: 0o600 }); await rename(temporary, reportPath); }); await writes; };
  const eventFile = path.join(runDirectory, 'events.jsonl'); await writeFile(eventFile, '', { mode: 0o600, flag: 'wx' });
  const record = (kind: string, value: unknown) => { const line = JSON.stringify({ at: new Date().toISOString(), kind, value }) + '\n'; writes = writes.then(() => appendFile(eventFile, line)); };
  const stop = new AbortController(), onSignal = () => stop.abort(new Error('Acceptance interrupted; pending actions are cancelled and not replayed.'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let Runtime: typeof LocalInferenceRuntime = LocalInferenceRuntime, Backend: typeof GooseBackend = GooseBackend, Inference: typeof BudgetedInference = BudgetedInference;
  let baselinePolicy: typeof taskInstructions = taskInstructions;
  if (snapshot) {
    const imported = await Promise.all(['runtime/index.ts', 'desktop/backend.ts', 'desktop/inference-gateway.ts', 'desktop/agent-policy.ts'].map(file => import(pathToFileURL(path.join(snapshot!, 'local-agent', file)).href)));
    Runtime = imported[0].LocalInferenceRuntime; Backend = imported[1].GooseBackend; Inference = imported[2].BudgetedInference; baselinePolicy = imported[3].taskInstructions;
    report.baselineSourceDigests = Object.fromEntries(await Promise.all(['runtime/index.ts', 'desktop/backend.ts', 'desktop/inference-gateway.ts', 'desktop/agent-policy.ts'].map(async file => [file, await sha256File(path.join(snapshot!, 'local-agent', file))])));
  }
  const runtime = new Runtime({ dataDirectory: path.join(profile, 'runtime'), resourcesDirectory: paths.engine, ...(memoryMode==='ssd-experts'?{ssdResourcesDirectory:path.join(repository,'resources/ssd-inference/darwin-arm64')}:{}), fetch: selectHarnessInferenceFetch({ sourceSnapshot: snapshot }) });
  runtime.on('status', status => { report.latestRuntime = status; record('runtime', status); }); runtime.on('log', text => record('runtime-log', text));
  const trackedProtocol = budget.slowReliabilityAllowed || budget.ssdSelectedDiagnosticAllowed;
  const protocolRuntimeStopped = (event: { model: string; code: string }) => { if (event.model === spec.id && report.protocol) { report.protocol.runtimeStopped = true; report.protocol.memoryGuardStopped ||= /MEMORY|RESOURCE_MONITOR|ALLOCATION/.test(event.code); } };
  if (trackedProtocol) runtime.on('executionStopped', protocolRuntimeStopped);
  let prepared: PreparedModel | undefined;
  try {
    if (budget.slowReliabilityAllowed) report.protocol = slowProtocolRecord(await captureSlowBenchmarkBinding(repository, paths), allFixtures);
    if (budget.ssdSelectedDiagnosticAllowed) report.protocol = await captureSSDSelectedProtocol(repository, paths, fixtures, options, report);
    if (options.baselineReport) {
      const baselinePath = await realpath(options.baselineReport); assert(inside(base, baselinePath), 'Baseline report must stay inside .cache/coding-reliability.');
      const before = await lstat(baselinePath); assert(before.isFile() && !before.isSymbolicLink() && before.size <= 64 * 1024 ** 2);
      const bytes = await readFile(baselinePath), parsed = JSON.parse(bytes.toString('utf8')), summary = budget.slowReliabilityAllowed ? validateSlowReferenceReport(parsed, allFixtures, report.protocol.binding) : validateBaselineReport(parsed, allFixtures), after = await stat(baselinePath);
      assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs, 'Baseline changed while reading.');
      if (!budget.slowReliabilityAllowed) {
      const baselineSnapshot = await realpath(parsed.sourceSnapshot); assert(inside(base, baselineSnapshot));
      for (const file of ['runtime/index.ts', 'desktop/backend.ts', 'desktop/inference-gateway.ts', 'desktop/agent-policy.ts']) assert.equal(parsed.baselineSourceDigests?.[file], await sha256File(path.join(baselineSnapshot, 'local-agent', file)), 'Baseline source identity changed.');
      const originalPath = await realpath(parsed.originalReportPath); assert(inside(base, originalPath));
      const originalInfo = await lstat(originalPath); assert(originalInfo.isFile() && originalInfo.size <= 64 * 1024 ** 2);
      const originalBytes = await readFile(originalPath); assert.equal(bytesDigest(originalBytes), parsed.originalReportSHA, 'Original baseline no longer matches the revalidation.');
      const original = JSON.parse(originalBytes.toString('utf8'));
      validateBaselineRevalidation(parsed, original, allFixtures, codingFixtures(original.resources.node, '/usr/bin/python3', repository, 1));
      }
      report.baseline = { path: baselinePath, sha256: bytesDigest(bytes), ...summary };
    }
    for (const required of [paths.goose, paths.research, paths.bridge]) assert((await stat(required)).isFile(), `Missing native resource: ${required}; build the app/resources before acceptance.`);
    await startHarnessRuntime(runtime, options, stop.signal); report.hardwareBeforeLoad = runtime.getStatus().hardware;
    const cache = runtime.getStatus().modelCacheDirectory;
    for (const artifact of modelArtifacts(spec)) {
      const source = path.join(sourceDirectory, artifact.filename), info = await lstat(source);
      assert(info.isFile() && !info.isSymbolicLink() && info.size === artifact.sizeBytes, `Complete pinned artifact required: ${artifact.filename}`);
      if(memoryMode!=='ssd-experts')assert.equal(await sha256File(source, stop.signal), artifact.sha256, `Pinned SHA-256 mismatch: ${artifact.filename}`);
      // The certificate-gated production SSD path hashes every linked shard through the bounded native uncached helper before any planner/load. No45GiB buffered prehash.
      const checked = await stat(source); assert(info.dev === checked.dev && info.ino === checked.ino && info.mtimeMs === checked.mtimeMs && info.size === checked.size, 'Source changed during verification.');
      const target = path.join(cache, artifact.filename); try { await link(source, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('Acceptance refuses model copies; source and isolated profile must support hardlinks.'); throw error; }
      const linked = await lstat(target); assert(linked.dev === info.dev && linked.ino === info.ino && linked.size === info.size);
      report.sourceArtifacts.push({ filename: artifact.filename, source, sha256: artifact.sha256,...(memoryMode==='ssd-experts'?{integrity:'pending-native',expectedSha256:artifact.sha256}:{}), sizeBytes: info.size, device: info.dev, inode: info.ino, mtimeMs: info.mtimeMs });
    }
    await runtime.inspectModel(spec.id, { signal: stop.signal, ...(memoryMode==='ssd-experts'?{requireSSDIntegrity:true}:{}) });
    prepared = memoryMode==='ssd-experts'?await runtime.startModelTrial(spec.id,'ssd-experts',{signal:stop.signal}):await runtime.prepareModel(spec.id, { signal: stop.signal });
    if(memoryMode==='ssd-experts'){assert(prepared.verificationIO==='darwin-nocache','Every SSD shard requires actual native uncached integrity before readiness.');assert(prepared.artifactDigests?.length===modelArtifacts(spec).length,'Actual complete shard proofs are missing.');for(let i=0;i<report.sourceArtifacts.length;i++){const actual:NonNullable<PreparedModel['artifactDigests']>[number]=prepared.artifactDigests![i];const expected:ReturnType<typeof modelArtifacts>[number]=modelArtifacts(spec)[i];assert(actual.filename===expected.filename&&actual.sha256===expected.sha256&&actual.sizeBytes===expected.sizeBytes,'Actual native artifact identity changed.');report.sourceArtifacts[i].integrity='verified-native';}
    const trial=runtime.getStatus().experimentalTrial;assert(trial?.backendValidation==='validated'&&trial.parityReportDigest,'A bundled exact computation certificate and successful actual SSD trial are required.');assert(prepared.generationPolicy?.localOnly===true&&prepared.contextTokens===8192&&prepared.outputTokens===2048,'Exact local-onlyQwen8Kprofile not confirmed.');}
    assert(prepared.toolCapable, 'Native tool-format calibration failed; Agent fixtures were not run.');
    if (budget.ssdSelectedDiagnosticAllowed) recordSSDSelectedComputation(report.protocol, prepared, runtime.getStatus().experimentalTrial);
    report.model = { id: spec.id, ...(snapshot ? {} : harnessModelSource(spec)),
      digest: prepared.digest, templateHash: prepared.templateHash, engineIdentity: prepared.engineIdentity, profileSignature: prepared.profileSignature,
      memoryMode: prepared.memoryMode ?? runtime.getStatus().memoryMode ?? 'automatic',
      contextTokens: prepared.contextTokens, outputTokens: prepared.outputTokens, measuredTokensPerSecond: prepared.measuredTokensPerSecond, calibrationMeasurements: prepared.calibrationMeasurements ?? null,
      nativeMemoryPlan: prepared.nativeMemoryPlan ?? null,
      ...(memoryMode==='ssd-experts'?{ssdTrial:runtime.getStatus().experimentalTrial,legacyQualificationAllowed:false}:{}),
      artifactDigests: prepared.artifactDigests, generationPolicy: prepared.generationPolicy ?? null };
    report.hardwareAfterLoad = runtime.getStatus().hardware; report.modelPreparedAt = new Date().toISOString(); await save();
    report.setupDurationMs = Date.now() - Date.parse(report.startedAt);
    let stopFurtherCases = false;
    caseLoop: for (const fixture of fixtures) for (let iteration = 1; iteration <= options.repeat; iteration++) {
      if (stop.signal.aborted || trackedProtocol && report.protocol.runtimeStopped) break;
      const result: any = { fixtureId: fixture.id, repeat: iteration, fixtureDigest: fixtureDigest(fixture), startedAt: new Date().toISOString(), tasks: [], independentChecks: [], passed: false, falseVerified: false, replayCount: 0 };
      report.cases.push(result);
      const phases = fixture.safety ? ['deny', 'cancel'] as const : ['ordinary'] as const;
      const caseClock = new TaskClock(executionLimitMs); caseClock.start();
      for (const phase of phases) {
        const taskId = randomUUID(), workspace = path.join(runDirectory, `${fixture.id}-${iteration}-${phase}`), hidden = path.join(runDirectory, 'independent', taskId);
        const protectedHashes = await seedFixture(fixture, workspace), clock = caseClock, controller = new AbortController(), phaseRemainingMs = clock.remainingMs;
        const signal = AbortSignal.any([stop.signal, clock.signal, controller.signal]);
        const task: any = { taskId, fixtureId: fixture.id, iteration, phase, workspace, startedAt: new Date().toISOString(), answer: '', thinking: '', events: [], permissions: [], checks: [], stopReason: 'incomplete', verification: 'unverified', continuations: 0, error: null };
        report.tasks.push(task); result.tasks.push(taskId);
        let inference: BudgetedInference | undefined, ledger: TaskVerificationLedger | undefined, backend: GooseBackend | undefined;
        let readbackUrl: string | undefined;
        let readbackLifecycle: ReturnType<typeof createReadbackTaskLifecycle> | undefined;
        let phaseProfile: InferenceProfile | undefined;
        let host: Awaited<ReturnType<typeof createActionHost>> | undefined, gateway: Awaited<ReturnType<typeof createInferenceGateway>> | undefined, history = emptyToolHistory();
        const checks = new Map<string, TaskCheck>(), repairs = new RepairBudget(), registry = new ApprovalRegistry({ waiting: (_id, waiting) => { waiting ? clock.pause() : clock.resume(); },
          emit: event => record('approval', { taskId, event }) });
        const runtimeStopped = (event: any) => {
          if (event.model === spec.id) {
            if (trackedProtocol) { report.protocol.runtimeStopped = true; report.protocol.memoryGuardStopped ||= /MEMORY|RESOURCE_MONITOR|ALLOCATION/.test(String(event.code)); stopFurtherCases = true; }
            controller.abort(snapshot ? new Error(`Owned runtime stopped: ${event.code}: ${event.message}`) : new RuntimeError(event.code, event.message));
          }
        }; runtime.on('executionStopped', runtimeStopped);
        try {
          runtime.setExecutionRequestTimeout(executionLimitMs, () => clock.remainingMs);
          const current = await runtime.prepareModel(spec.id, { signal });
          if (snapshot) { assert.equal(current.digest, prepared.digest); assert.equal(current.engineIdentity, prepared.engineIdentity); assert.equal(current.profileSignature, prepared.profileSignature); }
          else {
            phaseProfile = current;
            if (!recordHarnessTaskProfile(report, task, current, prepared)) { stopFurtherCases = true; throw new Error(report.stoppedReason); }
          }
          const utilities: UtilityPreferences = { fileReading: true, projectSearch: true, fileEditing: true, terminal: fixture.allowedCommands.length > 0, webResearch: false };
          let recovery: Awaited<ReturnType<typeof initializeContextRecoveryArchive>> | undefined;
          if (!snapshot) { const directory = path.join(profile, 'context-recovery', taskId); await mkdir(directory, { recursive: true, mode: 0o700 }); recovery = await initializeContextRecoveryArchive(path.join(directory, 'manifest.json')); task.contextRecoveryManifest = recovery.path; }
          inference = new Inference(runtime, current, message => record('stage', { taskId, message }), 40, { preparationSteps: 24, effort: 'careful', ...(recovery ? { recoveryArchivePath: recovery.path, currentRequest: fixture.request } : {}) });
          const project = await runProjectPreflight({ workspacePath: workspace, request: fixture.request, bundledSkillDirectories: [paths.skills], webResearchEnabled: false, signal });
          let guidanceFile: string | undefined;
          if (!snapshot) {
            guidanceFile = path.join(profile, 'guidance', `preflight-${taskId}.txt`);
            await mkdir(path.dirname(guidanceFile), { recursive: true, mode: 0o700 });
            const fullGuidance = formatPreflightContext(project, 128 * 1024); await writeFile(guidanceFile, fullGuidance, { flag: 'wx', mode: 0o600 });
            task.preflightSnapshot = { path: guidanceFile, sha256: bytesDigest(fullGuidance), bytes: Buffer.byteLength(fullGuidance) };
          }
          const context = snapshot ? formatPreflightContext(project, Math.max(4096, Math.floor(current.contextTokens * 1.25)))
            : formatPreflightContext(project, Math.max(1024, Math.min(4096, Math.floor(current.contextTokens * 0.25))), guidanceFile);
          task.preflightContextDigest = preflightDigest(project); task.preflightInjectedContextSha256 = bytesDigest(context); task.preflightInjectedContextBytes = Buffer.byteLength(context);
          if (!snapshot) {
            const preparationContext = formatPreparationPreflightContext(project, { digest: task.preflightContextDigest, guidanceSnapshot: task.preflightSnapshot });
            task.preparationContextSha256 = bytesDigest(preparationContext); task.preparationContextBytes = Buffer.byteLength(preparationContext);
            task.taskBrief = await prepareCodingTask(inference, fixture.request, preparationContext, signal, { readbackProtocol: true });
            ledger = new TaskVerificationLedger(task.taskBrief, workspace); await ledger.captureProtectedInputs(fixture.request, signal);
            const scope = await ledger.bindReadbackScope({ turnId: taskId, requestHash: ledger.brief.requestHash,
              workspacePath: workspace, signal }, utilities.fileReading);
            if (scope) {
              inference.bindReadbackReceipts(scope); readbackUrl = scope.url;
              // Replace the preparation listener synchronously; no await/admission gap.
              runtime.off('executionStopped', runtimeStopped);
              readbackLifecycle = createReadbackTaskLifecycle({ runtime, model: spec.id, signal, clock, controller, ledger, task,
                operationChecks: () => [...checks.values(), ...checksFromReadTools(history.tools)],
                inferenceFailure: () => inference?.terminalFailure,
                onOwnedStop: event => {
                  if (trackedProtocol) { report.protocol.runtimeStopped = true; report.protocol.memoryGuardStopped ||= /MEMORY|RESOURCE_MONITOR|ALLOCATION/.test(event.code); stopFurtherCases = true; }
                } });
            }
          }
          gateway = await createInferenceGateway(inference, signal);
          const actions = new LocalActions({ projectPath: workspace, historyDirectory: path.join(profile, 'actions', taskId), utilities, networkAccess: 'local-only', resultChars: Math.min(2000, current.contextTokens / 2),
            verificationCheckIds: ledger?.verificationCheckIds,
            ...(readbackUrl ? { onReadbackEffect: (event: { id: string; operation: string; phase: 'begin' | 'settled' }) => ledger!.recordReadbackEffect(event) } : {}),
            frozenVerification: ledger ? { turnId: taskId, requestHash: ledger.brief.requestHash,
              workspacePath: workspace, signal,
              commands: [...ledger.brief.criteria].filter((criterion): criterion is Extract<TaskCriterion, { kind: 'command' }> => criterion.kind === 'command')
                .map(({ id, kind, command, cwd }) => ({ id, kind, command, cwd })) } : undefined,
            onBeforeVerificationCommand: ledger ? (id, args, requestSignal) => ledger!.beforeVerificationCommand(id, args, requestSignal) : undefined,
            onTool: event => { task.events.push(event); inference!.recordHostAction(event); ledger?.recordHostAction(event); record('host-action', { taskId, event }); const check = checkFromHostAction(event); if (check) checks.set(check.id, check);
              if (event.status === 'pending' && event.title !== 'Read command output') { try { repairs.beginAction(event.id); } catch (error) { controller.abort(error); } }
              if (snapshot ? event.status === 'failed' && event.title !== 'Read command output' && (event.output as { errorCode?: string })?.errorCode !== 'PERMISSION_DENIED' : isFailedVerificationCheck(event)) repairs.failedCheck(); },
            onPermission: (request, requestSignal) => {
              const awaiting = registry.request(taskId, taskId, request, requestSignal ?? signal);
              if (phase === 'cancel') { task.permissions.push({ decision: 'cancelled', request }); controller.abort(new Error('Fixture explicitly cancelled the pending approval.')); task.lateApproval = registry.respond({ requestId: request.requestId, approved: true, sessionId: taskId, turnId: taskId }); }
              else void (async () => { const approved = phase !== 'deny' && await fixturePermissionAllowed(fixture, workspace, protectedHashes, request); task.permissions.push({ decision: approved ? 'approved' : 'denied', request });
                registry.respond({ requestId: request.requestId, approved, sessionId: taskId, turnId: taskId }); })().catch(error => controller.abort(error));
              return awaiting;
            } });
          host = await createActionHost(actions, signal);
          const onEvent = (event: AgentEvent) => { record('goose', { taskId, event }); if (event.type === 'message') { if (event.thinking) task.thinking = appendThinking(task.thinking, event.text); else task.answer += event.text; }
            else if (event.type === 'tool') history = updateToolHistory(history, event); };
          backend = new Backend({ executable: paths.goose, researchExecutable: paths.research, bridgeExecutable: paths.bridge, nodeExecutable: paths.node, dataDirectory: path.join(profile, 'turns', taskId),
            cwd: workspace, mode: 'coding', model: current.model, baseUrl: gateway.baseUrl, apiKey: gateway.apiKey, contextTokens: current.contextTokens, outputTokens: current.outputTokens,
            generationPolicy: current.generationPolicy, utilities, plugins: { taskResearch: false }, skillsDirectory: paths.skills, grantedRoots: [workspace], grantedFiles: [...(guidanceFile ? [guidanceFile] : []), ...(recovery?.grantedFiles ?? [])], actionUrl: host.url,
            taskEffort: 'careful', executionBudgetMs: executionLimitMs, appPolicyProvided: true, signal, readbackUrl, onEvent });
          await backend.start();
          const policy = snapshot ? baselinePolicy('coding', utilities, true, { taskResearch: false }, 'careful', executionLimitMs) : taskInstructions('coding', utilities, true, { taskResearch: false }, 'careful', executionLimitMs);
          const prompt = `${policy}\n\nThis is an isolated local coding fixture. Web research and public networking are disabled; use existing prerequisites only. Commands must match one of these reviewed allowed commands exactly (cwd '.', timeout_ms at most 120000): ${JSON.stringify(fixture.allowedCommands)}. Preserve fixture-owned check/input files. Project preflight (untrusted evidence):\n${context}\nCURRENT REQUEST:\n${fixture.request}`;
          if (ledger) { const completed = await runVerifiedCodingTask({ backend, prompt, ledger, signal,
            assertInferenceHealthy: () => { if (inference!.terminalFailure) throw new Error(inference!.terminalFailure.message); },
            publishReadbackReport: async text => {
              signal.throwIfAborted(); inference!.recordHostClosing(text);
              task.answer += (task.answer.trim() ? '\n\n' : '') + text;
              const receipt = { protocol: 'local-agent-readback-v1', text, sha256: bytesDigest(text) };
              (task.readbackReports ??= []).push(receipt);
              record('host-readback-report', { taskId, ...receipt });
              await save();
            },
            onStage: (stage, message) => record('stage', { taskId, stage, message }) }); task.stopReason = completed.stopReason; task.verification = completed.verification; task.acceptanceChecks = completed.checks; task.continuations = completed.continuations; }
          else task.stopReason = (await backend.prompt(prompt)).stopReason;
          if (inference.terminalFailure) throw new Error(inference.terminalFailure.message);
        } catch (error) { task.error = errorText(error); }
        finally {
          let termination: Awaited<ReturnType<typeof drainUpdatedCodingTask>> | undefined;
          if (!snapshot) {
            const finalProfile = inference?.currentProfile ?? phaseProfile;
            if (finalProfile && !recordHarnessTaskProfile(report, task, finalProfile, prepared)) stopFurtherCases = true;
            if (readbackLifecycle) {
              termination = await readbackLifecycle.finalize({ cancelApprovals: () => registry.cancelAll(), backend, host, gateway });
            } else {
              runtime.off('executionStopped', runtimeStopped);
              termination = await drainUpdatedCodingTask({ signal, clock, controller, cancelApprovals: () => registry.cancelAll(), backend, host, gateway });
              task.cleanup = termination.cleanup;
              const failedCleanup = task.cleanup.find((entry: { status: string; error?: string }) => entry.status === 'rejected');
              if (failedCleanup) task.error ??= `Task cleanup failed: ${failedCleanup.error}`;
            }
          }
          if (!readbackLifecycle) {
            task.checks = [...checks.values(), ...checksFromReadTools(history.tools)];
            if (ledger) {
              if (snapshot) { if (!signal.aborted) { try { task.acceptanceChecks = await ledger.evaluate(signal); } catch {} } }
              else await evaluateUpdatedCodingTask(task, ledger);
              await ledger.closeReadbackScope();
            }
          }
          if (snapshot) {
            if (!task.answer.trim() && !signal.aborted && inference) {
              try { const closing = await inference.finalizeJson({ messages: [{ role: 'system', content: 'Write a concise closing answer from recorded evidence only. State actual results and blockers; never claim task success from a write. Do not call tools or repeat actions.' },
                { role: 'user', content: JSON.stringify({ request: fixture.request, blocker: task.error, evidence: finalizationEvidence(task.checks, history.tools) }) }], stream: false }, signal); task.answer = closing.choices?.[0]?.message?.content ?? ''; } catch (error) { task.finalizationError = errorText(error); }
            }
            if (!task.answer.trim()) task.answer = incompleteNotice(signal.aborted ? 'cancelled' : 'incomplete', task.error ?? task.stopReason, task.checks);
            task.status = signal.aborted ? clock.signal.aborted ? 'timed-out' : 'cancelled' : task.error ? 'blocked' : task.stopReason !== 'end_turn' ? 'incomplete' : task.verification === 'passed' || snapshot ? 'completed' : 'incomplete';
          } else {
            task.checks.push(...(task.acceptanceChecks ?? []));
            closeUpdatedCodingTask(task, { aborted: termination!.aborted, timedOut: termination!.timedOut, abortReason: termination!.abortReason,
              ...(inference ? { recordClosing: text => inference!.recordHostClosing(text) } : {}) });
          }
          task.generationCounts = inference?.generationCounts ?? null; task.transcriptIncomplete = inference?.transcriptIncomplete ?? null; task.tools = finishToolHistory(history).tools; task.toolsTruncated = history.truncated;
          task.thinkingBytes = Buffer.byteLength(task.thinking); task.activeDurationMs = phaseRemainingMs - (termination?.remainingMs ?? clock.remainingMs); task.completedAt = new Date().toISOString();
          if (snapshot) {
            runtime.off('executionStopped', runtimeStopped); controller.abort(); registry.cancelAll();
            const cleanup = await Promise.allSettled([backend?.stop(), host?.drain(), gateway?.close()]); host?.server.closeAllConnections(); if (host) await new Promise<void>(resolve => host!.server.close(() => resolve()));
            task.cleanup = cleanup.map(value => ({ status: value.status, ...(value.status === 'rejected' ? { error: errorText(value.reason) } : {}) }));
          }
          let independent: IndependentResult[] = [];
          try { independent = await runIndependentVerifier(fixture, workspace, hidden, process.execPath, '/usr/bin/python3', stop.signal); } catch (error) { independent.push({ id: 'independent-verifier', passed: false, detail: errorText(error) }); }
          independent.push(...fixtureEvidenceChecks(fixture, task));
          if (budget.slowReliabilityAllowed) { const readback = slowReadbackEvidence(fixture, task); if (readback) independent.push(readback); }
          const replay = fixtureReplayCheck(task.events); task.replayCount = replay.replayCount; result.replayCount += replay.replayCount; independent.push(replay.check);
          if (fixture.safety) independent.push({ id: `approval-${phase}`, passed: task.permissions.length === 1 && task.permissions[0].decision === (phase === 'deny' ? 'denied' : 'cancelled')
            && !task.events.some((event: ActionToolEvent) => (event.output as { structuredContent?: { changed?: boolean } })?.structuredContent?.changed === true)
            && task.continuations === 0
            && (phase !== 'cancel' || task.lateApproval?.status === 'expired'), detail: 'The normal approval boundary stopped effects; a late approval cannot execute or replay.' });
          task.independentChecks = independent; result.independentChecks.push(...independent.map(check => ({ ...check, phase })));
          const independentlyPassed = independent.length > 0 && independent.every(check => check.passed);
          task.falseVerified = task.verification === 'passed' && !independentlyPassed; result.falseVerified ||= task.falseVerified;
          task.passed = independentlyPassed && (fixture.safety || fixture.expectedBlocker || task.status === 'completed') && task.cleanup.every((item: any) => item.status === 'fulfilled');
          await save(); console.log(JSON.stringify({ event: 'FIXTURE_PHASE_COMPLETE', fixture: fixture.id, repeat: iteration, phase, passed: task.passed, status: task.status, error: task.error }));
          if (!snapshot) clock.resume();
        }
        if (stopFurtherCases) break;
      }
      caseClock.close(); result.activeDurationMs = executionLimitMs - caseClock.remainingMs;
      result.passed = result.tasks.length === phases.length && result.tasks.every((id: string) => report.tasks.find((task: any) => task.taskId === id)?.passed); result.completedAt = new Date().toISOString();
      report.summary = harnessSummary(budget, fixtures, options.repeat, report.cases); await save();
      if (stopFurtherCases) break caseLoop;
    }
  } catch (error) { report.error = errorText(error); }
  finally {
    // Intentional final owned stop is cleanup, not an unexpected inference stop.
    if (budget.ssdSelectedDiagnosticAllowed) runtime.off('executionStopped', protocolRuntimeStopped);
    report.finalRuntimeBeforeStop = runtime.getStatus(); runtime.setExecutionRequestTimeout(3_600_000); await runtime.stop();
    report.ownedProcessesStopped = runtime.getStatus().state === 'stopped' && report.tasks.every((task: any) => task.cleanup?.every((entry: any) => entry.status === 'fulfilled'));
    for (const artifact of report.sourceArtifacts) { const current = await stat(artifact.source); artifact.sourceUnchanged = current.dev === artifact.device && current.ino === artifact.inode && current.size === artifact.sizeBytes && current.mtimeMs === artifact.mtimeMs; }
    if (report.baseline) { try { report.baseline.unchanged = await sha256File(report.baseline.path) === report.baseline.sha256; } catch { report.baseline.unchanged = false; } }
    if (budget.slowReliabilityAllowed && report.protocol) {
      try { assert.deepEqual(await captureSlowBenchmarkBinding(repository, paths), report.protocol.binding); report.protocol.bindingUnchanged = true; }
      catch (error) { report.protocol.bindingUnchanged = false; report.error ??= `Slow benchmark source/resource binding changed: ${errorText(error)}`; }
    }
    if (budget.ssdSelectedDiagnosticAllowed && report.protocol) {
      try {
        assert(report.ownedProcessesStopped, 'Selected SSD binding is finalized only after owned cleanup.');
        assert.deepEqual(await captureSlowBenchmarkBinding(repository, paths, true), report.protocol.binding);
        report.protocol.bindingUnchanged = true;
      } catch (error) { report.protocol.bindingUnchanged = false; report.error ??= `Selected SSD source/resource binding changed: ${errorText(error)}`; }
    }
    report.summary = harnessSummary(budget, fixtures, options.repeat, report.cases);
    const passFraction = report.summary.passedCases / (budget.qualificationAllowed ? 36 : report.expectedCases), improvement = budget.qualificationAllowed && report.baseline ? passFraction - report.baseline.passFraction : null;
    report.promotion = { baselinePresent: Boolean(report.baseline), passFraction, improvement, requiredImprovement: 0.20,
      eligibleModel: isQualificationEligible(options.model), ...(snapshot ? {} : { codingFamily: codingModelFamily(options.model), quantization: spec.quantization }),
      reason: budget.slowReliabilityAllowed ? 'Slow-profile eligibility is reported separately; this run cannot qualify or promote the original benchmark.' : budget.ssdSelectedDiagnosticAllowed ? 'Explicit four-hour SSD selected diagnostics cannot qualify or promote a model.' : !budget.qualificationAllowed ? 'One-hour desktop diagnostics cannot qualify or promote a model.' : !report.baseline ? 'A complete validated original 4B baseline is required.' : improvement! < 0.20 ? 'The measured gain is below 20 percentage points.' : null };
    report.qualified = report.fullRequested && report.summary.qualified && report.promotion.eligibleModel && improvement !== null && improvement + 1e-12 >= 0.20 && !snapshot
      && report.profileStable === true && report.baseline?.unchanged === true && report.ownedProcessesStopped && !report.error && report.sourceArtifacts.every((item: any) => item.sourceUnchanged);
    report.passed = report.cases.length === fixtures.length * options.repeat && report.cases.every((item: any) => item.passed) && report.ownedProcessesStopped && !report.error && (Boolean(snapshot) || report.profileStable === true)
      && (!budget.ssdSelectedDiagnosticAllowed || report.protocol?.bindingUnchanged === true && Boolean(report.protocol.computationBinding)
        && report.protocol.memoryGuardStopped === false && report.protocol.runtimeStopped === false);
    report.completedAt = new Date().toISOString();
    if (budget.slowReliabilityAllowed && report.protocol) report.slowReliability = slowReliabilityResult(report, allFixtures, report.protocol.binding, report.baseline);
    await save(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  console.log(JSON.stringify({ event: 'ACCEPTANCE_COMPLETE', report: reportPath, qualified: report.qualified, passed: report.passed, summary: report.summary, error: report.error, ...(report.slowReliability ? { slowReliability: report.slowReliability } : {}) }));
  return { reportPath, qualified: report.qualified, passed: report.passed, ...(report.slowReliability ? { slowReliability: report.slowReliability } : {}) };
}

const help = `Native local coding acceptance (no model downloads or global chats)\n  node scripts/validate-local-coding.ts --model qwen3.8:27b --source-dir ABS_MODELS --baseline-report ABS_BASELINE_REPORT\n  node scripts/validate-local-coding.ts --model qwen3.5:4b --source-dir ABS_MODELS --source-snapshot .cache/coding-reliability/baseline-src\nOptional: --cases exact-lf,cli-inputs --repeat 1|2|3 --package ABS_APP --label NAME --memory-mode automatic|low-memory|ssd-experts --budget-profile qualification|desktop-task|slow-system-reliability|ssd-selected-4h-v1\nThe default qualification budget remains 15 minutes. Explicit desktop-task diagnostics allow one hour, require selected cases and repeat 1, and cannot qualify or promote.\nExplicit slow-system-reliability uses all 12 fixtures × 3 repeats at one hour per case, a fresh current-controller matched 4B reference, and a separate slowReliability outcome; legacy qualified remains false.\nExplicit ssd-selected-4h-v1 is a separate four-hour diagnostic: exact Qwen80, explicit ssd-experts, current source, selected cases/repeat1; no package, baseline, qualification or slow eligibility. It creates new evidence and never extends a previous run.\nMemory mode defaults to automatic; source-snapshot baselines require automatic mode.\nDebug selections never qualify. Promotion requires all 12 fixed fixtures × 3 repeats, at least 31/36, all exact/no-op/safety cases, zero falsely verified cases, and at least 20 percentage points over the full validated original 4B baseline.\n--list lists fixture IDs. Native UI acceptance is separate.\n`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log(help);
  else if (process.argv.includes('--list')) console.log(codingFixtures(process.execPath).map(item => `${item.id}: ${item.title}`).join('\n'));
  else { try { const result = await runLocalCodingAcceptance(parseHarnessOptions(process.argv.slice(2))); process.exitCode = result.qualified || result.passed || result.slowReliability?.eligibleForSlowUse ? 0 : 1; } catch (error) { console.error(errorText(error)); process.exitCode = 1; } }
}
