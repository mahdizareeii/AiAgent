import { GIB, operatingSystemReserve, type HardwareInfo } from './hardware.ts';
import { PINNED_ENGINE_COMMIT, PORTABLE_CPU_ARGUMENTS, inferenceProfileSignature, validResourceMeasurements, type NativeMemoryProfile, type ResourceMeasurements } from './memory.ts';
import { RuntimeError } from './errors.ts';

/** Portable baseline only; acceleration needs separate measured evidence. */
export { PORTABLE_CPU_ARGUMENTS };
export const PORTABLE_CPU_PROFILE = Object.freeze({ backend: 'cpu', contextTokens: 4096, outputTokens: 1024, batchTokens: 64, microBatchTokens: 32, cacheTypeK: 'f16', cacheTypeV: 'f16', portableCPUArguments: PORTABLE_CPU_ARGUMENTS } as const);
export function isPortableCPUProfile(profile: NativeMemoryProfile): boolean {
  if (!profile || typeof profile !== 'object') return false;
  return Object.entries(PORTABLE_CPU_PROFILE).every(([key, value]) => key === 'portableCPUArguments' ? JSON.stringify(profile.portableCPUArguments) === JSON.stringify(value) : profile[key as keyof NativeMemoryProfile] === value)
    && !profile.nativePlacement && !profile.metalResidency && !profile.recurrentCheckpoint;
}
export interface PortableCPUAllocationPlan {
  schemaVersion: 1; kind: 'portable-cpu-4k-v1'; noAlloc: true; engineCommit: string;
  model: string; modelDigest: string; templateDigest: string; engineDigest: string; plannerDigest: string; profileSignature: string;
  artifactBytes: number; modelBytes: number; contextBytes: number; computeBytes: number;
  processHeadroomBytes: number; workingBytes: number;
}
export type PortablePlanBinding = Pick<PortableCPUAllocationPlan, 'model' | 'modelDigest' | 'templateDigest' | 'engineDigest' | 'plannerDigest' | 'profileSignature' | 'artifactBytes'>;
/** Diagnostic evidence only. A retained/rejected plan never establishes readiness. */
export interface PortableCPUAdmissionDiagnostic {
  schemaVersion: 1; kind: 'portable-cpu-admission-v1'; evaluatedAt: string;
  decision: 'not-evaluated' | 'admitted' | 'rejected' | 'invalid'; code: 'INSUFFICIENT_MEMORY' | 'MODEL_MEMORY_PLAN_INVALID' | null;
  reasons: ('invalid-inputs' | 'capacity' | 'pressure' | 'available-headroom')[];
  plan: PortableCPUAllocationPlan | null;
  hardware: { platform: string | null; architecture: string | null; totalMemoryBytes: number | null };
  sample: { sampledAt: string | null; pressure: ResourceMeasurements['pressure'] | null; availableMemoryBytes: number | null;
    residentBytes: number | null; rssBytes: number | null; physicalFootprintBytes: number | null;
    privateCommitBytes: number | null; swapBytes: number | null;
    monitor: ResourceMeasurements['monitor'] | null };
  limits: { operatingSystemReserveBytes: number | null; capacityBytes: number | null; currentHeadroomBytes: number; requiredAvailableMemoryBytes: number | null };
  deficits: { capacityBytes: number | null; availableHeadroomBytes: number | null };
}
const diagnosticBytes = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const diagnosticText = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
function retainedPortablePlan(plan: PortableCPUAllocationPlan): PortableCPUAllocationPlan | null {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'portable-cpu-4k-v1' || plan.noAlloc !== true
    || !/^[a-zA-Z0-9:._-]{1,256}$/.test(plan.model) || plan.engineCommit !== PINNED_ENGINE_COMMIT || plan.profileSignature !== inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory')
    || !['modelDigest', 'templateDigest', 'engineDigest', 'plannerDigest'].every(key => /^[a-f0-9]{64}$/.test(plan[key as 'modelDigest']))
    || ![plan.artifactBytes, plan.modelBytes, plan.contextBytes, plan.computeBytes, plan.processHeadroomBytes, plan.workingBytes].every(n => diagnosticBytes(n) !== null)) return null;
  // Copy an explicit scalar allowlist, never native output, prompts, paths or environment.
  return { schemaVersion: 1, kind: plan.kind, noAlloc: true, engineCommit: plan.engineCommit, model: plan.model,
    modelDigest: plan.modelDigest, templateDigest: plan.templateDigest, engineDigest: plan.engineDigest, plannerDigest: plan.plannerDigest,
    profileSignature: plan.profileSignature, artifactBytes: plan.artifactBytes, modelBytes: plan.modelBytes, contextBytes: plan.contextBytes,
    computeBytes: plan.computeBytes, processHeadroomBytes: plan.processHeadroomBytes, workingBytes: plan.workingBytes };
}
function admissionDiagnostic(plan: PortableCPUAllocationPlan, hardware: HardwareInfo, sample: ResourceMeasurements | undefined,
  decision: PortableCPUAdmissionDiagnostic['decision'], reasons: PortableCPUAdmissionDiagnostic['reasons']): PortableCPUAdmissionDiagnostic {
  const total = diagnosticBytes(hardware?.totalMemoryBytes), available = diagnosticBytes(sample?.availableMemoryBytes), retained = retainedPortablePlan(plan);
  const reserve = total !== null && total > 0 ? operatingSystemReserve(total) : null, capacity = reserve !== null ? total! - reserve : null;
  const required = retained && Number.isSafeInteger(retained.workingBytes + GIB) ? retained.workingBytes + GIB : null;
  const monitor = sample?.monitor;
  return { schemaVersion: 1, kind: 'portable-cpu-admission-v1', evaluatedAt: new Date().toISOString(), decision,
    code: decision === 'invalid' ? 'MODEL_MEMORY_PLAN_INVALID' : decision === 'rejected' ? 'INSUFFICIENT_MEMORY' : null, reasons: [...reasons], plan: retained,
    hardware: { platform: diagnosticText(hardware?.platform, 32), architecture: diagnosticText(hardware?.architecture, 32), totalMemoryBytes: total },
    sample: { sampledAt: diagnosticText(sample?.sampledAt, 64), pressure: sample && ['normal', 'warning', 'critical'].includes(sample.pressure) ? sample.pressure : null,
      availableMemoryBytes: available, residentBytes: diagnosticBytes(sample?.residentBytes), rssBytes: diagnosticBytes(sample?.rssBytes), physicalFootprintBytes: diagnosticBytes(sample?.physicalFootprintBytes),
      privateCommitBytes: diagnosticBytes(sample?.privateCommitBytes), swapBytes: diagnosticBytes(sample?.swapBytes),
      monitor: monitor && ['linux', 'win32'].includes(monitor.platform) && diagnosticText(monitor.source, 128) && diagnosticText(monitor.pressureSource, 128)
        ? { platform: monitor.platform, source: monitor.source, pressureSource: monitor.pressureSource, pid: diagnosticBytes(monitor.pid), parentPid: diagnosticBytes(monitor.parentPid) } : null },
    limits: { operatingSystemReserveBytes: reserve, capacityBytes: capacity, currentHeadroomBytes: GIB, requiredAvailableMemoryBytes: required },
    deficits: { capacityBytes: retained && capacity !== null ? Math.max(0, retained.workingBytes - capacity) : null,
      availableHeadroomBytes: required !== null && available !== null ? Math.max(0, required - available) : null } };
}
/** Preserve a parsed plan even if obtaining the subsequent fresh telemetry fails.
 * Null sample/deficit fields mean unobserved, never zero or successful admission. */
export function pendingPortableCPUAdmissionDiagnostic(plan: PortableCPUAllocationPlan, hardware: HardwareInfo): PortableCPUAdmissionDiagnostic {
  return admissionDiagnostic(plan, hardware, undefined, 'not-evaluated', []);
}
/** Consume a verified engine's metadata-only fit-print output. File size or a
 * guessed bytes/token multiplier is never relabeled an allocation measurement.
 * Host is the CPU planner's device row; unexpected accelerator rows fail closed.
 * Integer MiB values round down, so round each component up before summing. */
export function parsePortableCPUAllocationPlan(text: string, binding: PortablePlanBinding): PortableCPUAllocationPlan {
  if (Buffer.byteLength(text) > 128 * 1024 || !binding.model || !['modelDigest', 'templateDigest', 'engineDigest', 'plannerDigest'].every(key => /^[a-f0-9]{64}$/.test(binding[key as 'modelDigest']))
    || !Number.isSafeInteger(binding.artifactBytes) || binding.artifactBytes < 24) throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'The portable allocation plan requires exact verified artifact, engine and planner identities.');
  let signature: any;
  try { signature = JSON.parse(binding.profileSignature); } catch { throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'The portable CPU profile signature is invalid.'); }
  if (!isPortableCPUProfile(signature) || signature.engineCommit !== PINNED_ENGINE_COMMIT || signature.slots !== 1 || signature.memoryMode !== 'low-memory'
    || binding.profileSignature !== inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory')) throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'The plan must bind the exact portable CPU 4K profile.');
  let row: number[] | undefined;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    if (match[1] !== 'Host' || row) throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'The portable CPU planner returned duplicate or accelerator allocations.');
    row = match.slice(2).map(Number);
    if (row.some(n => !Number.isSafeInteger(n) || n < 0 || n > 128 * 1024)) throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'The portable CPU planner returned invalid allocations.');
  }
  if (!row || row[0] === 0 || row[1] === 0 || row[2] === 0) throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'A complete CPU model, context and compute allocation row is required.');
  const [reportedModel, contextBytes, computeBytes] = row.map(n => (n + 1) * 1024 ** 2);
  const modelBytes = Math.max(binding.artifactBytes, reportedModel), processHeadroomBytes = GIB;
  return { schemaVersion: 1, kind: 'portable-cpu-4k-v1', noAlloc: true, engineCommit: PINNED_ENGINE_COMMIT, ...binding, modelBytes, contextBytes, computeBytes, processHeadroomBytes,
    workingBytes: modelBytes + contextBytes + computeBytes + processHeadroomBytes };
}
/** Capacity and current headroom are separate constraints. VRAM, swap and disk
 * capacity never extend this CPU budget; reserve policy remains unchanged. */
export function assertPortableCPUAdmission(plan: PortableCPUAllocationPlan, hardware: HardwareInfo, sample: ResourceMeasurements,
  record?: (diagnostic: PortableCPUAdmissionDiagnostic) => void): void {
  if (!['darwin', 'linux', 'win32'].includes(hardware.platform) || !validResourceMeasurements(sample) || Math.abs(Date.now() - Date.parse(sample.sampledAt)) > 2000
    || !Number.isSafeInteger(hardware.totalMemoryBytes) || hardware.totalMemoryBytes <= 0
    || plan.kind !== 'portable-cpu-4k-v1' || plan.noAlloc !== true || plan.engineCommit !== PINNED_ENGINE_COMMIT
    || ![plan.artifactBytes, plan.modelBytes, plan.contextBytes, plan.computeBytes, plan.processHeadroomBytes, plan.workingBytes].every(n => Number.isSafeInteger(n) && n > 0)
    || plan.modelBytes < plan.artifactBytes || plan.processHeadroomBytes !== GIB || plan.workingBytes !== plan.modelBytes + plan.contextBytes + plan.computeBytes + plan.processHeadroomBytes) {
    record?.(admissionDiagnostic(plan, hardware, sample, 'invalid', ['invalid-inputs']));
    throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID', 'Fresh host telemetry and a complete portable CPU allocation plan are required.');
  }
  const capacity = hardware.totalMemoryBytes - operatingSystemReserve(hardware.totalMemoryBytes);
  if (plan.workingBytes > capacity || sample.pressure !== 'normal' || sample.availableMemoryBytes < plan.workingBytes + GIB) {
    record?.(admissionDiagnostic(plan, hardware, sample, 'rejected', [
      ...(plan.workingBytes > capacity ? ['capacity' as const] : []), ...(sample.pressure !== 'normal' ? ['pressure' as const] : []),
      ...(sample.availableMemoryBytes < plan.workingBytes + GIB ? ['available-headroom' as const] : [])]));
    throw new RuntimeError('INSUFFICIENT_MEMORY', 'The measured CPU allocation plan requires normal pressure, the unchanged OS reserve, and one GiB of remaining current headroom.');
  }
  record?.(admissionDiagnostic(plan, hardware, sample, 'admitted', []));
}
export function assertPortableCPURuntime(plan: PortableCPUAllocationPlan, hardware: HardwareInfo, sample: ResourceMeasurements): void {
  const capacity = hardware.totalMemoryBytes - operatingSystemReserve(hardware.totalMemoryBytes);
  if (!validResourceMeasurements(sample) || Math.abs(Date.now() - Date.parse(sample.sampledAt)) > 2000 || !Number.isSafeInteger(sample.rssBytes) || sample.rssBytes! <= 0
    || sample.residentBytes !== Math.max(sample.rssBytes!, sample.physicalFootprintBytes ?? 0)) throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Fresh app-owned process RSS and host pressure are required for the portable CPU profile.');
  if (sample.pressure !== 'normal' || sample.availableMemoryBytes < GIB || sample.residentBytes > Math.min(plan.workingBytes, capacity)) throw new RuntimeError('MODEL_MEMORY_CALIBRATION_FAILED', 'The portable CPU profile exceeded its admitted residency, normal-pressure or one-GiB headroom bound. Completed actions are preserved.');
}

/** Bounded scalar startup attestation for the fixed CPU profile. No prompts are
 * retained. Context and slots come from actual /props; the output cap comes from
 * the owned launch arguments and remains separately enforced by the gateway. */
export class PortableCPUStartupLog {
  private partial = '';
  private invalid = false;
  private settings = new Map<string, number>();
  private threads: string | null = null;
  private flash: string | null = null;
  private keys = new Set<string>();
  private values = new Set<string>();
  private mappedCPUBytes: number | null = null;
  push(text: string): void {
    if (Buffer.byteLength(text) > 128 * 1024) { this.invalid = true; return; }
    const lines = (this.partial + text).split('\n'); this.partial = lines.pop() ?? '';
    if (this.partial.length > 8192) { this.invalid = true; this.partial = this.partial.slice(-8192); }
    for (const line of lines) {
      if (line.length > 8192) { this.invalid = true; continue; }
      const setting = line.match(/llama_context:\s*(n_seq_max|n_ctx|n_ctx_seq|n_batch|n_ubatch|n_rs_seq)\s*=\s*(\d+)\s*$/);
      if (setting) {
        const n = Number(setting[2]), previous = this.settings.get(setting[1]);
        if (!Number.isSafeInteger(n) || previous !== undefined && previous !== n) this.invalid = true;
        this.settings.set(setting[1], n);
      } else if (/llama_context:\s*(?:n_seq_max|n_ctx|n_ctx_seq|n_batch|n_ubatch|n_rs_seq)\s*=/.test(line)) this.invalid = true;
      const threads = line.match(/system_info: n_threads\s*=\s*(\d+)\s*\(n_threads_batch\s*=\s*(\d+)\)/);
      if (threads) { const next = `${threads[1]}/${threads[2]}`; if (this.threads && this.threads !== next) this.invalid = true; this.threads = next; }
      else if (/system_info: n_threads\s*=/.test(line)) this.invalid = true;
      const kv = line.match(/K \(([^)]+)\):.*V \(([^)]+)\):/);
      if (kv) { this.keys.add(kv[1]); this.values.add(kv[2]); }
      const flash = line.match(/flash_attn\s*=\s*(enabled|disabled)\s*$/);
      if (flash) { if (this.flash && this.flash !== flash[1]) this.invalid = true; this.flash = flash[1]; }
      else if (/flash_attn\s*=/.test(line)) this.invalid = true;
      const buffer = line.match(/load_tensors:\s+(\S+)\s+model buffer size\s*=\s*(\d+(?:\.\d+)?)\s+MiB\s*$/);
      if (buffer) {
        if (buffer[1] !== 'CPU_Mapped' || this.mappedCPUBytes !== null || !Number.isFinite(Number(buffer[2])) || Number(buffer[2]) <= 0) this.invalid = true;
        else this.mappedCPUBytes = Math.ceil(Number(buffer[2]) * 1024 ** 2);
      } else if (/load_tensors:.*model buffer size\s*=/.test(line)) this.invalid = true;
      const offloaded = line.match(/offloaded (\d+)\/(\d+) layers to GPU/);
      if (offloaded && (offloaded[1] !== '0' || Number(offloaded[2]) <= 0)) this.invalid = true;
      if (/context checkpoints enabled|created context checkpoint|restored context checkpoint/.test(line)) this.invalid = true;
    }
  }
  matches(actual: { contextTokens: number; outputTokensFromOwnedArguments: number; slots: number; maximumMappedBytes?: number }): boolean {
    const expected = { n_seq_max: 1, n_ctx: 4096, n_ctx_seq: 4096, n_batch: 64, n_ubatch: 32 };
    return !this.invalid && this.partial.trim() === '' && actual.contextTokens === 4096 && actual.outputTokensFromOwnedArguments === 1024 && actual.slots === 1
      && Object.entries(expected).every(([key, n]) => this.settings.get(key) === n) && (!this.settings.has('n_rs_seq') || this.settings.get('n_rs_seq') === 0)
      && this.threads === '4/4' && this.flash === 'disabled' && this.keys.size === 1 && this.keys.has('f16') && this.values.size === 1 && this.values.has('f16') && this.mappedCPUBytes !== null
      && (actual.maximumMappedBytes === undefined || Number.isSafeInteger(actual.maximumMappedBytes) && actual.maximumMappedBytes > 0 && this.mappedCPUBytes <= actual.maximumMappedBytes);
  }
}
