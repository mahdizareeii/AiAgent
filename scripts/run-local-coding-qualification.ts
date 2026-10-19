import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { MODEL_CATALOG } from '../local-agent/runtime/catalog.ts';
import { captureSlowBenchmarkBinding, validateSlowReferenceReport, slowReliabilityResult, SLOW_RELIABILITY_PROTOCOL, type SlowBenchmarkBinding } from './validate-local-coding.ts';
import { bytesDigest, codingFixtures } from './coding-reliability-fixtures.ts';

const MODEL_IDS = ['qwen3.8:27b', 'muse-glimmer:30b'] as const;
const SLOW_MODEL_IDS = ['qwen3.8:27b-q3-k-m', 'muse-glimmer:30b-q3-k-m'] as const;
const MAX_WAIT_MS = 12 * 60 * 60_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const repository = fileURLToPath(new URL('..', import.meta.url));
type ModelInput = { id: string; filename: string; estimatedDownloadBytes: number };
type PipelineStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
export interface QualificationAttempt {
  model: string; status: 'pending' | 'running' | 'qualified' | 'slow-qualified' | 'measured-reference' | 'passed-unqualified' | 'failed' | 'cancelled';
  startedAt?: string; completedAt?: string; pid?: number; exitCode?: number | null; exitSignal?: string | null;
  reportPath?: string; ownedProcessesStopped?: boolean; qualified?: boolean; passed?: boolean;
  error?: string; stdoutTail?: string; stderrTail?: string; terminationRequestedAt?: string; forcedTermination?: boolean;
  slowReliability?: ReturnType<typeof slowReliabilityResult>;
}
export interface QualificationPipeline {
  schemaVersion: 1; runId: string; reportPath: string; baselineReport: string | null; sourceDirectory: string;
  startedAt: string; completedAt?: string; status: PipelineStatus; nativeUIVerified: false;
  modelAcquisition: false; publicNetwork: false; coordinatorOnly: true;
  waitTimeoutMs: number; readiness?: { baselineReady: boolean; modelsReady: Record<string, boolean> };
  attempts: QualificationAttempt[]; error?: string;
  protocol?: 'slow'; protocolId?: string; binding?: SlowBenchmarkBinding; reference?: QualificationAttempt;
  referenceSummary?: { path: string; sha256: string; passedCases: number; totalCases: 36; passFraction: number };
}
interface CoordinatorSettings {
  signal?: AbortSignal;
  /** Trusted offline fixture hooks; these are not command-line options. */
  rootDirectory?: string; catalog?: readonly ModelInput[]; harnessPath?: string;
  waitTimeoutMs?: number; pollIntervalMs?: number; stopGraceMs?: number;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Tiny fake-file fixtures only; production always hashes current source/resources. */
  slowBinding?: SlowBenchmarkBinding;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}
async function readReport(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REPORT_BYTES || await realpath(file) !== file) throw new Error('A qualification report must be a regular local file of at most 64 MiB.');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A qualification report must contain a JSON object.');
  return value as Record<string, unknown>;
}
function terminalTime(report: Record<string, unknown>): boolean {
  const value = report.finishedAt ?? report.completedAt;
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
async function readSlowEvidence(file: string) {
  const before = await lstat(file), value = await readReport(file), bytes = await readFile(file), after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytesDigest(JSON.stringify(value)) !== bytesDigest(JSON.stringify(JSON.parse(bytes.toString('utf8'))))) throw new Error('The slow benchmark report changed while reading.');
  return { value: value as any, sha256: bytesDigest(bytes) };
}
async function slowModelsReady(sourceDirectory: string, models: readonly ModelInput[]) {
  const modelsReady: Record<string, boolean> = {};
  for (const model of models) {
    modelsReady[model.id] = false;
    try {
      const file = path.join(sourceDirectory, model.filename), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size !== model.estimatedDownloadBytes) throw new Error(`The final ${model.id} artifact must be a regular pinned-size file.`);
      modelsReady[model.id] = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { modelsReady, ready: models.every(model => modelsReady[model.id]) };
}

/** Read only report metadata and final artifact sizes while waiting; the harness hashes the weights. */
export async function qualificationReadiness(baselineReport: string, sourceDirectory: string, models: readonly ModelInput[]) {
  let baselineReady = false;
  try {
    const report = await readReport(baselineReport);
    if (terminalTime(report)) {
      if (report.modelId !== 'qwen3.5:4b' || report.fullRequested !== true || report.expectedCases !== 36 || !Array.isArray(report.cases) || report.cases.length !== 36) throw new Error('The finished baseline is not the complete original 4B 36-case run.');
      if (report.ownedProcessesStopped !== true) throw new Error('The finished baseline did not confirm that its owned processes stopped.');
      if (report.error) throw new Error(`The baseline ended with a harness error: ${String(report.error)}`);
      baselineReady = true;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const modelsReady: Record<string, boolean> = {};
  for (const model of models) {
    modelsReady[model.id] = false;
    try {
      const file = path.join(sourceDirectory, model.filename), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error(`The final ${model.id} artifact must be a regular local file.`);
      if (info.size !== model.estimatedDownloadBytes) throw new Error(`The final ${model.id} artifact does not have its pinned size.`);
      modelsReady[model.id] = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { baselineReady, modelsReady, ready: baselineReady && models.every(model => modelsReady[model.id]) };
}

function terminateOwnedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export interface QualificationOptions { baselineReport?: string; protocol?: 'legacy' | 'slow'; }
export async function runCodingQualification(options: QualificationOptions, settings: CoordinatorSettings = {}): Promise<QualificationPipeline> {
  const root = await realpath(settings.rootDirectory ?? repository), cache = path.join(root, '.cache/coding-reliability');
  const slow = options.protocol === 'slow';
  if (options.protocol !== undefined && !['legacy', 'slow'].includes(options.protocol) || !slow && !options.baselineReport) throw new Error('Use --baseline-report PATH or explicit --protocol slow.');
  const baselineReport = options.baselineReport ? path.resolve(options.baselineReport) : null, sourceDirectory = path.join(cache, 'models');
  if (baselineReport && !inside(cache, baselineReport)) throw new Error('The baseline report must remain inside .cache/coding-reliability.');
  const waitTimeoutMs = boundedInteger(settings.waitTimeoutMs ?? MAX_WAIT_MS, 1, MAX_WAIT_MS, 'Wait timeout');
  const pollIntervalMs = boundedInteger(settings.pollIntervalMs ?? 30_000, 1, 60_000, 'Poll interval');
  const stopGraceMs = boundedInteger(settings.stopGraceMs ?? 45_000, 1, 60_000, 'Stop grace period');
  const selectModel = (id: string) => {
    const model = (settings.catalog ?? MODEL_CATALOG).find(value => value.id === id);
    if (!model || !Number.isSafeInteger(model.estimatedDownloadBytes) || model.estimatedDownloadBytes < 1 || path.basename(model.filename) !== model.filename) throw new Error(`The pinned input for ${id} is missing or invalid.`);
    return model;
  };
  const models = (slow ? SLOW_MODEL_IDS : MODEL_IDS).map(selectModel), referenceModel = slow ? selectModel('qwen3.5:4b') : undefined;
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if (await realpath(cache) !== cache) throw new Error('The qualification evidence directory cannot be a symlink.');
  const runId = randomUUID(), reportPath = path.join(cache, `${slow ? 'slow-reliability' : 'qualification'}-pipeline-${runId}.json`);
  const report: QualificationPipeline = { schemaVersion: 1, runId, reportPath, baselineReport, sourceDirectory,
    startedAt: new Date().toISOString(), status: 'waiting', nativeUIVerified: false, modelAcquisition: false, publicNetwork: false,
    coordinatorOnly: true, waitTimeoutMs, attempts: [], ...(slow ? { protocol: 'slow' as const, protocolId: SLOW_RELIABILITY_PROTOCOL } : {}) };
  const fixtures = slow ? codingFixtures(process.execPath) : undefined;
  let writes: Promise<void> = Promise.resolve();
  const save = async () => {
    const json = JSON.stringify(report, null, 2) + '\n';
    writes = writes.catch(() => {}).then(async () => {
      const temporary = reportPath + '.tmp';
      await writeFile(temporary, json, { mode: 0o600, flag: 'wx' }); await rename(temporary, reportPath);
    });
    await writes;
  };
  const output = settings.onOutput ?? ((stream, text) => (stream === 'stdout' ? process.stdout : process.stderr).write(text));
  const runChild = async (model: ModelInput, role: 'reference' | 'candidate' = 'candidate'): Promise<void> => {
    settings.signal?.throwIfAborted();
    if (slow && role === 'candidate') {
      const reference = await readSlowEvidence(report.baselineReport!);
      if (reference.sha256 !== report.referenceSummary?.sha256) throw new Error('The matched slow reference changed before the next model; no new model will start.');
      validateSlowReferenceReport(reference.value, fixtures!, report.binding!);
    }
    const attempt: QualificationAttempt = { model: model.id, status: 'running', startedAt: new Date().toISOString() };
    if (role === 'reference') report.reference = attempt; else report.attempts.push(attempt); await save();
    if (settings.signal?.aborted) {
      attempt.status = 'cancelled'; attempt.completedAt = new Date().toISOString(); settings.signal.throwIfAborted();
    }
    const argumentsForRun = slow ? [...(role === 'candidate' ? ['--baseline-report', report.baselineReport!] : []), '--model', model.id, '--source-dir', sourceDirectory,
      '--budget-profile', 'slow-system-reliability', '--repeat', '3', '--memory-mode', role === 'reference' ? 'automatic' : 'low-memory', '--label', `slow-${role}-${runId}`]
      : ['--baseline-report', baselineReport!, '--model', model.id, '--source-dir', sourceDirectory];
    const child = spawn(process.execPath, [settings.harnessPath ?? path.join(root, 'scripts/validate-local-coding.ts'), ...argumentsForRun],
    { cwd: root, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    attempt.pid = child.pid;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    let pending = '', outputOverflow = false, timer: ReturnType<typeof setTimeout> | undefined, processError: string | undefined;
    const recordLine = (line: string) => {
      try {
        const value = JSON.parse(line);
        if (value?.event !== 'ACCEPTANCE_COMPLETE' || typeof value.report !== 'string') return;
        const file = path.resolve(value.report);
        if (!inside(path.join(cache, 'runs'), file)) throw new Error('The harness returned a report outside its evidence directory.');
        if (attempt.reportPath && attempt.reportPath !== file) throw new Error('The harness returned conflicting completion reports.');
        attempt.reportPath = file;
      } catch (error) { if (!(error instanceof SyntaxError)) processError ??= message(error); }
    };
    const collect = (stream: 'stdout' | 'stderr', text: string) => {
      output(stream, text);
      const key = stream === 'stdout' ? 'stdoutTail' : 'stderrTail';
      attempt[key] = ((attempt[key] ?? '') + text).slice(-MAX_OUTPUT_BYTES);
      if (stream !== 'stdout') return;
      pending += text;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        if (!outputOverflow && end <= MAX_OUTPUT_BYTES) recordLine(pending.slice(0, end));
        pending = pending.slice(end + 1); outputOverflow = false;
      }
      if (pending.length > MAX_OUTPUT_BYTES) { pending = ''; outputOverflow = true; }
    };
    child.stdout!.on('data', chunk => collect('stdout', stdout.write(chunk)));
    child.stderr!.on('data', chunk => collect('stderr', stderr.write(chunk)));
    const abort = () => {
      if (attempt.terminationRequestedAt) return;
      attempt.terminationRequestedAt = new Date().toISOString(); attempt.status = 'cancelled';
      try { terminateOwnedGroup(child, 'SIGTERM'); } catch (error) { processError ??= message(error); }
      timer = setTimeout(() => {
        attempt.forcedTermination = true;
        try { terminateOwnedGroup(child, 'SIGKILL'); } catch (error) { processError ??= message(error); }
      }, stopGraceMs);
    };
    settings.signal?.addEventListener('abort', abort, { once: true });
    if (settings.signal?.aborted) abort();
    const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('error', error => { processError ??= message(error); });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (timer) clearTimeout(timer);
    settings.signal?.removeEventListener('abort', abort);
    collect('stdout', stdout.end()); collect('stderr', stderr.end());
    if (pending && !outputOverflow) recordLine(pending);
    attempt.exitCode = result.code; attempt.exitSignal = result.signal; attempt.completedAt = new Date().toISOString();
    try {
      if (!attempt.reportPath) throw new Error('The harness did not return an ACCEPTANCE_COMPLETE report.');
      const completed = await readReport(attempt.reportPath);
      if (!terminalTime(completed) || completed.modelId !== model.id) throw new Error('The harness report has no matching terminal model identity.');
      attempt.ownedProcessesStopped = completed.ownedProcessesStopped === true;
      attempt.qualified = completed.qualified === true; attempt.passed = completed.passed === true;
      if (completed.error) attempt.error = String(completed.error);
      if (processError) attempt.error = processError;
      if (slow) {
        attempt.qualified = false;
        const evidence = await readSlowEvidence(attempt.reportPath);
        if (path.basename(path.dirname(attempt.reportPath)) !== evidence.value.runId || evidence.value.tasks?.some((task: any) => !inside(path.dirname(attempt.reportPath!), task.workspace))) throw new Error('Slow evidence contains another run or out-of-run workspaces.');
        if (role === 'reference') {
          const summary = validateSlowReferenceReport(evidence.value, fixtures!, report.binding!);
          if (processError || ![0, 1].includes(result.code ?? -1)) throw new Error(processError ?? 'The matched 4B reference did not finish normally.');
          report.baselineReport = attempt.reportPath; report.referenceSummary = { path: attempt.reportPath, sha256: evidence.sha256, ...summary };
          attempt.status = settings.signal?.aborted ? 'cancelled' : 'measured-reference';
        } else {
          const reference = await readSlowEvidence(report.baselineReport!);
          if (reference.sha256 !== report.referenceSummary!.sha256 || evidence.value.baseline?.sha256 !== reference.sha256 || evidence.value.baseline?.unchanged !== true) throw new Error('The matched slow reference changed or candidate reference binding differs.');
          const derived = slowReliabilityResult(evidence.value, fixtures!, report.binding!, { ...report.referenceSummary!, unchanged: true });
          if (JSON.stringify(derived) !== JSON.stringify(evidence.value.slowReliability)) throw new Error('The candidate slow eligibility disagrees with its bound complete evidence.');
          attempt.slowReliability = derived;
          attempt.status = settings.signal?.aborted ? 'cancelled' : result.code === 0 && !processError && derived.eligibleForSlowUse ? 'slow-qualified'
            : result.code === 0 && !processError && derived.completeRun && attempt.passed ? 'passed-unqualified' : 'failed';
        }
      } else attempt.status = settings.signal?.aborted ? 'cancelled' : result.code === 0 && !processError && attempt.qualified ? 'qualified'
        : result.code === 0 && !processError && attempt.passed ? 'passed-unqualified' : 'failed';
      if (attempt.status === 'failed' && !attempt.error) attempt.error = `The model attempt exited ${result.code ?? result.signal ?? 'without a status'} without qualification.`;
    } catch (error) { attempt.status = settings.signal?.aborted ? 'cancelled' : 'failed'; attempt.error = processError ?? message(error); }
    await save();
    settings.signal?.throwIfAborted();
    if (attempt.ownedProcessesStopped !== true) {
      try { terminateOwnedGroup(child, 'SIGTERM'); } catch {}
      throw new Error(`The ${model.id} attempt did not confirm owned-process cleanup. The next model will not start.`);
    }
    if (role === 'reference' && attempt.status !== 'measured-reference') throw new Error(`The fresh matched slow reference is unusable: ${attempt.error ?? attempt.status}`);
  };
  try {
    await save();
    if (slow) report.binding = settings.slowBinding ?? await captureSlowBenchmarkBinding(root, { engine: path.join(root, 'resources/inference'), goose: path.join(root, 'resources/goose/goose'),
      research: path.join(root, 'local-agent/research/dist/local-agent-research/local-agent-research'), bridge: path.join(root, 'dist/action-bridge.cjs'), skills: path.join(root, 'dist/skills'), node: process.execPath });
    const deadline = Date.now() + waitTimeoutMs;
    for (;;) {
      settings.signal?.throwIfAborted();
      const readiness = slow ? await (async () => {
        const inputs = await slowModelsReady(sourceDirectory, [referenceModel!, ...models]);
        let baselineReady = !baselineReport;
        if (baselineReport) {
          try {
            const evidence = await readSlowEvidence(baselineReport);
            if (terminalTime(evidence.value)) {
              if (path.basename(path.dirname(baselineReport)) !== evidence.value.runId || evidence.value.tasks?.some((task: any) => !inside(path.dirname(baselineReport), task.workspace))) throw new Error('Matched slow reference contains another run or out-of-run workspaces.');
              const summary = validateSlowReferenceReport(evidence.value, fixtures!, report.binding!); report.referenceSummary = { path: baselineReport, sha256: evidence.sha256, ...summary };
              report.reference = { model: 'qwen3.5:4b', status: 'measured-reference', reportPath: baselineReport, completedAt: evidence.value.completedAt, ownedProcessesStopped: true, qualified: false, passed: evidence.value.passed === true }; baselineReady = true;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        return { baselineReady, modelsReady: inputs.modelsReady, ready: baselineReady && inputs.ready };
      })() : await qualificationReadiness(baselineReport!, sourceDirectory, models);
      report.readiness = { baselineReady: readiness.baselineReady, modelsReady: readiness.modelsReady }; await save();
      if (readiness.ready) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { report.status = 'timed-out'; throw new Error('Timed out waiting for the complete baseline and both pinned final model files.'); }
      await delay(Math.min(pollIntervalMs, remaining), undefined, { signal: settings.signal });
    }
    report.status = 'running'; await save();
    if (slow && !baselineReport) await runChild(referenceModel!, 'reference');
    for (const model of models) await runChild(model);
    report.status = 'completed';
  } catch (error) {
    report.status = settings.signal?.aborted ? 'cancelled' : report.status === 'timed-out' ? 'timed-out' : 'failed';
    report.error = settings.signal?.aborted ? message(settings.signal.reason) : message(error);
  } finally { report.completedAt = new Date().toISOString(); await save(); }
  return report;
}

export function parseQualificationOptions(args: string[]): QualificationOptions {
  if (args.length === 2 && args[0] === '--baseline-report' && args[1] && !args[1].startsWith('--')) return { baselineReport: path.resolve(args[1]) };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--protocol', '--baseline-report'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || values.has(args[i])) throw new Error('Use --baseline-report PATH or --protocol slow [--baseline-report MATCHED_SLOW_REFERENCE].');
    values.set(args[i], args[i + 1]);
  }
  if (values.get('--protocol') !== 'slow') throw new Error('Use --baseline-report PATH or explicit --protocol slow.');
  return { protocol: 'slow', ...(values.has('--baseline-report') ? { baselineReport: path.resolve(values.get('--baseline-report')!) } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('One-off offline local coding qualification\n  node scripts/run-local-coding-qualification.ts --baseline-report PATH\nWaits up to 12 hours for the stopped 36-case baseline and both pinned final files, then runs Qwen and Muse once, serially. No downloads or GUI certification.\nSeparate slow protocol: node scripts/run-local-coding-qualification.ts --protocol slow [--baseline-report MATCHED_SLOW_REFERENCE]\nRequires complete 4B/Qwen Q3/Muse Q3 files and frozen current source/resources. Creates a new one-hour 36-case 4B reference when none is provided, then runs Q3 models serially. Slow eligibility stays separate from original qualification.');
  else {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('The qualification coordinator was interrupted.'));
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const report = await runCodingQualification(parseQualificationOptions(process.argv.slice(2)), { signal: controller.signal });
      console.log(JSON.stringify({ event: 'QUALIFICATION_PIPELINE_COMPLETE', report: report.reportPath, status: report.status,
        nativeUIVerified: false, attempts: report.attempts.map(({ model, status, reportPath, exitCode, qualified }) => ({ model, status, reportPath, exitCode, qualified })) }));
      process.exitCode = report.status === 'completed' && report.attempts.every(attempt => attempt.exitCode === 0) ? 0 : 1;
    } catch (error) { console.error(message(error)); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
}
