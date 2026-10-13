import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIB, operatingSystemReserve, parseMacAvailableMemory, type HardwareInfo } from './hardware.ts';
import type {FixedProbeDiagnostic} from './probes.ts';
import { RuntimeError } from './errors.ts';

export type MemoryMode = 'automatic' | 'low-memory' | 'experimental-disk' | 'ssd-experts';
export interface ResourceMeasurements {
  sampledAt: string;
  residentBytes: number;
  /** Physical footprint and RSS overlap. Never sum them. */
  physicalFootprintBytes?: number | null;
  rssBytes?: number;
  availableMemoryBytes: number;
  pressure: 'normal' | 'warning' | 'critical';
}
export interface ExperimentalTrial {
  probes?:{chat?:FixedProbeDiagnostic;tools?:FixedProbeDiagnostic};
  progress?:{stage:'verifying'|'planning'|'loading'|'probing';message?:string;completedBytes?:number;totalBytes?:number};
  id: string;
  mode?:MemoryMode;
  backendValidation?:'cpu-baseline'|'validated'|'qa-unvalidated';
  /** Integrity-covered numerical certificate, distinct from local Chat/tool/task checks. */
  parityReportDigest?:string;
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
  artifactSetDigest?:string; templateDigest?:string;engineDigest?:string;patchDigest?:string;
  allocationBudgetBytes?:number;streaming?:SSDStreamingStatus|null;memoryPlan?:SSDResourcePlan|null;
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

export interface SSDAllocationLedger {denseBytes:number;expertCacheBytes:number;stagingBytes:number;contextBytes:number;recurrentBytes:number;scratchBytes:number;uploadBytes:number;reservedBytes:number;totalBytes:number;}
export interface SSDStreamingStatus {
  workerIdentity:string;baseCommit:string;patchSha256:string;expectedGroups:number;streamedGroups:number;
  ioMode:string;cacheSlotsPerLayer:number;expertCacheBytes:number;ledger:SSDAllocationLedger;allocationBudgetBytes:number;residentLimitBytes:number;stage?:string;stopped?:boolean;stopReason?:string;reads?:number;hits?:number;deadlineArmed?:boolean;
  sampledAt:string;physicalFootprintBytes:number;rssBytes:number;lastProgress?:string;
  bytesRead?:number;cacheHits?:number;cacheMisses?:number;waves?:number;
  cpuKernel?:'unknown'|'standard'|'default';useExtraBufts?:boolean|null;cpuRepackTensorCount?:number|null;decodeThreads?:number|null;batchThreads?:number|null;
}
export const SSD_DEFAULT_PROFILE={backend:'cpu',contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,index:0} as const;
export const SSD_CPU_ARGUMENTS=['--no-repack','--threads','4','--threads-batch','4'] as const;
export interface SSDCPUProfileBinding {backend:string;backendArguments:string[];cpuKernel:'standard'|'default';useExtraBufts:boolean;decodeThreads:number;batchThreads:number;parityReportDigest:string|null;}
export function ssdProfileSignature(profile:typeof SSD_DEFAULT_PROFILE|{backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number},binding:{engineDigest:string;patchDigest:string;artifactSetDigest:string;templateDigest:string;allocationBudgetBytes:number;cacheBytes:number;backend?:string;backendArguments?:string[];cpuKernel?:string;useExtraBufts?:boolean;decodeThreads?:number;batchThreads?:number;parityReportDigest?:string|null}):string{
  return JSON.stringify({engineCommit:PINNED_ENGINE_COMMIT,memoryMode:'ssd-experts',...profile,...binding,slots:1,ioMode:'darwin-nocache',workers:2,cacheTypeK:'f16',cacheTypeV:'f16'});
}
export function validateSSDStreamingStatus(value:unknown,expected:{patchDigest:string;minimumSlotsPerLayer:number;expectedGroups:number;allocationBudgetBytes:number;residentLimitBytes?:number;cacheBytes?:number;backend?:string;cpuKernel?:string;useExtraBufts?:boolean;decodeThreads?:number;batchThreads?:number}):SSDStreamingStatus{
  const s=value as SSDStreamingStatus;
  if(!s||s.baseCommit!==PINNED_ENGINE_COMMIT||s.patchSha256!==expected.patchDigest||s.workerIdentity!=='free-local-agent-ssd-v1'||s.expectedGroups!==expected.expectedGroups||s.streamedGroups!==s.expectedGroups||s.expectedGroups<1||s.ioMode!=='darwin-nocache'||!Number.isSafeInteger(s.cacheSlotsPerLayer)||s.cacheSlotsPerLayer<expected.minimumSlotsPerLayer)throw new RuntimeError('SSD_STREAMING_NOT_CONFIRMED','The worker did not confirm all expected expert groups, the required slot floor, and descriptor-local SSD reads. Ordinary full-model loading is not accepted.');
  if(expected.backend==='cpu'&&(s.cpuKernel!=='standard'||s.useExtraBufts!==false||s.cpuRepackTensorCount!==0||s.decodeThreads!==4||s.batchThreads!==4))throw new RuntimeError('SSD_PARITY_UNVERIFIED','The SSD worker did not confirm the validated standard CPU kernel, disabled repacking and four inference threads.');
  const l=s.ledger,fields=['denseBytes','expertCacheBytes','stagingBytes','contextBytes','recurrentBytes','scratchBytes','uploadBytes','reservedBytes'] as const;
  if(s.allocationBudgetBytes!==expected.allocationBudgetBytes||expected.residentLimitBytes!==undefined&&s.residentLimitBytes!==expected.residentLimitBytes||expected.cacheBytes!==undefined&&s.expertCacheBytes>expected.cacheBytes)throw new RuntimeError('SSD_ALLOCATION_BUDGET','The worker did not confirm the exact requested cache, allocation and resident limits.');
  if(!l||fields.some(k=>!Number.isSafeInteger(l[k])||l[k]<0)||!Number.isSafeInteger(l.totalBytes)||fields.reduce((n,k)=>n+l[k],0)!==l.totalBytes||l.totalBytes>expected.allocationBudgetBytes||!Number.isSafeInteger(s.expertCacheBytes)||s.expertCacheBytes!==l.expertCacheBytes)throw new RuntimeError('SSD_ALLOCATION_BUDGET','The SSD worker allocation ledger is incomplete or exceeds its bounded budget.');
  if(!Number.isSafeInteger(s.physicalFootprintBytes)||s.physicalFootprintBytes<0||!Number.isSafeInteger(s.rssBytes)||s.rssBytes<0||!Number.isFinite(Date.parse(s.sampledAt))||Math.abs(Date.now()-Date.parse(s.sampledAt))>10000)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The SSD worker physical-footprint measurement is missing or stale.');
  return s;
}

export interface SSDResourcePlan {
  schemaVersion:number;baseCommit:string;patchSha256:string;plannerSourceSha256:string;workerIdentity:string;architecture:string;
  noAlloc:boolean;modelPayloadAllocatedBytes:number;mappedColdBytes:number;allocationBudgetBytes:number;residentLimitBytes:number;cacheBudgetBytes:number;expectedGroups:number;minimumSlotsPerLayer:number;cacheSlotsPerLayer:number;
  profile:{backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;cacheTypeK:string;cacheTypeV:string;swaFull:boolean;slots:number;ioWorkers:number;cpuKernel?:string;useExtraBufts?:boolean;cpuRepackTensorCount?:number;decodeThreads?:number;batchThreads?:number};
  loadingDenseStagingBytes?:number;loadingPeakBytes?:number;
  ledger:{denseBytes:number;expertCacheBytes:number;contextBytes:number;recurrentBytes:number;scratchBytes:number;stagingBytes:number;outputBytes:number;reservedBytes:number;cpuWorkspaceBytes:number;totalBytes:number};
}
export function validateSSDResourcePlan(value:unknown,expected:{architecture:string;backend:string;patchDigest:string;sourceDigest:string;expectedGroups:number;minimumSlotsPerLayer:number;rawDenseBytes:number;cacheBytes:number;minimumCacheBytes:number;allocationBudgetBytes:number;residentLimitBytes:number}):SSDResourcePlan{
  const p=value as SSDResourcePlan,q=p?.profile;
  if(!p||p.schemaVersion!==1||p.baseCommit!==PINNED_ENGINE_COMMIT||p.patchSha256!==expected.patchDigest||p.plannerSourceSha256!==expected.sourceDigest||p.workerIdentity!=='free-local-agent-ssd-v1'||p.architecture!==expected.architecture||p.allocationBudgetBytes!==expected.allocationBudgetBytes||p.residentLimitBytes!==expected.residentLimitBytes||p.cacheBudgetBytes!==expected.cacheBytes||p.noAlloc!==true||p.modelPayloadAllocatedBytes!==0||p.mappedColdBytes!==0||p.expectedGroups!==expected.expectedGroups||p.minimumSlotsPerLayer!==expected.minimumSlotsPerLayer||p.cacheSlotsPerLayer!==expected.minimumSlotsPerLayer||!q||q.backend!==expected.backend||q.contextTokens!==4096||q.outputTokens!==1024||q.batchTokens!==64||q.microBatchTokens!==16||q.cacheTypeK!=='f16'||q.cacheTypeV!=='f16'||q.swaFull!==false||q.slots!==1||q.ioWorkers!==2)throw new RuntimeError('SSD_PLAN_INVALID','The metadata-only planner did not confirm the exact model, worker source, streaming floor and fixed runtime profile.');
  if(expected.backend==='cpu'&&(q.cpuKernel!=='standard'||q.useExtraBufts!==false||q.cpuRepackTensorCount!==0||q.decodeThreads!==4||q.batchThreads!==4))throw new RuntimeError('SSD_PARITY_UNVERIFIED','The SSD planner did not confirm the validated standard CPU kernel and four inference threads.');
  const l=p.ledger,fields=['denseBytes','expertCacheBytes','contextBytes','recurrentBytes','scratchBytes','stagingBytes','outputBytes','reservedBytes','cpuWorkspaceBytes'] as const;
  if(!l||fields.some(k=>!Number.isSafeInteger(l[k])||l[k]<0)||!Number.isSafeInteger(l.totalBytes)||l.totalBytes!==fields.reduce((n,k)=>n+l[k],0)||l.denseBytes<expected.rawDenseBytes||l.expertCacheBytes>expected.cacheBytes||l.expertCacheBytes<expected.minimumCacheBytes||l.contextBytes<1||l.reservedBytes<256*1024**2)throw new RuntimeError('SSD_PLAN_INVALID','The native allocation plan is incomplete or does not include bounded weights, context and process headroom.');
  if(p.loadingPeakBytes!==undefined&&(!Number.isSafeInteger(p.loadingPeakBytes)||p.loadingPeakBytes<0)||p.loadingDenseStagingBytes!==undefined&&(!Number.isSafeInteger(p.loadingDenseStagingBytes)||p.loadingDenseStagingBytes<0||p.loadingDenseStagingBytes>(p.loadingPeakBytes??l.totalBytes)))throw new RuntimeError('SSD_PLAN_INVALID','The native loading peak or dense staging measurement is invalid.');
  if(p.loadingPeakBytes!==undefined&&p.loadingPeakBytes<l.denseBytes+(p.loadingDenseStagingBytes??0)+l.reservedBytes)throw new RuntimeError('SSD_PLAN_INVALID','The native loading peak omits resident dense weights, staging or process headroom.');
  return p;
}

export interface SSDNumericalConfiguration {
  modelSha256:string;templateSha256:string;architecture:string;backend:'cpu'|'metal';
  cpuKernel:string;useExtraBufts:boolean;cpuRepackTensorCount:number;
  baseCommit:string;workerPatchSha256:string;report:string;reportSha256:string;scope:string;
  profile:{contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;cacheSlotsPerLayer:number;cacheTypeK:string;cacheTypeV:string;swaFull:boolean;slots:number;ioWorkers:number;ioMode:string;decodeThreads:number;batchThreads:number};
}
/** A scoped computation certificate does not assert successful Chat or completed tasks. */
export function validateSSDNumericalProof(value:unknown,configuration:SSDNumericalConfiguration,patchDigest:string):boolean{
  const report=value as Partial<SSDNumericalConfiguration>&{schemaVersion?:number;passed?:boolean;baseCommit?:string};
  const p=configuration?.profile;
  if(!report||report.schemaVersion!==1||report.passed!==true||report.baseCommit!==PINNED_ENGINE_COMMIT||configuration.baseCommit!==PINNED_ENGINE_COMMIT||configuration.workerPatchSha256!==patchDigest||report.workerPatchSha256!==patchDigest||configuration.backend!=='cpu'||configuration.cpuKernel!=='standard'||configuration.useExtraBufts!==false||configuration.cpuRepackTensorCount!==0||configuration.scope!=='representative-experts-and-two-swa-layers'||configuration.architecture!=='gemma4'||!['modelSha256','templateSha256','reportSha256'].every(k=>/^[a-f0-9]{64}$/.test(configuration[k as 'modelSha256'|'templateSha256'|'reportSha256']))||!/^validation\/[a-zA-Z0-9._-]+\.json$/.test(configuration.report))return false;
  if(!p||p.contextTokens!==4096||p.outputTokens!==1024||p.batchTokens!==64||p.microBatchTokens!==16||p.cacheSlotsPerLayer!==24||p.cacheTypeK!=='f16'||p.cacheTypeV!=='f16'||p.swaFull!==false||p.slots!==1||p.ioWorkers!==2||p.ioMode!=='darwin-nocache'||p.decodeThreads!==4||p.batchThreads!==4)return false;
  const fields=['modelSha256','templateSha256','architecture','backend','cpuKernel','useExtraBufts','cpuRepackTensorCount','scope'] as const;
  return fields.every(k=>report[k]===configuration[k])&&Boolean(report.profile)&&Object.keys(p).every(k=>report.profile![k as keyof typeof p]===p[k as keyof typeof p]);
}
