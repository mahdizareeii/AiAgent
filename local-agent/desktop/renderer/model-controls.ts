import type { AgentStatus, LocalModel, MemoryMode } from './types';

export const memoryModes: { id: MemoryMode; label: string; description: string }[] = [
  { id: 'automatic', label: 'Automatic', description: 'Choose a supported CPU/GPU profile while keeping memory for the operating system.' },
  { id: 'low-memory', label: 'Low memory', description: 'Use a smaller context and batches to reduce workspace memory. Model weights still need usable memory.' },
  { id: 'experimental-disk', label: 'Experimental disk', description: 'Explicitly try a CPU profile with mapped model weights. Disk paging can be very slow. A bounded load and probe must pass before tasks can start.' },
];

export function currentValidation(status: AgentStatus, model: LocalModel) {
  const records = status.validationRecords?.filter(record => record.modelId === model.id) ?? [];
  const record = records.at(-1);
  // A historical validation must match the current weights, pinned runtime,
  // and execution profile before the UI presents it as current.
  const current = !!record && model.installed && !model.blockedReason && !!model.digest && record.digest === model.digest
    && !!status.runtime.version && record.runtime === status.runtime.version
    && !!status.profile?.profileSignature && record.profileSignature === status.profile.profileSignature && record.status === 'passed'
    && record.checks.length > 0 && record.checks.every(check => check.status === 'passed');
  return { record, current: Boolean(current) };
}

export function measuredMemory(bytes?: number) {
  return bytes === undefined || !Number.isFinite(bytes) ? 'Unknown' : `${(Math.max(0, bytes) / 1024 ** 3).toFixed(2)} GB`;
}
