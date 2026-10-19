import path from 'node:path';
import { MODEL_CATALOG, RuntimeError, classifyModel } from '../runtime/index.ts';
import type { AvailableModel, HardwareInfo, LocalInferenceRuntime, RuntimeStatus } from '../runtime/index.ts';
import type { AgentStatus, LocalModel } from './renderer/types.ts';

type ModelReader = Pick<LocalInferenceRuntime, 'listModels' | 'inspectModel' | 'getStatus'>;

/** A public rename must never relocate existing chats, weights or undo records. */
export function resolveStorage(appData: string, userDataOverride = ''): NonNullable<AgentStatus['storage']> {
  const dataPath = userDataOverride ? path.resolve(userDataOverride) : path.join(appData, 'Local Agent');
  return { profile: userDataOverride ? 'isolated' : 'regular', path: dataPath,
    modelCachePath: path.join(dataPath, 'gguf-runtime', 'models') };
}

export function desktopRuntimeStatus(current: RuntimeStatus, missingComponents?: string): AgentStatus['runtime'] {
  // A selected model whose file was removed needs model setup, not an engine repair.
  const error = current.error?.code === 'MODEL_NOT_FOUND' ? undefined : current.error;
  return { ready: current.state === 'ready' && !missingComponents,
    state: missingComponents ? 'error' : current.state, version: current.version ?? undefined,
    engineIdentity: current.engineIdentity,
    preparationStage: missingComponents ? undefined : current.preparationStage,
    nativeMemoryPlan: missingComponents ? undefined : current.nativeMemoryPlan,
    portableMemoryPlan: missingComponents ? undefined : current.portableMemoryPlan,
    portableAdmissionDiagnostic: missingComponents ? undefined : current.portableAdmissionDiagnostic,
    loadedModel: missingComponents ? undefined : current.loadedModel,
    error: missingComponents ?? error?.message,
    errorCode: missingComponents ? 'AGENT_COMPONENTS_MISSING' : error?.code };
}

function desktopModel(row: AvailableModel): LocalModel {
  return { id: row.id, name: row.title,
    downloadGB: (row.estimatedDownloadBytes ?? row.sizeBytes) / 1024 ** 3, description: row.description,
    installed: row.installed, blockedReason: row.blockedReason ?? undefined, verificationError: row.verificationError, fit: row.fit, fitReason: row.fitReason,
    license: row.license, quantization: row.quantization, workingMemoryGB: row.workingMemoryGB, memoryEstimate: row.memoryEstimate,
    toolCapable: row.toolCapable, toolValidationEligible: row.toolValidationEligible, measuredTokensPerSecond: row.measuredTokensPerSecond, sourceUrl: row.sourceUrl, digest: row.digest ?? undefined,
    integrity: row.integrity, artifacts: row.artifacts?.map(artifact => ({ ...artifact })),
    acquisitionBlocker: row.acquisitionBlocker, useBlocker: row.useBlocker, trialBlocker: row.trialBlocker,
    ssdEligibility: row.ssdEligibility, chatProbe: row.chatProbe, toolProbe: row.toolProbe,
    historicalBindingVerified: row.historicalBindingVerified, needsPreparation: row.needsPreparation, preparationProfile: row.preparationProfile,
    templateHash: row.templateHash ?? row.chatProbe?.templateHash ?? row.toolProbe?.templateHash,
    taskGuidance: row.taskGuidance?.map(guidance => ({ ...guidance, examples: [...guidance.examples] })), emitsThinking: row.emitsThinking };
}

/** A discovery failure must not look like a successfully discovered empty library. */
export async function discoverDesktopModels(reader: Pick<ModelReader, 'listModels'>, hardware: HardwareInfo): Promise<Pick<AgentStatus, 'models' | 'modelsError'>> {
  try { return { models: (await reader.listModels()).map(desktopModel) }; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const modelsError = `Could not inspect the local model library. Check access to the model cache and retry. ${detail}`;
    return { modelsError, models: MODEL_CATALOG.map(spec => desktopModel({ ...spec, ...classifyModel(spec, hardware),
      installed: false, sizeBytes: 0, digest: null,
      blockedReason: 'Model discovery failed. Retry before downloading or selecting a model.' })) };
  }
}

/** Verify before persisting a new task or constructing any turn, tools, or backend. */
export async function assertInferenceReady(reader: Pick<ModelReader, 'getStatus' | 'inspectModel'>, selectedModel: string | null, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!selectedModel) throw new RuntimeError('MODEL_NOT_FOUND', 'Choose a downloaded or imported local model before sending. Your request has not run.');
  const current = reader.getStatus();
  if (current.state !== 'ready') {
    if (current.state === 'starting' || current.state === 'loading') throw new RuntimeError('ENGINE_PREPARING', 'The local engine is still preparing. Wait for it to finish before sending. Your request has not run.');
    throw new RuntimeError(current.error?.code ?? 'ENGINE_NOT_READY', current.error?.message ?? 'The local engine is not ready. Open Models & setup and retry the engine. Your request has not run.');
  }
  await reader.inspectModel(selectedModel, { signal });
  // Keep cancellation authoritative even if a cached or third-party reader
  // finishes without rejecting the aborted inspection.
  signal?.throwIfAborted();
  return selectedModel;
}

/** Keep an installed selection; a successful first download repairs a missing one. */
export async function selectionAfterDownload(reader: Pick<ModelReader, 'inspectModel'>, selectedModel: string | null, downloaded: string): Promise<string> {
  if (selectedModel && selectedModel !== downloaded) {
    try { await reader.inspectModel(selectedModel); return selectedModel; } catch {}
  }
  return downloaded;
}
