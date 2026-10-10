import Icon from './Icons';
import type { StageProgress, ToolActivity } from './types';

export default function WorkingDetails({ thinking, active, thinkingActive, waitingApproval, stage, tools = [] }: {
  thinking?: string;
  active: boolean;
  thinkingActive?: boolean;
  waitingApproval?: boolean;
  stage?: StageProgress | null;
  tools?: ToolActivity[];
}) {
  const label = active ? 'Working' : thinking ? 'Thinking' : 'Task activity';
  const status = active ? waitingApproval ? 'Waiting for your approval' : thinkingActive ? 'Thinking locally' : stage?.message || stage?.stage || 'Working locally' : undefined;
  return <details className={`working-details ${active ? 'is-active' : ''}`}>
    <summary className="working-status" aria-label={label}>
      <Icon name="chevron" size={12} />
      {active && <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>}
      <span>{label}</span>
      {status && <span className="working-stage-label">{status.replace(/[_-]/g, ' ')}</span>}
      {!!tools.length && <span className="working-tool-count">{tools.length} {tools.length === 1 ? 'activity' : 'activities'}</span>}
    </summary>
    <div className="working-content">
      <h3>Model thinking</h3>
      {thinking ? <pre className="thinking-text">{thinking}</pre> : <p className="thinking-unavailable">{active ? 'Thinking text has not been provided for this reply yet.' : 'This model did not provide thinking text for this reply.'}</p>}
      {active && stage && <p className="working-current-stage"><strong>Current stage</strong><span>{stage.message || stage.stage.replace(/[_-]/g, ' ')}</span></p>}
      {!!tools.length && <div className="tool-activity working-tool-activity" aria-label="Tool activity">{tools.map(tool => <details key={tool.id}>
        <summary><span className={`tool-dot ${['completed', 'success'].includes(tool.status) ? 'complete' : ['failed', 'error'].includes(tool.status) ? 'failed' : ''}`} /><span>{tool.title}</span><span className="tool-status">{tool.status}</span></summary>
        {tool.input !== undefined && <pre>{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>}
        {tool.output !== undefined && <pre>{typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}</pre>}
      </details>)}</div>}
    </div>
  </details>;
}
