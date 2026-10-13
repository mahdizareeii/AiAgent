import ProbeDiagnostics from './ProbeDiagnostics';
import KernelDiagnostics from './KernelDiagnostics';
import { measuredMemory } from './model-controls';
import type { AgentStatus, SSDTrialHistoryEntry } from './types';

function date(value: string | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unreported';
}

function text(value: string | undefined, limit = 8192) {
  if (!value) return 'Unreported';
  return value.length > limit ? `${value.slice(0, limit)}\n[Excerpt truncated]` : value;
}

function check(value: string | undefined) {
  return value === 'passed' ? 'Passed (recorded)' : value === 'failed' ? 'Failed' : 'Unverified';
}

function Attempt({ entry, modelName }: { entry: SSDTrialHistoryEntry; modelName: string }) {
  const sample = entry.resources?.measurements;
  const streaming = entry.resources?.streaming;
  return <details className="review-block" aria-label={`Historical SSD attempt: ${entry.id}`}>
    <summary><span title={entry.startedAt}>{date(entry.startedAt)}</span> · {text(modelName, 256)} · {entry.state}</summary>
    <dl className="trial-metrics">
      <div><dt>Recorded Chat check</dt><dd>{check(entry.checks?.chat)}</dd></div>
      <div><dt>Recorded tool-format check</dt><dd>{check(entry.checks?.tools)}</dd></div>
      <div><dt>Finished</dt><dd title={entry.finishedAt}>{date(entry.finishedAt)}</dd></div>
      <div><dt>Last stage</dt><dd>{entry.progress?.stage ?? 'Unreported'}</dd></div>
    </dl>
    {entry.error && <p><strong>{text(entry.error.code, 128)}</strong>: {text(entry.error.message, 4096)}</p>}
    {entry.progress?.message && <p>{text(entry.progress.message, 512)}</p>}
    <KernelDiagnostics trial={{ backendValidation: entry.backendValidation, parityReportDigest: entry.parityReportDigest, streaming }} />
    <details className="review-block"><summary>Historical model &amp; execution identity</summary><pre>{JSON.stringify({
      trialId: text(entry.id, 36), model: text(entry.model, 256), modelDigest: text(entry.artifactSetDigest, 64),
      templateDigest: text(entry.templateDigest, 64), engineDigest: text(entry.engineDigest, 64),
      workerPatchDigest: text(entry.patchDigest, 64), executionProfile: text(entry.profileSignature),
    }, null, 2)}</pre></details>
    {entry.resources && <details className="review-block"><summary>Recorded resource samples</summary><dl className="trial-metrics">{[
      ['Resident budget', measuredMemory(entry.resources.residentBudgetBytes ?? undefined)],
      ['Allocation budget', measuredMemory(entry.resources.allocationBudgetBytes)],
      ['Physical footprint sample', measuredMemory(sample?.physicalFootprintBytes ?? undefined)],
      ['RSS sample', measuredMemory(sample?.rssBytes)], ['Available memory sample', measuredMemory(sample?.availableMemoryBytes)],
      ['Expert cache', measuredMemory(streaming?.expertCacheBytes)], ['Read from SSD', measuredMemory(streaming?.bytesRead)],
      ['Streaming expert groups', `${streaming?.streamedGroups ?? 'Unknown'} / ${streaming?.expectedGroups ?? 'Unknown'}`],
      ['Slots per layer', String(streaming?.cacheSlotsPerLayer ?? 'Unknown')],
      ['Cache misses', String(streaming?.cacheMisses ?? 'Unknown')], ['Prefill waves', String(streaming?.waves ?? 'Unknown')],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>Sampled: {date(sample?.sampledAt)} · Pressure: {sample?.pressure ?? 'Unknown'}. Physical footprint and RSS overlap; these historical samples are not a current memory guarantee.</p></details>}
    <ProbeDiagnostics trial={entry} />
  </details>;
}

export default function TrialHistory({ entries = [], error, models }: {
  entries?: SSDTrialHistoryEntry[]; error?: AgentStatus['trialHistoryError']; models: AgentStatus['models'];
}) {
  const bounded = entries.slice(0, 100);
  return <details className="model-validation review-block" aria-label="Historical SSD attempts">
    <summary>Historical SSD attempts · {bounded.length}</summary>
    <p>Past attempts are retained for diagnosis, newest first. They do not activate models or establish current readiness. Checks without observed results remain Unverified.</p>
    {error && <p role="alert"><strong>{text(error.code, 128)}</strong>: {text(error.message, 4096)} Inference does not use this history.</p>}
    {!bounded.length && <p>No historical SSD attempts are available.</p>}
    {bounded.map(entry => <Attempt key={entry.id} entry={entry} modelName={models.find(model => model.id === entry.model)?.name ?? entry.model} />)}
  </details>;
}
