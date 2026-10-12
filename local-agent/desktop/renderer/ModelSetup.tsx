import type { KeyboardEvent, RefObject } from 'react';
import Icon from './Icons';
import PreferenceChoice from './PreferenceChoice';
import { modelFitAllowsUse, runtimePresentation } from './status-flow';
import { currentValidation, measuredMemory, memoryModes } from './model-controls';
import type { AgentStatus, DownloadProgress, LocalModel, MemoryMode, Mode, StageProgress } from './types';

function memory(bytes: number) {
  return `${(Math.max(0, bytes) / 1024 ** 3).toFixed(1)} GB`;
}

function downloadSize(bytes?: number) {
  return bytes ? memory(bytes) : '0 GB';
}

function quantizationLabel(value: string) {
  return /Q4[_ ]/i.test(value) ? `4-bit weights · ${value}` : value || 'GGUF';
}

function MemoryEstimate({ estimate }: { estimate: LocalModel['memoryEstimate'] }) {
  if (!estimate) return null;
  return <details className="model-memory"><summary>Memory estimate · baseline 8K context</summary><dl>
    <div><dt>Model weights</dt><dd>{memory(estimate.weightsBytes)}</dd></div>
    <div><dt>Context workspace</dt><dd>{memory(estimate.contextBytes)}</dd></div>
    <div><dt>Scratch space</dt><dd>{memory(estimate.scratchBytes)}</dd></div>
    <div><dt>Reserved for OS</dt><dd>{memory(estimate.osReserveBytes)}</dd></div>
    <div><dt>System budget</dt><dd>{memory(estimate.systemBudgetBytes)}</dd></div>
    <div><dt>GPU budget</dt><dd>{memory(estimate.gpuBudgetBytes)}</dd></div>
  </dl><p>Estimates, not measured peak memory. Unified GPU memory shares system RAM.</p></details>;
}

interface Props {
  status: AgentStatus | null;
  mode: Mode;
  ready: boolean;
  busy: boolean;
  setupBusy: boolean;
  calibrating: string | null;
  trialModel: string | null;
  validating: string | null;
  importing: boolean;
  download: DownloadProgress | null;
  stage: StageProgress | null;
  error: string | null;
  hasBridge: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onSetup: () => Promise<void>;
  onImport: () => Promise<void>;
  onCalibrate: (id: string) => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onDownload: (id: string) => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onSlowMode: (enabled: boolean) => Promise<void>;
  onMemoryMode: (mode: MemoryMode) => Promise<void>;
  onTryModel: (id: string) => Promise<void>;
  onCancelTrial: () => Promise<void>;
  onValidate: (id: string) => Promise<void>;
}

export default function ModelSetup(props: Props) {
  const { status, ready, busy, setupBusy, calibrating, importing, download, stage, error, hasBridge } = props;
  const locked = busy || setupBusy || importing || !!calibrating || !!download || !!props.trialModel || !!props.validating;
  const hardware = status?.hardware;
  const engine = runtimePresentation(status, setupBusy);
  const firstModel = status && !status.modelsError && !status.models.some((model) => model.installed);
  const memoryMode = status?.memoryMode ?? 'automatic';
  const trial = status?.experimentalTrial;
  const trialActive = !!props.trialModel || trial?.state === 'loading' || trial?.state === 'calibrating';

  return <div className="modal-backdrop setup-backdrop" onKeyDown={props.onKeyDown}><div className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title" ref={props.dialogRef}>
    <div className="setup-header"><span className="setup-label"><Icon name="monitor" size={18} />Models & hardware</span><button className="icon-button" aria-label="Close setup" disabled={locked} onClick={props.onClose}><Icon name="close" size={18} /></button></div>
    <h2 id="setup-title">{firstModel ? 'Download or import your first model' : 'Choose your local model'}</h2><p className="setup-description">Download a model that fits this computer, or import a GGUF file.<br />The inference engine is included. No account or API key is needed.</p>
    {status?.storage && <details className={`profile-storage ${status.storage.profile === 'isolated' ? 'profile-isolated' : ''}`} open={status.storage.profile === 'isolated'}><summary>{status.storage.profile === 'isolated' ? 'Separate test profile · independent chats and models' : 'Storage locations'}</summary><dl><div><dt>App data</dt><dd>{status.storage.path}</dd></div><div><dt>Model files</dt><dd>{status.storage.modelCachePath}</dd></div></dl></details>}
    <section className="hardware-card" aria-label="Detected hardware">
      <div className="hardware-heading"><Icon name="monitor" size={19} /><h3>Your hardware</h3><span>{hardware ? `${hardware.platform} · ${hardware.architecture}` : 'Detecting…'}</span></div>
      {hardware ? <><p className="hardware-cpu">{hardware.cpuModel}<span>{hardware.cpuCores} cores</span></p><div className="hardware-metrics"><div><strong>{memory(hardware.totalMemoryBytes)}</strong><span>System memory</span></div><div><strong>{memory(hardware.availableMemoryBytes)}</strong><span>Available now</span></div><div><strong>{hardware.freeDiskBytes > 0 ? memory(hardware.freeDiskBytes) : 'Unknown'}</strong><span>Free storage</span></div></div><div className="hardware-gpus">{hardware.gpus.length ? hardware.gpus.map((gpu, index) => <span key={`${gpu.name}-${index}`}><span className="status-dot online" />{gpu.name}<small>{gpu.backend}{gpu.unifiedMemory ? ' · unified memory' : gpu.totalMemoryBytes ? ` · ${memory(gpu.totalMemoryBytes)}` : ''}</small></span>) : <span><span className="status-dot" />CPU inference<small>No supported GPU reported</small></span>}</div></> : <p className="muted">Detecting memory, storage, and available compute backends.</p>}
    </section>
    <section className={`bundled-runtime-card ${engine.phase === 'error' ? 'runtime-error' : ''}`} aria-label="Local engine status"><div><h3><span className={`status-dot ${engine.phase === 'ready' ? 'online' : ''}`} />Bundled local runtime</h3><p role={engine.phase === 'error' ? 'alert' : 'status'}>{engine.message}{engine.phase === 'ready' && status?.profile ? ` · ${status.profile.label || status.profile.backend} · ${status.profile.contextTokens.toLocaleString()} token context` : ''}</p>{status?.runtime.errorCode && <small className="runtime-error-code">{status.runtime.errorCode}</small>}</div><button className="text-button" disabled={!hasBridge || locked} onClick={() => void props.onSetup()}>{setupBusy ? <span className="spinner" /> : <Icon name={engine.phase === 'ready' ? 'check' : 'monitor'} size={15} />}{setupBusy ? 'Preparing…' : engine.phase === 'ready' ? 'Check runtime' : engine.phase === 'error' ? 'Retry runtime' : 'Prepare engine'}</button></section>
    {setupBusy && stage && <div className="setup-stage" role="status"><span className="spinner" /><span>{stage.message || stage.stage}</span></div>}
    <section className="memory-controls" aria-labelledby="memory-mode-title"><div className="memory-controls-heading"><h3 id="memory-mode-title">Memory mode</h3><PreferenceChoice label="Memory mode" value={memoryMode} disabled={!hasBridge || locked} options={memoryModes.map(mode => ({ value: mode.id, label: mode.label }))} onChange={value => void props.onMemoryMode(value as MemoryMode)} minimumWidth={230} /></div><p>{memoryModes.find(mode => mode.id === memoryMode)?.description}</p>{memoryMode === 'experimental-disk' && <p className="experimental-note">Each model requires an explicit Try. Changing memory mode invalidates the trial. Passing this probe does not verify agent task reliability.</p>}</section>
    {trial && <section className={`model-trial trial-${trial.state}`} aria-label="Experimental model trial"><div className="trial-heading"><strong>{trial.state === 'passed' ? 'Load and probe passed' : trial.state === 'loading' ? 'Loading trial model…' : trial.state === 'calibrating' ? 'Probing local inference…' : `Trial ${trial.state}`}</strong><span>{status?.models.find(model => model.id === trial.modelId)?.name ?? trial.modelId}</span>{(trialActive || trial.state === 'passed') && <button className="secondary-button" disabled={!hasBridge} onClick={() => void props.onCancelTrial()}>Cancel trial</button>}</div>{trial.reason && <p role={trial.state === 'failed' ? 'alert' : 'status'}>{trial.reason}</p>}<dl className="trial-metrics"><div><dt>Mapped weights</dt><dd>{measuredMemory(trial.mappedBytes)}</dd></div><div><dt>Lazy eligible</dt><dd>{measuredMemory(trial.lazyEligibleBytes)}</dd></div><div><dt>Last resident sample</dt><dd>{measuredMemory(trial.rssBytes)}</dd></div><div><dt>Peak resident</dt><dd>{measuredMemory(trial.peakRssBytes)}</dd></div><div><dt>Resident limit</dt><dd>{measuredMemory(trial.limitBytes)}</dd></div><div><dt>Last available sample</dt><dd>{measuredMemory(trial.availableMemoryBytes)}</dd></div><div><dt>Memory pressure</dt><dd>{trial.pressure ?? 'Unknown'}</dd></div></dl><p>Mapped and lazy eligible sizes come from the engine. Resident memory is measured; unavailable measurements are shown as Unknown.</p></section>}
    <section className="model-section"><div className="model-section-heading"><div><h3>Choose a model</h3><p>Memory fit is an estimate. Speed calibration and task validation are separate checks.</p></div><button className="secondary-button import-model" disabled={!hasBridge || locked} onClick={() => void props.onImport()}><Icon name="folder" size={14} />{importing ? 'Importing…' : 'Import GGUF'}</button></div>
      {status?.modelsError && <div className="setup-error" role="alert"><strong>Model library unavailable</strong><p>{status.modelsError}</p><button className="text-button" disabled={locked || !hasBridge} onClick={() => void props.onSetup()}>Retry model library</button></div>}
      <div className="model-cards">{status?.models.map((model) => {
        const progress = download?.modelId === model.id ? download.progress : null;
        const fraction = progress?.total ? Math.min(1, (progress.completed ?? 0) / progress.total) : 0;
        const selected = status.selectedModel === model.id && model.installed && !model.blockedReason;
        const repairable = !!model.verificationError && !!model.sourceUrl;
        const unsupported = model.fit === 'insufficient' && memoryMode !== 'experimental-disk';
        const requiresSlowMode = model.fit === 'slow' && !status.slowMode && memoryMode === 'automatic';
        const allowed = modelFitAllowsUse(status, model.id);
        const validation = currentValidation(status, model);
        return <article className={`model-card ${selected ? 'model-selected' : ''}`} key={model.id}>
          <div className="model-card-top"><h4>{model.name}</h4><span className={`fit-pill fit-${model.fit}`}>{model.fit === 'recommended' ? 'Recommended' : model.fit === 'slow' ? 'Slow mode' : 'Insufficient memory'}</span>{status.recommendation === model.id && <span className="recommendation-pill">Suggested first</span>}</div>
          <p>{model.description}</p><p className="model-fit-reason">{model.fitReason}</p>
          <div className="model-specs"><span>{quantizationLabel(model.quantization)} · {model.license || 'License not reported'}</span><span>{model.workingMemoryGB > 0 ? `~${model.workingMemoryGB.toFixed(1)} GB estimated working memory` : 'Working memory not estimated'}</span><span>{model.toolCapable ? 'Agent-capable template · validate task reliability separately' : 'Chat only · no agent tools'}</span>{model.measuredTokensPerSecond !== undefined && <strong>{model.measuredTokensPerSecond.toFixed(1)} tokens/sec measured</strong>}</div>
          <MemoryEstimate estimate={model.memoryEstimate} />
          <div className="model-meta"><span>{model.downloadGB > 0 ? `${model.downloadGB.toFixed(1)} GB model` : 'Imported local model'}</span>{model.installed && <span className="installed-tag"><Icon name={model.verificationError ? 'close' : 'check'} size={12} />{model.verificationError ? 'Needs repair' : 'Available'}</span>}</div>
          {model.sourceUrl && <a className="model-source" href={model.sourceUrl} target="_blank" rel="noreferrer">Model source<Icon name="external" size={10} /></a>}
          {model.blockedReason && <p className="blocked-reason">{model.blockedReason}</p>}
          {requiresSlowMode && !model.blockedReason && <p className="blocked-reason">Allow slow mode below or choose Low memory to use this model.</p>}
          {progress ? <div className="download-state" role="status"><div className="download-progress"><div style={{ width: `${fraction * 100}%` }} /></div><div className="download-detail"><span>{progress.status}{progress.total ? ` · ${downloadSize(progress.completed)} / ${downloadSize(progress.total)}` : ''}</span><button className="text-button" onClick={() => void props.onCancelDownload()}>Cancel</button></div></div> : <div className="model-buttons">
            {memoryMode === 'experimental-disk' && model.installed && !repairable && !model.blockedReason && !allowed
              ? <button className="secondary-button model-action" disabled={locked || !hasBridge} onClick={() => void props.onTryModel(model.id)}><Icon name="monitor" size={15} />Try Experimental disk mode</button>
              : <button className={selected && allowed ? 'selected-model-button' : 'secondary-button model-action'} disabled={locked || !status.runtime.ready || (!!model.blockedReason && !repairable) || unsupported || requiresSlowMode || !hasBridge || (selected && allowed)} onClick={() => repairable || !model.installed ? void props.onDownload(model.id) : void props.onSelect(model.id)}><Icon name={selected && allowed ? 'check' : repairable || !model.installed ? 'download' : 'arrow'} size={15} />{selected && allowed ? 'Selected' : repairable ? 'Download again' : model.installed ? 'Use model' : 'Download model'}</button>}
            {model.installed && <button className="text-button calibrate-button" disabled={locked || !!model.blockedReason || !allowed || !status.runtime.ready || !hasBridge} onClick={() => void props.onCalibrate(model.id)}>{calibrating === model.id ? <span className="spinner" /> : <Icon name="monitor" size={12} />}{calibrating === model.id ? 'Measuring…' : 'Measure speed & tool format'}</button>}
            {model.installed && model.toolCapable && <button className="secondary-button validation-button" disabled={locked || !!model.blockedReason || !allowed || !status.runtime.ready || !hasBridge} onClick={() => void props.onValidate(model.id)}><Icon name="check" size={13} />Validate model for tasks</button>}
          </div>}
          {validation.record && <details className="model-validation"><summary>{validation.current ? 'Recorded task validation passed for this profile' : `Previous task validation: ${validation.record.status}`}</summary><p>{validation.record.completedAt ? new Date(validation.record.completedAt).toLocaleString() : 'Validation is running'}{validation.record.elapsedMs !== undefined ? ` · ${(validation.record.elapsedMs / 1000).toFixed(1)} sec` : ''}</p><ul>{validation.record.checks.map(check => <li key={check.id}><strong>{check.status}: {check.title}</strong><p>{check.detail}</p></li>)}</ul><p>Applies to the recorded model digest, template, runtime and execution profile.</p><code>{validation.record.digest}<br />{validation.record.profileSignature}</code></details>}
        </article>;
      })}</div>{!status && <p className="muted">Connecting to the bundled runtime…</p>}
      <div className="model-guide"><p><strong>What does 4-bit mean?</strong> Q4_K_M and QAT Q4_0 store model weights at lower precision. They use less memory and storage than full-precision weights, with some quality tradeoff.</p><details><summary>Memory fit, calibration, and licenses</summary><p>Automatic and Low memory require model weights to fit in the usable memory budget, including expert models with fewer active parameters. Staged reading reduces the context size; it does not shrink the model. Experimental disk mode tries mapped CPU weights under a measured resident-memory limit, and may fail or run very slowly. Load/probe success and speed calibration do not establish task reliability.</p><p>Apache 2.0 models are free to use under an open license, subject to its license and notice conditions. Open <strong>Model source</strong> for the publisher’s model and license details. Imported files may use different licenses.</p></details></div>
    </section>
    {status && memoryMode === 'automatic' && <label className="slow-mode-control"><div><strong>Allow slow mode</strong><p>Permit models that may need CPU offloading or smaller context. Responses can take longer.</p></div><input type="checkbox" checked={status.slowMode} disabled={locked || !hasBridge} onChange={(event) => void props.onSlowMode(event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>}
    {error && error !== status?.runtime.error && <div className="setup-error" role="alert">{error}{!status && <button className="text-button" disabled={locked || !hasBridge} onClick={() => void props.onSetup()}>Retry connection</button>}</div>}
    <div className="setup-footer"><span><Icon name="shield" size={15} />{ready ? 'Local model ready' : 'Choose a usable model before sending a task'}</span><button className="primary-button" disabled={locked} onClick={props.onClose}>{ready ? 'Back to task' : 'Choose later'}<Icon name="chevron" size={15} /></button></div>
  </div></div>;
}
