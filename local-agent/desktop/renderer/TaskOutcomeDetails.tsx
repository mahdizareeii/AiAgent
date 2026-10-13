import Icon from './Icons';
import { outcomePresentation } from './task-evidence';
import type { TaskOutcome } from './types';

export default function TaskOutcomeDetails({ outcome, context = 'task' }: { outcome: TaskOutcome; context?: 'task' | 'response' }) {
  const presentation = outcomePresentation(outcome);
  const title = context === 'response' ? presentation.title.replace(/^Task/, 'Response') : presentation.title;
  return <section className={`task-outcome ${presentation.checksPassed ? 'checks-passed' : ''}`} aria-label={context === 'response' ? 'Response outcome' : 'Task outcome'}>
    <div className="outcome-heading"><Icon name={presentation.checksPassed ? 'check' : 'shield'} size={16} /><strong>{title}</strong></div>
    <p>{outcome.finishReason}</p>
    {outcome.status === 'completed' && <p>Recorded checks describe individual operations. Review whether the result fulfills your request.</p>}
    <details open={presentation.failed > 0}>
      <summary>Evidence · {presentation.passed} passed{presentation.failed ? ` · ${presentation.failed} failed` : ''}{presentation.unverified ? ` · ${presentation.unverified} unverified` : ''}</summary>
      {outcome.checks.length ? <ul>{outcome.checks.map(check => <li key={check.id} className={`check-${check.status}`}><span className="check-label">{check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Unverified'}</span><strong>{check.title}</strong><p>{check.detail}</p>{check.toolId && <small>Tool record: {check.toolId}</small>}</li>)}</ul> : <p>No verification evidence was recorded for this {context}.</p>}
      {outcome.model && <p className="outcome-model">{outcome.model.id} · {outcome.model.backend} · {outcome.model.contextTokens.toLocaleString()} context · {outcome.model.memoryMode}<br />Model digest: <code>{outcome.model.digest}</code></p>}
    </details>
  </section>;
}
