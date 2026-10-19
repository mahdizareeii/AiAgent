import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RuntimeError } from './errors.ts';
import type { ResourceMeasurements } from './memory.ts';

const KIB = 1024, GIB = 1024 ** 3;
type Pressure = ResourceMeasurements['pressure'];
export interface HostMemoryReading { totalMemoryBytes: number; availableMemoryBytes: number; pressure: Pressure; }
export interface PlatformMemoryReading extends ResourceMeasurements {
  totalMemoryBytes: number;
  /** Commit and swapped pages are diagnostic values, never added to RSS. */
  privateCommitBytes?: number;
  swapBytes?: number;
  monitor: { platform: 'linux' | 'win32'; source: string; pressureSource: string; pid: number | null; parentPid: number | null; };
}
const unavailable = (detail: string): never => { throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', detail); };
function integer(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) return unavailable('Memory telemetry contains an invalid byte count.');
  return value;
}
function kibField(text: string, name: string): number {
  const matches = [...text.matchAll(new RegExp(`^${name}:\\s+(\\d+) kB\\s*$`, 'gm'))];
  if (matches.length !== 1) return unavailable(`The OS did not provide one ${name} memory counter.`);
  return integer(Number(matches[0][1]) * KIB);
}
/** MemAvailable already estimates reclaimable cache. Never add Cached or swap. */
export function parseLinuxAvailableMemory(text: string): { totalMemoryBytes: number; availableMemoryBytes: number } {
  const totalMemoryBytes = integer(kibField(text, 'MemTotal'), true), availableMemoryBytes = kibField(text, 'MemAvailable');
  if (availableMemoryBytes > totalMemoryBytes) return unavailable('Linux available memory exceeds total memory.');
  return { totalMemoryBytes, availableMemoryBytes };
}
function headroomPressure(total: number, available: number): Pressure {
  return available < Math.max(512 * 1024 ** 2, total * .05) ? 'critical' : available < Math.max(GIB, total * .1) ? 'warning' : 'normal';
}
/** Linux PSI thresholds are explicit app policy, not a kernel pressure enum. */
export function parseLinuxHostMemory(memory: string, psi: string): HostMemoryReading {
  const host = parseLinuxAvailableMemory(memory);
  const rows = new Map<string, number>();
  for (const line of psi.trim().split('\n')) {
    const match = line.match(/^(some|full) avg10=(\d+(?:\.\d+)?) avg60=\d+(?:\.\d+)? avg300=\d+(?:\.\d+)? total=\d+$/);
    if (!match || rows.has(match[1]) || Number(match[2]) > 100) return unavailable('Fresh Linux memory PSI is required.');
    rows.set(match[1], Number(match[2]));
  }
  if (rows.size !== 2) return unavailable('Both Linux memory PSI stall counters are required.');
  const pressure = headroomPressure(host.totalMemoryBytes, host.availableMemoryBytes);
  return { ...host, pressure: pressure === 'critical' || rows.get('full')! >= 1 ? 'critical' : pressure === 'warning' || rows.get('some')! >= 5 || rows.get('full')! > 0 ? 'warning' : 'normal' };
}
export function parseLinuxOwnedProcess(status: string, rollup: string, pid: number, parentPid: number): { rssBytes: number; swapBytes: number } {
  const field = (name: string) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)\\s*$`, 'm'))?.[1]);
  if (field('Pid') !== pid || field('PPid') !== parentPid || /^State:\s+Z\b/m.test(status)) return unavailable('The Linux memory sample does not belong to the live app-owned child.');
  // smaps_rollup is the precise page-table snapshot; VmRSS may be asynchronous.
  return { rssBytes: integer(kibField(rollup, 'Rss'), true), swapBytes: kibField(rollup, 'Swap') };
}
export function parseWindowsMemory(text: string, pid: number | null, parentPid: number): PlatformMemoryReading {
  let raw: any;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return unavailable('Windows returned malformed memory telemetry.'); }
  if (!raw || raw.schemaVersion !== 1 || raw.pid !== pid || raw.parentPid !== (pid === null ? null : parentPid)) return unavailable('The Windows memory sample does not belong to the app-owned child.');
  const totalMemoryBytes = integer(raw.totalMemoryBytes, true), availableMemoryBytes = integer(raw.availableMemoryBytes);
  const committedBytes = integer(raw.committedBytes), commitLimitBytes = integer(raw.commitLimitBytes, true);
  const rssBytes = integer(raw.rssBytes, pid !== null), privateCommitBytes = integer(raw.privateCommitBytes);
  if (availableMemoryBytes > totalMemoryBytes || committedBytes > commitLimitBytes || pid === null && (rssBytes !== 0 || privateCommitBytes !== 0)) return unavailable('Windows memory telemetry is inconsistent.');
  const sampledAt = new Date(integer(raw.sampledAtMilliseconds, true)).toISOString();
  if (Math.abs(Date.now() - Date.parse(sampledAt)) > 2000) return unavailable('The Windows memory sample is stale.');
  const headroom = headroomPressure(totalMemoryBytes, availableMemoryBytes), ratio = committedBytes / commitLimitBytes;
  const pressure: Pressure = headroom === 'critical' || ratio >= .95 ? 'critical' : headroom === 'warning' || ratio >= .9 ? 'warning' : 'normal';
  return { sampledAt, totalMemoryBytes, availableMemoryBytes, rssBytes, residentBytes: rssBytes, privateCommitBytes, pressure,
    monitor: { platform: 'win32', source: 'Win32_OperatingSystem+Process.WorkingSet64', pressureSource: 'available-headroom+system-commit-policy', pid, parentPid: pid === null ? null : parentPid } };
}
/** Fixed script; only validated integer PID values are interpolated. No profile,
 * network, process environment, command lines, or unrelated process data is read. */
export function windowsMemoryCommand(pid: number | null, parentPid: number): string {
  if (pid !== null) integer(pid, true); integer(parentPid, true);
  return `$ErrorActionPreference='Stop'; $os=Get-CimInstance Win32_OperatingSystem; $mem=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; ` +
    (pid === null ? '$owner=$null; $working=0; $private=0; ' : `$owner=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if(!$owner -or $owner.ParentProcessId -ne ${parentPid}){throw 'Owned process changed'}; $p=Get-Process -Id ${pid} -ErrorAction Stop; $p.Refresh(); $working=$p.WorkingSet64; $private=$p.PrivateMemorySize64; `) +
    `@{schemaVersion=1;pid=${pid === null ? '$null' : pid};parentPid=${pid === null ? '$null' : parentPid};totalMemoryBytes=([long]$os.TotalVisibleMemorySize*1024);availableMemoryBytes=([long]$os.FreePhysicalMemory*1024);committedBytes=[long]$mem.CommittedBytes;commitLimitBytes=[long]$mem.CommitLimit;rssBytes=[long]$working;privateCommitBytes=[long]$private;sampledAtMilliseconds=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress`;
}
export async function probePlatformMemory(pid: number | null, platform: 'linux' | 'win32', parentPid = process.pid): Promise<PlatformMemoryReading> {
  if (pid !== null) integer(pid, true); integer(parentPid, true);
  if (platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const result = await promisify(execFile)(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsMemoryCommand(pid, parentPid)], { timeout: 1800, maxBuffer: 16 * 1024, windowsHide: true });
    return parseWindowsMemory(result.stdout, pid, parentPid);
  }
  try {
    const [memory, psi, status, rollup] = await Promise.all([
      readFile('/proc/meminfo', 'utf8'), readFile('/proc/pressure/memory', 'utf8'),
      pid === null ? '' : readFile(`/proc/${pid}/status`, 'utf8'), pid === null ? '' : readFile(`/proc/${pid}/smaps_rollup`, 'utf8'),
    ]);
    const host = parseLinuxHostMemory(memory, psi), owned = pid === null ? { rssBytes: 0, swapBytes: 0 } : parseLinuxOwnedProcess(status, rollup, pid, parentPid);
    if (pid !== null) parseLinuxOwnedProcess(await readFile(`/proc/${pid}/status`, 'utf8'), rollup, pid, parentPid);
    return { ...host, ...owned, residentBytes: owned.rssBytes, sampledAt: new Date().toISOString(),
      monitor: { platform: 'linux', source: 'proc/meminfo+smaps_rollup', pressureSource: 'memory-PSI+available-headroom-policy', pid, parentPid: pid === null ? null : parentPid } };
  } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Fresh Linux MemAvailable, memory PSI and owned-process smaps telemetry are required.', { cause: error }); }
}
