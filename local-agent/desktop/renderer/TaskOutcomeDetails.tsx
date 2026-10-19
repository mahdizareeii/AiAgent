import Icon from './Icons';
import { outcomePresentation } from './task-evidence';
import type { TaskOutcome } from './types';
import { commandEvidencePresentation } from '../task-outcome';

export default function TaskOutcomeDetails({ outcome, context = 'task' }: { outcome: TaskOutcome; context?: 'task' | 'response' }) {
  const presentation = outcomePresentation(outcome);
  const title = context === 'response' ? presentation.title.replace(/^Task/, 'Response') : presentation.title;
  return <section className={`task-outcome ${presentation.checksPassed ? 'checks-passed' : ''}`} aria-label={context === 'response' ? 'Response outcome' : 'Task outcome'}>
    <div className="outcome-heading"><Icon name={presentation.checksPassed ? 'check' : 'shield'} size={16} /><strong>{title}</strong></div>
    <p>{outcome.finishReason}</p>
    {outcome.verification === 'passed' ? <p>The planned acceptance checks passed against current files and recorded test results. Review the plan for coverage of your request.</p>
      : outcome.verification ? <p>The requested result has not been fully verified. Completed changes are preserved.</p>
        : outcome.status === 'completed' && <p>Recorded checks describe individual operations. Review whether the result fulfills your request.</p>}
    {outcome.taskBrief && <details className="review-block"><summary>Frozen task plan</summary><p>{outcome.taskBrief.goal}</p>
      {!!outcome.taskBrief.deliverables.length && <p>Deliverables: {outcome.taskBrief.deliverables.map(file => <code key={file}>{file} </code>)}</p>}
      <ul>{outcome.taskBrief.criteria.map(criterion => <li key={criterion.id}><strong>{criterion.description}</strong><p>{criterion.kind === 'command' ? <code>{criterion.command}</code> : criterion.kind === 'manual' ? 'Requires review' : <code>{criterion.path}</code>}</p></li>)}</ul>
    </details>}
    <details open={presentation.failed > 0}>
      <summary>Evidence · {presentation.passed} passed{presentation.failed ? ` · ${presentation.failed} failed` : ''}{presentation.unverified ? ` · ${presentation.unverified} unverified` : ''}</summary>
      {outcome.checks.length ? <ul>{outcome.checks.map(check => {
        const presentation = commandEvidencePresentation(check);
        return <li key={check.id} className={`check-${check.status}`}><span className="check-label">{check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Unverified'}</span><strong>{check.purpose === 'acceptance' && check.evidence?.operation !== 'verify_command' ? 'Requirement: ' : ''}{presentation.title}</strong>{check.evidence?.operation === 'verify_command' ? presentation.detail.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p>{presentation.detail}</p>}{check.toolId && <small>Tool record: {check.toolId}</small>}</li>;
      })}</ul> : <p>No verification evidence was recorded for this {context}.</p>}
      {outcome.model && <p className="outcome-model">{outcome.model.id} · {outcome.model.backend} · {outcome.model.contextTokens.toLocaleString()} context · {outcome.model.memoryMode}<br />Model digest: <code>{outcome.model.digest}</code></p>}
    </details>
  </section>;
}
