import type { AgentStatus, LocalModel } from './types';

/** This exact route is supplied by runtime discovery, including its small reference. */
export function usesPortablePreparation(model: Pick<LocalModel, 'preparationProfile'> | undefined): boolean {
  return model?.preparationProfile === 'portable-cpu-4k-v1';
}
export function modelRequiresSlowModeToggle(status: Pick<AgentStatus, 'slowMode' | 'memoryMode'> | null | undefined, model: LocalModel | undefined): boolean {
  return model?.fit === 'slow' && !usesPortablePreparation(model) && !status?.slowMode && (status?.memoryMode ?? 'automatic') === 'automatic';
}

/** Only the newest request may update the UI, including failures. */
export function createStatusLoader<T>() {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    async load(fetch: () => Promise<T>, commit: (value: T) => void): Promise<T | undefined> {
      const request = ++generation;
      try {
        const value = await fetch();
        if (request !== generation) return undefined;
        commit(value);
        return value;
      } catch (error) {
        if (request !== generation) return undefined;
        throw error;
      }
    },
  };
}

export function modelIsUsable(status: AgentStatus | null) {
  const model = status?.models.find((item) => item.id === status.selectedModel);
  return !!status?.runtime.ready && !status.runtime.error && status.runtime.state !== 'error' && !status.modelsError && !!model?.installed && !model.verificationError && model.integrity !== 'failed' && !model.useBlocker && !model.blockedReason && modelFitAllowsUse(status!, model.id);
}

export function modelFitAllowsUse(status: AgentStatus, modelId: string): boolean {
  const model = status.models.find(item => item.id === modelId);
  if (!model) return false;
  // Match the idle Send path: experimental consent belongs to its own model.
  // Browsing or selecting a preference does not mutate the running/global mode.
  const memoryMode = (status.memoryMode === 'ssd-experts' || status.memoryMode === 'experimental-disk') && status.experimentalTrial?.modelId !== modelId ? 'automatic' : status.memoryMode;
  if (memoryMode === 'ssd-experts') {
    // The host has rechecked a saved SSD identity. Sending explicitly starts
    // preparation; this is not evidence that a worker or probe is running now.
    if (model.historicalBindingVerified === true && model.needsPreparation === true && model.integrity === 'verified' && !!model.digest) return true;
    const trial = status.experimentalTrial;
    return trial?.mode === 'ssd-experts' && trial.modelId === modelId && trial.state === 'passed' && trial.probePassed === true
      && model.integrity === 'verified' && !!model.digest && (trial.artifactSetDigest ?? trial.digest) === model.digest
      && !!model.templateHash && trial.templateDigest === model.templateHash
      && !!status.runtime.engineIdentity && trial.engineDigest === status.runtime.engineIdentity
      && !!status.profile?.profileSignature && trial.profileSignature === status.profile.profileSignature;
  }
  if (memoryMode === 'experimental-disk') return status.experimentalTrial?.modelId === modelId && status.experimentalTrial.state === 'passed';
  return model.fit !== 'insufficient' && (model.fit !== 'slow' || usesPortablePreparation(model) || status.slowMode || memoryMode === 'low-memory');
}

/** Retained weights can wait in the workspace while the engine initializes. */
export function shouldOpenModelSetup(status: AgentStatus) {
  if (status.modelsError || status.runtime.error || status.runtime.state === 'error') return true;
  const model = status.models.find((item) => item.id === status.selectedModel);
  return !model?.installed || !!model.blockedReason || !modelFitAllowsUse(status, model.id);
}

export function runtimePresentation(status: AgentStatus | null, preparing = false) {
  const runtime = status?.runtime;
  if (runtime?.error || runtime?.state === 'error') return { phase: 'error' as const, message: runtime.error || 'The local engine could not start. Retry preparation to recover.' };
  if (runtime?.state === 'loading') {
    const messages = { planning: 'Checking model memory…', loading: 'Loading with memory monitoring…', probing: 'Checking local chat and tools…' };
    return { phase: 'preparing' as const, message: runtime.preparationStage ? messages[runtime.preparationStage] : 'Loading local model…' };
  }
  if (preparing || !runtime || runtime.state === 'starting' || runtime.state === 'stopped' || runtime.state === 'stopping') return { phase: 'preparing' as const, message: 'Preparing local engine…' };
  return runtime.ready
    ? { phase: 'ready' as const, message: `Ready${runtime.version ? ` · ${runtime.version}` : ''}` }
    : { phase: 'preparing' as const, message: 'Preparing local engine…' };
}

export function modelSetupMessage(status: AgentStatus | null) {
  if (status?.modelsError) return 'The model library could not be read. Open setup to review the error.';
  const engine = runtimePresentation(status);
  if (engine.phase !== 'ready') return engine.message;
  const selected = status?.models.find((model) => model.id === status.selectedModel);
  if (!status?.models.some((model) => model.installed)) return 'Download or import your first model.';
  if (!selected?.installed) return 'Choose an available local model to begin.';
  if (selected.needsPreparation && selected.historicalBindingVerified) return 'The selected SSD model will prepare and recheck its probes when you send. No task has run.';
  if (selected.blockedReason) return selected.blockedReason;
  if (selected.needsPreparation) return 'The selected local model will load and check its chat and tool format when you send. Coding results are verified during each task.';
  if ((status?.memoryMode === 'experimental-disk' || status?.memoryMode === 'ssd-experts') && !modelFitAllowsUse(status, selected.id)) return 'This model needs a successful trial. Open Models and choose Try from SSD for a supported model.';
  if (selected.fit === 'insufficient') return 'This model does not fit available memory. Choose a smaller model.';
  if (selected.fit === 'slow' && status && !modelFitAllowsUse(status, selected.id)) return 'Enable slow mode or choose a smaller model.';
  return 'Choose a usable local model to begin.';
}
