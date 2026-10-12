import type { AgentStatus } from './types';

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
  return !!status?.runtime.ready && !status.runtime.error && status.runtime.state !== 'error' && !status.modelsError && !!model?.installed && !model.blockedReason && modelFitAllowsUse(status!, model.id);
}

export function modelFitAllowsUse(status: AgentStatus, modelId: string): boolean {
  const model = status.models.find(item => item.id === modelId);
  if (!model) return false;
  if (status.memoryMode === 'experimental-disk') return status.experimentalTrial?.modelId === modelId && status.experimentalTrial.state === 'passed';
  return model.fit !== 'insufficient' && (model.fit !== 'slow' || status.slowMode || status.memoryMode === 'low-memory');
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
  if (preparing || !runtime || runtime.state === 'starting' || runtime.state === 'stopped' || runtime.state === 'stopping') return { phase: 'preparing' as const, message: 'Preparing local engine…' };
  if (runtime.state === 'loading') return { phase: 'preparing' as const, message: 'Loading local model…' };
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
  if (selected.blockedReason) return selected.blockedReason;
  if (status?.memoryMode === 'experimental-disk' && !modelFitAllowsUse(status, selected.id)) return 'Experimental disk mode needs an explicit model trial. Open Models & hardware and choose Try Experimental disk mode.';
  if (selected.fit === 'insufficient') return 'This model does not fit available memory. Choose a smaller model.';
  if (selected.fit === 'slow' && status && !modelFitAllowsUse(status, selected.id)) return 'Enable slow mode or choose a smaller model.';
  return 'Choose a usable local model to begin.';
}
