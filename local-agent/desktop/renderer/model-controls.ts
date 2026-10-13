import type { AgentStatus, ExperimentalTrialView, LocalModel, MemoryMode, ModelProbe, ModelValidationRecord } from './types';

/** Suppress only the same failure already presented by a settled trial. */
export function trialDisplaysError(error: string | null | undefined, trial: ExperimentalTrialView | undefined, errorTrialId?: string) {
  const reason = trial?.reason || trial?.error?.message;
  if (!error || trial?.state !== 'failed' || !trial.id || errorTrialId !== trial.id || !reason) return false;
  if (error === reason) return true;
  let message = error;
  if (message.startsWith('Error invoking remote method ')) {
    const prefix = /^Error invoking remote method 'local-agent:(?:startModelTrial|tryExperimentalModel)': /.exec(message);
    if (!prefix) return false;
    message = message.slice(prefix[0].length);
  }
  for (let index = 0; index < 2; index++) {
    const prefix = /^(?:Error|RuntimeError): /.exec(message);
    if (!prefix) break;
    message = message.slice(prefix[0].length);
  }
  return message === reason;
}

export const memoryModes: { id: MemoryMode; label: string; description: string }[] = [
  { id: 'automatic', label: 'Automatic', description: 'Choose a supported CPU/GPU profile while keeping memory for the operating system.' },
  { id: 'low-memory', label: 'Low memory', description: 'Use a smaller context and batches to reduce workspace memory. Model weights still need usable memory.' },
];

export function validationMatches(status: AgentStatus, model: LocalModel, record: Pick<ModelValidationRecord, 'digest' | 'templateHash' | 'runtime' | 'profileSignature'>) {
  const engine = status.runtime.engineIdentity ?? status.runtime.version;
  return model.installed && !model.needsPreparation && !model.verificationError && model.integrity === 'verified' && !!model.digest && record.digest === model.digest
    && !!model.templateHash && record.templateHash === model.templateHash
    && !!engine && record.runtime === engine
    && !!status.profile?.profileSignature && record.profileSignature === status.profile.profileSignature;
}

export function currentValidation(status: AgentStatus, model: LocalModel) {
  const records = status.validationRecords?.filter(record => record.modelId === model.id) ?? [];
  const record = records.at(-1);
  // A historical validation must match the current weights, pinned runtime,
  // and execution profile before the UI presents it as current.
  const current = !!record && validationMatches(status, model, record) && record.status === 'passed'
    && record.checks.length > 0 && record.checks.every(check => check.status === 'passed');
  return { record, current: Boolean(current) };
}

export interface ModelEvidence { label: string; status: 'passed' | 'failed' | 'unverified'; detail: string; }

function probeEvidence(status: AgentStatus, model: LocalModel, probe: ModelProbe | undefined, kind: 'chat' | 'tool'): ModelEvidence {
  const label = kind === 'chat' ? 'Chat probe' : 'Tool format';
  if (probe) {
    const current = !!probe.digest && !!probe.templateHash && !!probe.runtime && !!probe.profileSignature
      && validationMatches(status, model, probe as Required<Pick<ModelProbe, 'digest' | 'templateHash' | 'runtime' | 'profileSignature'>>);
    if (current) return { label, status: probe.status, detail: probe.detail || `${label} ${probe.status} on this model and profile.` };
    if (probe.status === 'failed') return { label, status: 'failed', detail: `Previous probe failed. ${probe.detail || 'It does not validate the current profile.'}` };
  }
  const record = currentValidation(status, model).record;
  if (record && validationMatches(status, model, record)) {
    const check = record.checks.find(item => kind === 'chat' ? /chat/i.test(item.id) : /tool.*(?:format|probe)|(?:format|probe).*tool/i.test(item.id));
    if (check) return { label, status: check.status, detail: check.detail };
  }
  return { label, status: 'unverified', detail: `${label} has not been verified for these weights, template, engine, and profile.` };
}

export function modelEvidence(status: AgentStatus, model: LocalModel): ModelEvidence[] {
  const validation = currentValidation(status, model);
  return [
    { label: 'Model files', status: model.integrity === 'verified' && !!model.digest ? 'passed' : model.integrity === 'failed' || !!model.verificationError ? 'failed' : 'unverified', detail: model.verificationError || (model.integrity === 'verified' && model.digest ? 'All model files match their verified checksums.' : 'Checksums have not been verified in this runtime.') },
    probeEvidence(status, model, model.chatProbe, 'chat'), probeEvidence(status, model, model.toolProbe, 'tool'),
    { label: 'Task checks', status: validation.current ? 'passed' : validation.record?.status === 'failed' ? 'failed' : 'unverified', detail: validation.current ? 'Recorded task checks passed for these weights, template, engine, and profile.' : validation.record?.status === 'failed' ? 'A previous task validation failed. Review its checks; a successful load or speed measurement is separate.' : 'Task quality has not been verified for the current configuration.' },
  ];
}

export function canTrySsd(model: LocalModel) {
  return model.installed && model.ssdEligibility?.supported === true && !model.verificationError && model.integrity !== 'failed' && !model.trialBlocker;
}

/** Eligibility permits host preparation; only its successful probe enables tools. */
export function canPrepareTools(model: LocalModel | undefined) {
  if (model?.toolProbe?.status === 'failed') return false;
  return model?.toolCapable === true || model?.toolValidationEligible === true;
}

export function acquisitionReason(model: LocalModel) {
  return model.acquisitionBlocker?.message;
}

export function measuredMemory(bytes?: number) {
  return bytes === undefined || !Number.isFinite(bytes) ? 'Unknown' : `${(Math.max(0, bytes) / 1024 ** 3).toFixed(2)} GiB`;
}
