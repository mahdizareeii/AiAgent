import type { KeyboardEvent, RefObject } from 'react';
import Icon from './Icons';
import PreferenceChoice from './PreferenceChoice';
import ProbeDiagnostics from './ProbeDiagnostics';
import TrialHistory from './TrialHistory';
import KernelDiagnostics from './KernelDiagnostics';
import { modelFitAllowsUse, runtimePresentation } from './status-flow';
import { acquisitionReason, canTrySsd, currentValidation, measuredMemory, memoryModes, modelEvidence, trialDisplaysError } from './model-controls';
import type { AgentStatus, DownloadProgress, LocalModel, MemoryMode, Mode, StageProgress, TaskEffort } from './types';

const memory = (bytes: number) => `${(Math.max(0, bytes) / 1024 ** 3).toFixed(1)} GiB`;
const guidanceIcons = { coding: 'code', websites: 'monitor', automation: 'settings', documents: 'folder', research: 'search' } as const;
const defaultGuidance: NonNullable<LocalModel['taskGuidance']> = [
  { id: 'coding', label: 'Coding', icon: 'code', description: 'Write, explain, and debug code.', examples: ['Python', 'JavaScript'] },
  { id: 'websites', label: 'Websites', icon: 'monitor', description: 'Build project files and check a local website.', examples: ['React', 'WordPress'] },
  { id: 'automation', label: 'Automation', icon: 'settings', description: 'Create scripts and use approved commands.', examples: ['Shell scripts', 'Node.js CLI'] },
  { id: 'documents', label: 'Documents', icon: 'folder', description: 'Work with text, source files, and text PDFs.', examples: ['Text PDFs', 'Project notes'] },
  { id: 'research', label: 'Research', icon: 'search', description: 'Compare sources through the optional Research plugin.', examples: ['Official documentation', 'Release notes'] },
];
function intendedUses(model: LocalModel) {
  if (model.taskGuidance?.length) return model.taskGuidance;
  return model.toolCapable || model.toolValidationEligible ? defaultGuidance : defaultGuidance.filter(item => item.id === 'documents');
}

export function activeModelDownload(local: DownloadProgress | null, status: AgentStatus | null): DownloadProgress | null {
  if (local) return local;
  if (!status?.downloadingModel) return null;
  if (status.downloadProgress?.modelId === status.downloadingModel) return status.downloadProgress;
  return { modelId: status.downloadingModel, progress: { status: 'Downloading in the background' } };
}

export function ModelDownloadStatus({ download, models, cancelling = false, onCancel }: {
  download: DownloadProgress; models: LocalModel[]; cancelling?: boolean; onCancel: () => Promise<void>;
}) {
  const name = models.find(model => model.id === download.modelId)?.name ?? download.modelId;
  const total = download.progress.total && Number.isFinite(download.progress.total) && download.progress.total > 0 ? download.progress.total : undefined;
  const completed = Number.isFinite(download.progress.completed) ? Math.max(0, download.progress.completed!) : 0;
  const fraction = total ? Math.min(1, completed / total) : undefined;
  const phase = /verif|hash|checksum/i.test(download.progress.status) ? 'Verifying' : /cancel/i.test(download.progress.status) ? 'Cancelling' : /start/i.test(download.progress.status) ? 'Starting' : 'Downloading';
  return <div className="stage-banner model-download-banner" role="status" aria-label="Model download">
    <div title={download.progress.status}><Icon name="download" size={15} /><strong>{name}</strong><span className="stage-count">{phase}{total ? ` · ${memory(completed)} / ${memory(total)} · ${Math.floor(fraction! * 100)}%` : ''}</span></div>
    {total ? <progress value={Math.min(completed, total)} max={total} aria-label={`${name} download progress`} /> : <progress aria-label={`${name} download progress`} />}
    <button className="secondary-button" disabled={cancelling} onClick={() => void onCancel()}>{cancelling ? 'Cancelling…' : 'Cancel download'}</button>
  </div>;
}

interface Props {
  status: AgentStatus | null; mode: Mode; ready: boolean; busy: boolean; setupBusy: boolean;
  calibrating: string | null; trialModel: string | null; validating: string | null; importing: boolean;
  download: DownloadProgress | null; stage: StageProgress | null; error: string | null; hasBridge: boolean;
  errorTrialId?: string;
  cancellingDownload?: boolean;
  taskEffort?: TaskEffort; taskPreferencesLocked?: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void; onClose: () => void;
  onSetup: () => Promise<void>; onImport: () => Promise<void>; onCalibrate: (id: string) => Promise<void>;
  onSelect: (id: string) => Promise<void>; onDownload: (id: string) => Promise<void>;
  onCancelDownload: () => Promise<void>; onSlowMode: (enabled: boolean) => Promise<void>;
  onMemoryMode: (mode: MemoryMode) => Promise<void>; onTryModel: (id: string) => Promise<void>;
  onCancelTrial: (trialId: string) => Promise<void>; onValidate: (id: string) => Promise<void>;
  onTaskEffort?: (effort: TaskEffort) => Promise<void>; onSsdTaskHours?: (hours: 4 | 8) => Promise<void>;
}

function ModelDetails({ model, status }: { model: LocalModel; status: AgentStatus }) {
  const guidance = intendedUses(model);
  const validation = currentValidation(status, model);
  const estimate = model.memoryEstimate;
  return <details className="model-details"><summary>Abilities & details</summary>
    <p className="guidance-note">These examples describe intended uses. Installed software and enabled tools determine what the app can execute. Research requires the optional plugin; web access starts off.</p>
    <ul className="ability-descriptions">{guidance.map(item => <li key={item.id}><strong><Icon name={guidanceIcons[item.id]} size={14} />{item.label}</strong><p>{item.description} <span>{item.examples.join(' · ')}</span></p></li>)}</ul>
    <div className="model-specs"><span>{/Q4[_ ]/i.test(model.quantization) ? '4-bit weights · ' : ''}{model.quantization || 'GGUF'} · {model.license || 'License not reported'}</span><span>{model.workingMemoryGB > 0 ? `~${model.workingMemoryGB.toFixed(1)} GiB estimated ordinary working memory` : 'Working memory not estimated'}</span><span>{model.toolCapable ? 'Tool-compatible template; task quality needs its own checks.' : model.toolValidationEligible ? 'Preparation checks tool format before task tools run.' : 'Chat only until tool format is validated.'}</span>{model.emitsThinking === false && <span>This model does not emit thinking blocks. Working shows its actual tool activity.</span>}{model.artifacts && model.artifacts.length > 1 && <span>{model.artifacts.length} GGUF parts · every part must be verified</span>}{model.measuredTokensPerSecond !== undefined && <span>{model.measuredTokensPerSecond.toFixed(1)} tokens/sec measured · not a quality score</span>}</div>
    {estimate && <div className="model-memory"><h5>Ordinary memory estimate · 8K context</h5><dl>{[
      ['Model weights', estimate.weightsBytes], ['Context workspace', estimate.contextBytes], ['Scratch space', estimate.scratchBytes], ['Reserved for OS', estimate.osReserveBytes], ['System budget', estimate.systemBudgetBytes], ['GPU budget', estimate.gpuBudgetBytes],
    ].map(([label, bytes]) => <div key={String(label)}><dt>{label}</dt><dd>{memory(Number(bytes))}</dd></div>)}</dl><p>Estimated, not measured peak memory. Apple unified memory is counted once.</p></div>}
    {model.ssdEligibility && <p>{model.ssdEligibility.reason}{model.ssdEligibility.minimumSlotsPerLayer ? ` Minimum ${model.ssdEligibility.minimumSlotsPerLayer} cache slots per layer.` : ''}</p>}
    {model.sourceUrl && <a className="model-source" href={model.sourceUrl} target="_blank" rel="noreferrer">Publisher, model & license<Icon name="external" size={12} /></a>}
    {validation.record && <details className="model-validation"><summary>{validation.current ? 'Task validation passed for this configuration' : `Previous task validation: ${validation.record.status}`}</summary><p>{validation.record.completedAt ? new Date(validation.record.completedAt).toLocaleString() : 'Validation is running'}{validation.record.elapsedMs !== undefined ? ` · ${(validation.record.elapsedMs / 1000).toFixed(1)} sec` : ''}</p><ul>{validation.record.checks.map(check => <li key={check.id}><strong>{check.status}: {check.title}</strong><p>{check.detail}</p></li>)}</ul><p>Bound to its recorded weights, template, engine, and execution profile.</p><code>{validation.record.digest}<br />{validation.record.profileSignature}</code></details>}
  </details>;
}

function Trial({ status, active, hasBridge, onCancel }: { status: AgentStatus; active: boolean; hasBridge: boolean; onCancel: (trialId: string) => Promise<void> }) {
  const trial = status.experimentalTrial;
  if (!trial) return null;
  const ssd = trial.mode === 'ssd-experts';
  const streaming = trial.streaming;
  const progress = trial.progress;
  const stageTitles = { verifying: 'Verifying model files…', planning: 'Checking the memory budget…', loading: 'Loading trial model…', probing: 'Checking Chat and tool format…' };
  const heading = trial.state === 'passed' ? trial.probePassed === true ? 'Load and Chat probe passed' : 'Trial result unverified'
    : ['loading', 'calibrating'].includes(trial.state) ? progress ? stageTitles[progress.stage] : trial.state === 'loading' ? 'Loading trial model…' : 'Probing local inference…' : `Trial ${trial.state}`;
  const totalBytes = progress?.stage === 'verifying' && progress.totalBytes && Number.isFinite(progress.totalBytes) && progress.totalBytes > 0 ? progress.totalBytes : undefined;
  const completedBytes = Number.isFinite(progress?.completedBytes) ? Math.max(0, progress!.completedBytes!) : undefined;
  const showProgress = ['loading', 'calibrating'].includes(trial.state) && progress;
  const metrics: [string, string][] = ssd ? [
    ['Expert cache', measuredMemory(streaming?.cacheBytes ?? trial.cacheBytes)], ['Read from SSD', measuredMemory(streaming?.bytesRead ?? trial.bytesRead)], ['Cache hits / misses', `${streaming?.cacheHits ?? trial.cacheHits ?? 'Unknown'} / ${streaming?.cacheMisses ?? trial.cacheMisses ?? 'Unknown'}`], ['Streaming expert groups', `${streaming?.expertGroups ?? 'Unknown'} / ${streaming?.expectedExpertGroups ?? 'Unknown'}`],
  ] : [['Mapped weights', measuredMemory(trial.mappedBytes)], ['Lazy eligible', measuredMemory(trial.lazyEligibleBytes)]];
  metrics.push(['Physical footprint sample', measuredMemory(trial.physicalFootprintBytes)], ['Peak physical footprint', measuredMemory(trial.peakPhysicalFootprintBytes)], ['Last RSS sample', measuredMemory(trial.rssBytes)], ['Peak RSS sample', measuredMemory(trial.peakRssBytes)], ['Resident limit', measuredMemory(trial.limitBytes)], ['Last available sample', measuredMemory(trial.availableMemoryBytes)], ['Memory pressure', trial.pressure ?? 'Unknown']);
  return <section className={`model-trial trial-${trial.state}`} aria-label="Model trial"><div className="trial-heading"><strong>{heading}</strong><span>{status.models.find(model => model.id === trial.modelId)?.name ?? trial.modelId}</span>{active && <button className="secondary-button" disabled={!hasBridge || !trial.id} onClick={() => { if (trial.id) void onCancel(trial.id); }}>Cancel trial</button>}</div>{showProgress && <div className="download-state" aria-label="Model trial progress"><p>{progress.message}{totalBytes && completedBytes !== undefined ? ` · ${memory(completedBytes)} / ${memory(totalBytes)}` : ''}</p>{totalBytes && completedBytes !== undefined && <div className="download-progress" role="progressbar" aria-label="Model file verification" aria-valuemin={0} aria-valuemax={totalBytes} aria-valuenow={Math.min(completedBytes, totalBytes)}><div style={{ width: `${Math.min(1, completedBytes / totalBytes) * 100}%` }} /></div>}</div>}{(trial.reason || trial.error?.message) && <p role={['failed', 'stopped'].includes(trial.state) ? 'alert' : 'status'}>{trial.reason || trial.error?.message}</p>}{trial.state === 'passed' && <p>{trial.toolProbePassed === true ? 'Tool format passed. Task quality needs separate checks.' : trial.toolProbePassed === false ? 'Chat only. Task tool format did not pass.' : 'Task tool format is unverified.'}</p>}<p>{ssd ? 'SSD experts uses a bounded expert cache. A successful load is separate from passing a real task.' : 'Previous mapped-weight trial. This result does not validate SSD expert streaming.'}</p><details className="trial-details"><summary>Trial identity & resource measurements</summary>{trial.id && <p>Trial ID: <code>{trial.id}</code></p>}{trial.finishedAt && <p>Finished: {new Date(trial.finishedAt).toLocaleString()}</p>}{(trial.error?.code || trial.errorCode) && <p>Error code: <code>{trial.error?.code || trial.errorCode}</code></p>}{progress && <p>Recorded stage: {progress.stage}</p>}<dl className="trial-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>Footprint and RSS overlap and are not added together. Unknown means no measurement was available; samples are not an absolute peak guarantee.</p></details></section>;
}


export default function ModelSetup(props: Props) {
  const { status, ready, busy, setupBusy, calibrating, importing, download, stage, error, hasBridge } = props;
  const trialActive = !!props.trialModel || ['loading', 'calibrating'].includes(status?.experimentalTrial?.state ?? '');
  const locked = busy || setupBusy || importing || !!calibrating || !!download || trialActive || !!props.validating;
  const closeLocked = busy || setupBusy || importing || !!calibrating || trialActive || !!props.validating;
  const duplicateTrialFailure = !setupBusy && !importing && !calibrating && !download && !props.trialModel && !props.validating
    && trialDisplaysError(error, status?.experimentalTrial, props.errorTrialId);
  const hardware = status?.hardware;
  const engine = runtimePresentation(status, setupBusy);
  const firstModel = status && !status.modelsError && !status.models.some(model => model.installed);
  const memoryMode = status?.memoryMode ?? 'automatic';
  const advancedModes = [...memoryModes, ...(memoryMode === 'ssd-experts' ? [{ id: 'ssd-experts' as const, label: 'SSD experts · current model', description: 'This model uses SSD expert streaming. Review its current probe and task checks.' }] : memoryMode === 'experimental-disk' ? [{ id: 'experimental-disk' as const, label: 'Previous mapped-weight mode', description: 'This older mode does not validate SSD streaming. Use Try from SSD for a supported model.' }] : [])];
  return <div className="modal-backdrop setup-backdrop" onKeyDown={props.onKeyDown}><div className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title" ref={props.dialogRef}>
    <div className="setup-header"><span className="setup-label"><Icon name="monitor" size={18} />Models</span><button className="icon-button" aria-label="Close setup" disabled={closeLocked} onClick={props.onClose}><Icon name="close" size={18} /></button></div>
    <h2 id="setup-title">{firstModel ? 'Your AI, on your computer.' : 'Choose your local model'}</h2><p className="setup-description">Download or import a free model. Everything needed for local inference is included.</p>
    {engine.phase === 'error' && <div className="setup-error" role="alert"><strong>Local engine needs attention</strong><p>{engine.message}</p><button className="text-button" disabled={!hasBridge || locked} onClick={() => void props.onSetup()}>Retry engine</button></div>}
    {hardware && <p className="computer-summary"><Icon name="monitor" size={15} />This computer · {memory(hardware.totalMemoryBytes)} memory · {hardware.freeDiskBytes > 0 ? `${memory(hardware.freeDiskBytes)} free storage` : 'storage being checked'}</p>}
    {download && <ModelDownloadStatus download={download} models={status?.models ?? []} cancelling={props.cancellingDownload} onCancel={props.onCancelDownload} />}
    <section className="model-section" aria-label="Model library"><div className="model-section-heading"><p>Choose by the work you need. Larger models can be slower; check their recorded results.</p><button className="secondary-button import-model" disabled={!hasBridge || locked} onClick={() => void props.onImport()}><Icon name="folder" size={14} />{importing ? 'Importing…' : 'Import GGUF'}</button></div>
      {status?.modelsError && <div className="setup-error" role="alert"><strong>Model library unavailable</strong><p>{status.modelsError}</p><button className="text-button" disabled={locked || !hasBridge} onClick={() => void props.onSetup()}>Retry model library</button></div>}
      <div className="model-cards">{status?.models.map(model => {
        const progress = download?.modelId === model.id ? download.progress : null;
        const repairable = !!model.verificationError && !!model.sourceUrl;
        const allowed = modelFitAllowsUse(status, model.id);
        const selected = status.selectedModel === model.id && model.installed && allowed && !model.verificationError && !model.useBlocker && !model.blockedReason;
        const slow = model.fit === 'slow' && !status.slowMode && memoryMode === 'automatic';
        const oversized = model.fit === 'insufficient';
        const ssd = canTrySsd(model);
        const downloadBlocked = acquisitionReason(model);
        const primaryDownload = !model.installed || repairable;
        const primarySsd = !primaryDownload && !selected && oversized && model.ssdEligibility?.supported;
        const useReason = slow && model.useBlocker?.code === 'SLOW_MODE_REQUIRED' ? undefined : model.useBlocker?.message || model.blockedReason;
        const guidance = intendedUses(model);
        return <article className={`model-card ${selected ? 'model-selected' : ''}`} key={model.id}>
          <div className="model-card-top"><h4>{model.name}</h4><div className="model-card-labels"><span className={`fit-pill fit-${model.fit}`}>{model.fit === 'recommended' ? 'Recommended' : model.fit === 'slow' ? 'Slow mode' : 'Insufficient memory'}</span>{status.recommendation === model.id && <span className="recommendation-pill">Suggested first</span>}<span className="model-size">{model.downloadGB > 0 ? `${model.downloadGB.toFixed(1)} GiB` : 'Local import'}</span></div></div>
          <p className="model-description">{model.description}</p><div className="model-abilities" aria-label="Intended uses · guidance">{guidance.map(item => <span key={item.id} title={`${item.description} Examples: ${item.examples.join(', ')}. Intended use, not a verified result.`}><Icon name={guidanceIcons[item.id]} size={14} />{item.label}</span>)}</div><p className="model-fit-reason">{model.fitReason}</p>
          {oversized && <p className="ssd-card-note">{model.ssdEligibility?.supported ? 'Try a bounded expert cache from SSD. This may take hours.' : model.ssdEligibility?.reason || 'This configuration needs more usable memory or a smaller quantization.'}</p>}
          <ul className="model-evidence" aria-label="Recorded model evidence">{modelEvidence(status, model).map(item => <li key={item.label} className={`evidence-${item.status}`} title={item.detail}><span>{item.label}</span><strong>{item.status === 'passed' ? 'Passed' : item.status === 'failed' ? 'Failed' : 'Unverified'}</strong></li>)}</ul>
          {progress ? <p className="model-fit-reason">Downloading · progress shown above</p> : <div className="model-buttons"><button className={selected ? 'selected-model-button' : 'secondary-button model-action'} disabled={locked || !hasBridge || selected || !!status.modelsError || (primaryDownload ? !!downloadBlocked : primarySsd ? !ssd : !status.runtime.ready || oversized || !!model.verificationError || !!useReason)} onClick={() => primaryDownload ? void props.onDownload(model.id) : primarySsd ? void props.onTryModel(model.id) : void props.onSelect(model.id)}><Icon name={selected ? 'check' : primaryDownload ? 'download' : primarySsd ? 'monitor' : 'arrow'} size={15} />{selected ? 'Selected' : repairable ? 'Download again' : primaryDownload ? 'Download' : primarySsd ? 'Try from SSD' : slow ? 'Use in slow mode' : 'Use model'}</button>{(primaryDownload ? downloadBlocked : primarySsd ? model.trialBlocker?.message : useReason) && <p className="blocked-reason">{primaryDownload ? downloadBlocked : primarySsd ? model.trialBlocker?.message : useReason}</p>}</div>}
          <ModelDetails model={model} status={status} />
        </article>;
      })}</div>{!status && <p className="muted">Connecting to the local runtime…</p>}
    </section>
    {status?.experimentalTrial && <Trial status={status} active={trialActive} hasBridge={hasBridge} onCancel={props.onCancelTrial} />}
    {setupBusy && stage && <div className="setup-stage" role="status"><span className="spinner" /><span>{stage.message || stage.stage}</span></div>}
    {error && error !== status?.runtime.error && !duplicateTrialFailure && <div className="setup-error" role="alert">{error}{!status && <button className="text-button" disabled={locked || !hasBridge} onClick={() => void props.onSetup()}>Retry connection</button>}</div>}
    <details className="model-advanced"><summary><Icon name="settings" size={15} />Advanced<span>Hardware, execution & diagnostics</span></summary><div className="advanced-content">
      {status?.experimentalTrial && <KernelDiagnostics trial={status.experimentalTrial} />}
      {status?.experimentalTrial && <ProbeDiagnostics trial={status.experimentalTrial} />}
      {status && (status.trialHistory !== undefined || status.trialHistoryError) && <TrialHistory entries={status.trialHistory} error={status.trialHistoryError} models={status.models} />}
      <section className="hardware-card" aria-label="Detected hardware"><div className="hardware-heading"><Icon name="monitor" size={19} /><h3>Your hardware</h3><span>{hardware ? `${hardware.platform} · ${hardware.architecture}` : 'Detecting…'}</span></div>{hardware ? <><p className="hardware-cpu">{hardware.cpuModel}<span>{hardware.cpuCores} cores</span></p><div className="hardware-metrics"><div><strong>{memory(hardware.totalMemoryBytes)}</strong><span>System memory</span></div><div><strong>{memory(hardware.availableMemoryBytes)}</strong><span>Available now</span></div><div><strong>{hardware.freeDiskBytes > 0 ? memory(hardware.freeDiskBytes) : 'Unknown'}</strong><span>Free storage</span></div></div><div className="hardware-gpus">{hardware.gpus.length ? hardware.gpus.map((gpu, index) => <span key={`${gpu.name}-${index}`}><span className="status-dot online" />{gpu.name}<small>{gpu.backend}{gpu.unifiedMemory ? ' · unified memory' : gpu.totalMemoryBytes ? ` · ${memory(gpu.totalMemoryBytes)}` : ''}</small></span>) : <span>CPU inference<small>No supported GPU reported</small></span>}</div></> : <p className="muted">Detecting memory, storage, and compute backends.</p>}</section>
      <section className={`bundled-runtime-card ${engine.phase === 'error' ? 'runtime-error' : ''}`} aria-label="Local engine status"><div><h3><span className={`status-dot ${engine.phase === 'ready' ? 'online' : ''}`} />Bundled local runtime</h3><p role={engine.phase === 'error' ? 'alert' : 'status'}>{engine.message}{engine.phase === 'ready' && status?.profile ? ` · ${status.profile.label || status.profile.backend} · ${status.profile.contextTokens.toLocaleString()} token context` : ''}</p>{status?.runtime.errorCode && <small className="runtime-error-code">{status.runtime.errorCode}</small>}</div><button className="text-button" disabled={!hasBridge || locked} onClick={() => void props.onSetup()}>{setupBusy ? <span className="spinner" /> : <Icon name={engine.phase === 'ready' ? 'check' : 'monitor'} size={15} />}{setupBusy ? 'Preparing…' : engine.phase === 'ready' ? 'Check runtime' : engine.phase === 'error' ? 'Retry runtime' : 'Prepare engine'}</button></section>
      <section className="memory-controls" aria-labelledby="memory-mode-title"><div className="memory-controls-heading"><h3 id="memory-mode-title">Memory profile</h3><PreferenceChoice label="Memory profile" value={memoryMode} disabled={!hasBridge || locked} options={advancedModes.map(item => ({ value: item.id, label: item.label }))} onChange={value => void props.onMemoryMode(value as MemoryMode)} minimumWidth={250} /></div><p>{advancedModes.find(item => item.id === memoryMode)?.description}</p></section>
      {props.mode === 'coding' && props.onTaskEffort && <section className="advanced-setting"><div><h3>Task execution</h3><p>Tasks plan, implement, verify, and repair by default. Direct execution is an optional override.</p></div><PreferenceChoice label="Task execution" value={props.taskEffort ?? 'careful'} options={[{ value: 'careful', label: 'Plan & verify' }, { value: 'standard', label: 'Direct execution' }]} disabled={locked || props.taskPreferencesLocked || !hasBridge} onChange={value => void props.onTaskEffort?.(value as TaskEffort)} minimumWidth={230} /></section>}
      {props.onSsdTaskHours && <section className="advanced-setting"><div><h3>SSD task time</h3><p>Active execution budget for new SSD tasks. Approval waits pause this clock; command limits stay unchanged.</p></div><PreferenceChoice label="SSD task time" value={String(status?.ssdTaskHours ?? 4)} options={[{ value: '4', label: '4 hours' }, { value: '8', label: '8 hours' }]} disabled={locked || props.taskPreferencesLocked || !hasBridge} onChange={value => void props.onSsdTaskHours?.(Number(value) as 4 | 8)} minimumWidth={180} /></section>}
      {status && memoryMode === 'automatic' && <label className="slow-mode-control"><div><strong>Allow slow profiles</strong><p>Permit supported CPU offloading or smaller context. Model weights still need usable memory.</p></div><input type="checkbox" checked={status.slowMode} disabled={locked || !hasBridge} onChange={event => void props.onSlowMode(event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>}
      <section className="model-diagnostics" aria-label="Model checks"><h3>Model checks</h3><p>Speed calibration measures performance and tool format. Task validation runs a separate file task through normal approvals.</p>{status?.models.filter(model => model.installed).map(model => <div key={model.id} className="diagnostic-model"><strong>{model.name}</strong><div><button className="secondary-button" disabled={locked || !!model.verificationError || !modelFitAllowsUse(status, model.id) || !status.runtime.ready || !hasBridge} onClick={() => void props.onCalibrate(model.id)}>{calibrating === model.id ? <span className="spinner" /> : <Icon name="monitor" size={14} />}{calibrating === model.id ? 'Measuring…' : 'Measure speed & tool format'}</button><button className="secondary-button" disabled={locked || !model.toolCapable || !!model.verificationError || !modelFitAllowsUse(status, model.id) || !status.runtime.ready || !hasBridge} onClick={() => void props.onValidate(model.id)}><Icon name="check" size={14} />Validate model for tasks</button>{canTrySsd(model) && model.fit !== 'insufficient' && <button className="text-button" disabled={locked || !hasBridge} onClick={() => void props.onTryModel(model.id)}>Try from SSD</button>}</div></div>)}</section>
      {status?.storage && <details className={`profile-storage ${status.storage.profile === 'isolated' ? 'profile-isolated' : ''}`} open={status.storage.profile === 'isolated'}><summary>{status.storage.profile === 'isolated' ? 'Separate test profile · independent chats and models' : 'Storage locations'}</summary><dl><div><dt>App data</dt><dd>{status.storage.path}</dd></div><div><dt>Model files</dt><dd>{status.storage.modelCachePath}</dd></div></dl></details>}
      <div className="model-guide"><p><strong>Quantization</strong> stores weights at lower precision to reduce memory and storage, with some quality tradeoff.</p><p>SSD streaming reads cold routed experts from disk. Attention, shared experts, context, and working buffers must still fit in memory. It can be very slow. Neither larger size nor successful loading guarantees a correct task or Astra/Claude-level reasoning.</p></div>
    </div></details>
    <div className="setup-footer"><span><Icon name="shield" size={15} />{ready ? status?.models.find(model => model.id === status.selectedModel)?.needsPreparation ? 'Selected model prepares when you send' : 'Local model ready' : 'Choose a usable model before sending'}</span><button className="primary-button" disabled={closeLocked} onClick={props.onClose}>{ready ? props.mode === 'assistant' ? 'Back to chat' : 'Back to task' : 'Choose later'}<Icon name="chevron" size={15} /></button></div>
  </div></div>;
}
