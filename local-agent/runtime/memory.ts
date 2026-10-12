import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIB, operatingSystemReserve, parseMacAvailableMemory, type HardwareInfo } from './hardware.ts';
import { RuntimeError } from './errors.ts';

export type MemoryMode = 'automatic' | 'low-memory' | 'experimental-disk';
export interface ResourceMeasurements {
  sampledAt: string;
  residentBytes: number;
  availableMemoryBytes: number;
  pressure: 'normal' | 'warning' | 'critical';
}
export interface ExperimentalTrial {
  id: string;
  model: string;
  digest: string | null;
  state: 'loading' | 'calibrating' | 'passed' | 'failed' | 'cancelled' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  profileSignature: string;
  probePassed: boolean;
  toolProbePassed: boolean;
  error: { code: string; message: string } | null;
  resourceBudgetBytes: number | null;
  /** Rounded engine-reported mmap buffer size, never resident memory. Null means unmeasured. */
  mappedBytes: number | null;
  /** Rounded sizes of architecture-marked tensors the engine actually enabled for lazy reads. */
  lazyEligibleBytes: number | null;
  measurements: ResourceMeasurements | null;
}
export const PINNED_ENGINE_COMMIT = 'd81235049384534c167caea52b85a694f6103d14';
export function inferenceProfileSignature(profile:{backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number},memoryMode:MemoryMode):string{
  return JSON.stringify({engineCommit:PINNED_ENGINE_COMMIT,memoryMode,backend:profile.backend,contextTokens:profile.contextTokens,outputTokens:profile.outputTokens,batchTokens:profile.batchTokens,microBatchTokens:profile.microBatchTokens,slots:1});
}
export const EXPERIMENTAL_PROFILE_SIGNATURE = inferenceProfileSignature({backend:'cpu',contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32},'experimental-disk');
export function experimentalResidentBudget(hardware: HardwareInfo): number {
  return Math.max(0, Math.min(hardware.totalMemoryBytes - operatingSystemReserve(hardware.totalMemoryBytes), hardware.availableMemoryBytes - GIB));
}
export function validResourceMeasurements(sample: ResourceMeasurements): boolean {
  return Boolean(sample && Number.isFinite(Date.parse(sample.sampledAt)) && Number.isSafeInteger(sample.residentBytes) && sample.residentBytes >= 0 && Number.isSafeInteger(sample.availableMemoryBytes) && sample.availableMemoryBytes >= 0 && ['normal', 'warning', 'critical'].includes(sample.pressure));
}
/** Only reads host statistics and the app-owned process; it never changes paging or other processes. */
export async function probeResourceMeasurements(pid: number | null, platform: NodeJS.Platform = process.platform): Promise<ResourceMeasurements> {
  if (platform !== 'darwin') throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Experimental disk mode currently requires macOS memory monitoring.');
  if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'The app-owned model process has no valid process identity.');
  const execute = promisify(execFile);
  const options = { timeout: 1500, maxBuffer: 65536, env: { LANG: 'C' } };
  const [memory, pressure, resident] = await Promise.all([
    execute('/usr/bin/vm_stat', [], options),
    execute('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options),
    pid === null ? Promise.resolve({ stdout: '0' }) : execute('/bin/ps', ['-o', 'rss=', '-p', String(pid)], options),
  ]);
  const available = parseMacAvailableMemory(memory.stdout), level = Number(pressure.stdout.trim()), rss = Number(resident.stdout.trim());
  if (available === null || ![1, 2, 4].includes(level) || !resident.stdout.trim() || !Number.isSafeInteger(rss) || rss < 0) throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Reliable memory-pressure, available-memory, and model-residency measurements are required for Experimental disk mode.');
  return { sampledAt: new Date().toISOString(), residentBytes: rss * 1024, availableMemoryBytes: available, pressure: level === 4 ? 'critical' : level === 2 ? 'warning' : 'normal' };
}

/** Parses actual pinned-engine logs rather than treating all mmap weights as lazily eligible. */
export class EngineMemoryLog {
  private partial = '';
  private mapped: number[] = [];
  private lazy = new Map<string, number>();
  push(text: string): void {
    const lines = (this.partial + text).split('\n'); this.partial = (lines.pop() ?? '').slice(-8192);
    for (const line of lines) {
      const mapped = line.match(/(\S*Mapped)\s+(?:model\s+)?buffer size\s*=\s*([\d.]+)\s*MiB/);
      if (mapped) this.mapped.push(Math.round(Number(mapped[2]) * 1024 ** 2));
      const lazy = line.match(/tensor\s+(\S+)\s+\(size\s*=\s*(\d+)\s*MiB\)\s+lazy read enabled/);
      if (lazy) this.lazy.set(lazy[1], Number(lazy[2]) * 1024 ** 2);
    }
  }
  values(loaded = false): { mappedBytes: number | null; lazyEligibleBytes: number | null } {
    return { mappedBytes: this.mapped.length ? this.mapped.reduce((a, b) => a + b, 0) : null, lazyEligibleBytes: this.lazy.size ? [...this.lazy.values()].reduce((a, b) => a + b, 0) : loaded ? 0 : null };
  }
}
