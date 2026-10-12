import type { TaskCheck, TaskOutcome, ToolActivity } from './renderer/types.ts';
import type { ActionToolEvent, ActionResult } from './actions.ts';

export function outerEvidence(output: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 5 || !output || typeof output !== 'object') return undefined;
  if (Array.isArray(output)) { for (const part of output) { const found = outerEvidence(part, depth + 1); if (found) return found; } return undefined; }
  const value = output as Record<string, unknown>;
  if (value.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent as Record<string, unknown>;
  if (typeof value.ok === 'boolean') return value;
  if (value.type === 'text' && typeof value.text === 'string') {
    // App action results prefix a complete JSON receipt. Do not parse stdout or file text recursively.
    try { const receipt = JSON.parse(value.text.split('\n')[0]); if (typeof receipt?.ok === 'boolean' && typeof receipt?.operation === 'string') return receipt; } catch {}
  }
  return outerEvidence(value.content, depth + 1);
}

export function checkFromHostAction(event: ActionToolEvent): TaskCheck | undefined {
  if (!['completed', 'failed'].includes(event.status)) return undefined;
  const result = event.output as ActionResult | undefined;
  const receipt = outerEvidence(result);
  const failed = event.status === 'failed' || result?.isError === true;
  const detail = receipt ? JSON.stringify(receipt) : result?.content?.map(item => item.text).join('\n') ?? 'No action result was returned.';
  return { id: `action:${event.id}`, toolId: event.id, title: event.title, status: failed ? 'failed' : 'passed', detail: detail.slice(0, 1800),
    evidence: { operation: typeof receipt?.operation === 'string' ? receipt.operation : undefined, path: typeof receipt?.path === 'string' ? receipt.path : undefined,
      sha256: typeof receipt?.sha256 === 'string' ? receipt.sha256 : undefined, changed: typeof receipt?.changed === 'boolean' ? receipt.changed : undefined,
      actionId: typeof receipt?.action_id === 'string' ? receipt.action_id : event.id } };
}

export function checksFromReadTools(tools: ToolActivity[]): TaskCheck[] {
  return tools.filter(tool => /(?:read file|read_file|inspect file|inspect_file|read pdf|read_pdf)/i.test(tool.title)).map(tool => {
    const value = outerEvidence(tool.output);
    const success = value?.ok === true && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256);
    const failed = ['failed', 'error', 'interrupted'].includes(tool.status) || value?.ok === false;
    const detail = success ? `${String(value.path ?? '')}\nSHA-256: ${value!.sha256}\n${typeof value!.text === 'string' ? value!.text.slice(0, 1200) : 'The tool verified the selected source.'}`
      : failed ? String(value?.message ?? 'The source read failed or was interrupted.') : 'A source call was recorded without complete verifiable result metadata.';
    return { id: `read:${tool.id}`, toolId: tool.id, title: tool.title, status: success ? 'passed' : failed ? 'failed' : 'unverified', detail,
      evidence: { operation: 'read_file', path: typeof value?.path === 'string' ? value.path : undefined, sha256: typeof value?.sha256 === 'string' ? value.sha256 : undefined,
        complete: value?.eof === true && value?.start_byte === 0 && value?.end_byte === value?.size } };
  });
}

export function finalizationEvidence(checks: TaskCheck[], tools: ToolActivity[]): string {
  return JSON.stringify({ checks: checks.slice(-6).map(check => ({ ...check, detail: check.detail.slice(0, 400) })),
    activity: tools.slice(-8).map(tool => ({ id: tool.id, title: tool.title, status: tool.status })) });
}

export function outcomeStatus(options: { aborted: boolean; timedOut: boolean; error?: string; finishReason: string; hasAnswer: boolean }): TaskOutcome['status'] {
  if (options.timedOut) return 'timed-out';
  if (options.aborted) return 'cancelled';
  if (options.error) return 'blocked';
  if (!options.hasAnswer || options.finishReason !== 'end_turn') return 'incomplete';
  return 'completed';
}

export function incompleteNotice(status: TaskOutcome['status'], reason: string, checks: TaskCheck[]): string {
  const passed = checks.filter(check => check.status === 'passed').length;
  return `${status === 'cancelled' ? 'Task stopped.' : status === 'timed-out' ? 'Task paused at its execution time limit.' : 'Task could not finish.'}\n\n${reason || 'The model did not provide a final answer.'}\n\n${passed} tool checks passed. Completed changes are preserved. Review Working for the recorded results; send a new request to continue. Actions will not be replayed automatically.`;
}
