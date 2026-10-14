import Icon from './Icons';
import HighlightedCode from './HighlightedCode';
import { workingStatus } from './conversation-flow';
import type { StageProgress, ToolActivity } from './types';

function commandDisplay(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { result: output };
  const value = output as Record<string, unknown>;
  if (value.operation !== 'run_command' || typeof value.output_text !== 'string') return { result: output };
  const { output_text, ...result } = value;
  return { result, text: output_text };
}

function sourceFor(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

function languageFor(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'json';
  return /^(?:\$ |npm |pnpm |yarn |node |python |pip |git |docker )/m.test(value) ? 'bash' : undefined;
}

export default function WorkingDetails({ thinking, active, thinkingActive, waitingApproval, stage, tools = [], toolsTruncated, expanded, onExpandedChange }: {
  thinking?: string;
  active: boolean;
  thinkingActive?: boolean;
  waitingApproval?: boolean;
  stage?: StageProgress | null;
  tools?: ToolActivity[];
  toolsTruncated?: boolean;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const label = active ? 'Working' : 'Task activity';
  const status = active ? workingStatus({ thinkingActive, waitingApproval, stage, tools }) : undefined;
  return <details className={`working-details ${active ? 'is-active' : ''}`} open={expanded} onToggle={(event) => onExpandedChange?.(event.currentTarget.open)}>
    <summary className="working-status" aria-label={label}>
      <Icon name="chevron" size={12} />
      {active && <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>}
      <span>{label}</span>
      {status && <span className="working-stage-label">{status.replace(/[_-]/g, ' ')}</span>}
      {!!tools.length && <span className="working-tool-count">{tools.length} {tools.length === 1 ? 'activity' : 'activities'}</span>}
    </summary>
    <div className="working-content">
      <h3>Model thinking · may contain tentative plans</h3>
      {thinking ? <pre className="thinking-text">{thinking}</pre> : <p className="thinking-unavailable">{active ? 'Thinking text has not been provided for this reply yet.' : 'This model did not provide thinking text for this reply.'}</p>}
      {active && status && <p className="working-current-stage"><strong>Current stage</strong><span>{status}</span></p>}
      {!!tools.length && <div className="tool-activity working-tool-activity" aria-label="Tool activity">{tools.map(tool => {
        const output = commandDisplay(tool.output);
        return <details key={tool.id}>
        <summary><span className={`tool-dot ${['completed', 'success'].includes(tool.status) ? 'complete' : ['failed', 'error'].includes(tool.status) ? 'failed' : ''}`} /><span>{tool.title}</span><span className="tool-status">{tool.status}</span></summary>
        {tool.input !== undefined && <><h3>Input</h3><HighlightedCode source={sourceFor(tool.input)} language={typeof tool.input === 'string' ? undefined : 'json'} /></>}
        {tool.output !== undefined && <><h3>Result</h3><HighlightedCode source={sourceFor(output.result)} language={typeof output.result === 'string' ? languageFor(output.result) : 'json'} /></>}
        {output.text !== undefined && <><h3>Command output</h3><HighlightedCode source={output.text} language={languageFor(output.text)} /></>}
      </details>;
      })}</div>}
      {toolsTruncated && <p className="thinking-unavailable">Working retains the first 256 tool activities for this reply. Further activity details were not retained here.</p>}
    </div>
  </details>;
}
