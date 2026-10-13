import type { ExperimentalTrialView, FixedProbeDiagnostic } from './types';

function count(value: number | null | undefined) {
  return Number.isSafeInteger(value) && value! >= 0 ? String(value) : 'Unreported';
}

function excerpt(value: string | null | undefined, limit: number) {
  if (typeof value !== 'string') return 'Unreported';
  if (value === '') return '(empty string)';
  return value.length > limit ? `${value.slice(0, limit)}\n[Excerpt truncated]` : value;
}

function ProbeRecord({ kind, diagnostic }: { kind: 'chat' | 'tools'; diagnostic?: FixedProbeDiagnostic }) {
  const label = kind === 'chat' ? 'Chat probe' : 'Tool-format probe';
  const record = diagnostic?.kind === kind ? diagnostic : undefined;
  if (!record) return <section className="review-block" aria-label={label}><h4>{label} · Unverified</h4><p>No response was recorded for this fixed check.</p></section>;
  const clipped = record.truncated || (record.content?.length ?? 0) > 512 || (record.reasoning?.length ?? 0) > 512 || record.toolCalls.length > 2
    || record.toolCalls.some(call => (call.name?.length ?? 0) > 128 || (call.arguments?.length ?? 0) > 512);
  return <section className="review-block" aria-label={label}>
    <h4>{label} · {record.passed ? 'Passed (recorded)' : 'Failed'}</h4>
    <dl className="trial-metrics">
      <div><dt>Finish reason</dt><dd>{excerpt(record.finishReason, 64)}</dd></div>
      <div><dt>Output tokens</dt><dd>{count(record.outputTokens)} / {count(record.requestedOutputTokens)} allowed</dd></div>
      <div><dt>Reasoning tokens</dt><dd>{count(record.reasoningTokens)}</dd></div>
      <div><dt>Tool calls</dt><dd>{count(record.toolCallCount)}</dd></div>
      <div><dt>Request thinking</dt><dd>Disabled</dd></div>
    </dl>
    <h5>Content returned</h5><pre>{excerpt(record.content, 512)}</pre>
    <h5>Reasoning returned</h5><pre>{excerpt(record.reasoning, 512)}</pre>
    {record.toolCalls.slice(0, 2).map((call, index) => <div className="review-block" key={index}><h5>Tool call {index + 1}: {excerpt(call.name, 128)}</h5><pre>{excerpt(call.arguments, 512)}</pre></div>)}
    {clipped && <p>Bounded excerpts are shown. The recorded response was truncated.</p>}
    <details className="review-block"><summary>Recorded identity</summary><dl className="trial-metrics">{[
      ['Model', record.binding.model], ['Model digest', record.binding.digest], ['Template digest', record.binding.templateHash],
      ['Engine', record.binding.runtime], ['Execution profile', record.binding.profileSignature], ['Trial ID', record.binding.trialId],
    ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{excerpt(value, name === 'Execution profile' ? 2048 : 256)}</code></dd></div>)}</dl></details>
  </section>;
}

export default function ProbeDiagnostics({ trial }: { trial: Pick<ExperimentalTrialView, 'probes'> }) {
  return <details className="model-validation review-block" aria-label="Fixed local probe diagnostics">
    <summary>Chat &amp; tool probe diagnostics</summary>
    <p>These are responses to fixed local checks. They do not establish task quality or validate a different model configuration.</p>
    <ProbeRecord kind="chat" diagnostic={trial.probes?.chat} />
    <ProbeRecord kind="tools" diagnostic={trial.probes?.tools} />
  </details>;
}
