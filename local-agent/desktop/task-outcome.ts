import type { TaskCheck, TaskOutcome, ToolActivity } from './renderer/types.ts';
import type { ActionToolEvent, ActionResult } from './actions.ts';

export const COMMAND_EVIDENCE_SCOPE = 'This records the command result and its checked files at verification time. It does not establish which planned behaviors the check covers.';

/** Presentation only. A stored verdict is never re-evaluated or upgraded here. */
export function commandEvidenceTitle(status: TaskCheck['status']): string {
  return status === 'passed' ? 'Approved command passed'
    : status === 'failed' ? 'Approved command failed' : 'Command check unverified';
}

/** Also scopes historical rows whose title was a model-written behavior claim. */
export function commandEvidencePresentation(check: TaskCheck): { title: string; detail: string } {
  if (check.evidence?.operation !== 'verify_command') return { title: check.title, detail: check.detail };
  const detail = check.detail.startsWith(COMMAND_EVIDENCE_SCOPE) ? check.detail
    : `${COMMAND_EVIDENCE_SCOPE}\n\nPlanned requirement (from the model; coverage unverified): ${check.title}\n\nRecorded command result: ${check.detail}`;
  return { title: commandEvidenceTitle(check.status), detail };
}

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
  return { id: `action:${event.id}`, toolId: event.id, title: event.title, purpose: 'operation', status: failed ? 'failed' : 'passed', detail: detail.slice(0, 1800),
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
    return { id: `read:${tool.id}`, toolId: tool.id, title: tool.title, purpose: 'operation', status: success ? 'passed' : failed ? 'failed' : 'unverified', detail,
      evidence: { operation: 'read_file', path: typeof value?.path === 'string' ? value.path : undefined, sha256: typeof value?.sha256 === 'string' ? value.sha256 : undefined,
        complete: value?.eof === true && value?.start_byte === 0 && value?.end_byte === value?.size } };
  });
}

export function finalizationEvidence(checks: TaskCheck[], tools: ToolActivity[]): string {
  return JSON.stringify({ checks: checks.slice(-6).map(check => {
    const presentation = commandEvidencePresentation(check);
    return { ...check, title: presentation.title, detail: presentation.detail.slice(0, 400) };
  }),
    activity: tools.slice(-8).map(tool => ({ id: tool.id, title: tool.title, status: tool.status })) });
}

/** A failed coding turn closes from host checks, never source text, stdout, or model prose. */
export function hostCodingClosing(options: {
  status: Exclude<TaskOutcome['status'], 'completed'>;
  checks: readonly TaskCheck[];
  blocker?: string;
  planPrepared: boolean;
}): string {
  const counts = (values: readonly TaskCheck[]) => ({ passed: values.filter(check => check.status === 'passed').length,
    failed: values.filter(check => check.status === 'failed').length, unverified: values.filter(check => check.status === 'unverified').length });
  const acceptance = options.checks.filter(check => check.purpose === 'acceptance');
  const operations = options.checks.filter(check => check.purpose !== 'acceptance');
  const required = counts(acceptance), actual = counts(operations), commands = counts(operations.filter(check => check.evidence?.operation === 'run_command'));
  const lines = [options.status === 'cancelled' ? 'Task stopped.' : options.status === 'timed-out' ? 'Task reached its execution time limit.'
    : options.status === 'blocked' ? 'Task blocked.' : 'Task remains incomplete.',
  `Acceptance checks: ${required.passed} passed, ${required.failed} failed, ${required.unverified} unverified.`];
  if (acceptance.some(check => check.evidence?.operation === 'verify_command')) lines.push(COMMAND_EVIDENCE_SCOPE);
  if (!acceptance.length) lines.push(options.planPrepared ? 'No acceptance results were recorded. The requested result is unverified.'
    : 'No acceptance plan was prepared. The requested result is unverified.');
  const unresolved = acceptance.filter(check => check.status !== 'passed').flatMap(check => check.checkIds ?? [check.id]);
  if (unresolved.length) lines.push(`Unresolved acceptance IDs: ${[...new Set(unresolved)].slice(0, 8).map(id => JSON.stringify(id.slice(0, 64))).join(', ')}.`);
  lines.push(`Recorded operations: ${actual.passed} succeeded, ${actual.failed} failed, ${actual.unverified} unverified.`,
    `Command receipts: ${commands.passed} succeeded, ${commands.failed} failed, ${commands.unverified} unverified.`);
  const labels: Record<string, string> = { read_file: 'Read file', edit_file: 'Edited file', write_file: 'Wrote file', create_files: 'Created files',
    run_command: 'Command completed successfully', validate_skill: 'Validated SKILL.md' };
  const successes = [...new Set(operations.filter(check => check.status === 'passed').flatMap(check => {
    const operation = check.evidence?.operation;
    if (!operation || !Object.hasOwn(labels, operation)) return [];
    const unchanged = ['edit_file', 'write_file', 'create_files'].includes(operation) && check.evidence?.changed === false;
    const label = unchanged ? 'Files already matched' : labels[operation];
    return [`${label}${check.evidence?.path ? `: ${JSON.stringify(check.evidence.path.slice(0, 180))}` : ''}`];
  }))].slice(0, 6);
  if (successes.length) lines.push(`Successful operations recorded by the host:\n${successes.map(label => `- ${label}`).join('\n')}`);
  const blocker = options.blocker?.trim().replace(/[\r\n]+/g, ' ').slice(0, 600);
  if (blocker) lines.push(`Blocker: ${blocker}`);
  lines.push('Completed changes are preserved. Review Working for the recorded evidence.');
  return lines.join('\n\n');
}

/** Progress prose from an interrupted backend is not a closing task answer. */
export function shouldFinalizeTask(options: { hasAnswer: boolean; aborted: boolean; finishReason: string; error?: string }): boolean {
  return !options.aborted && (!options.hasAnswer || Boolean(options.error) || options.finishReason !== 'end_turn');
}

export function outcomeStatus(options: { aborted: boolean; timedOut: boolean; error?: string; finishReason: string; hasAnswer: boolean; verification?: TaskOutcome['verification'] }): TaskOutcome['status'] {
  if (options.timedOut) return 'timed-out';
  if (options.aborted) return 'cancelled';
  if (options.error) return 'blocked';
  if (!options.hasAnswer || options.finishReason !== 'end_turn') return 'incomplete';
  if (options.verification !== undefined && options.verification !== 'passed') return 'incomplete';
  return 'completed';
}

export function incompleteNotice(status: TaskOutcome['status'], reason: string, checks: TaskCheck[]): string {
  const passed = checks.filter(check => check.status === 'passed').length;
  return `${status === 'cancelled' ? 'Task stopped.' : status === 'timed-out' ? 'Task paused at its execution time limit.' : 'Task could not finish.'}\n\n${reason || 'The model did not provide a final answer.'}\n\n${passed} tool checks passed. Completed changes are preserved. Review Working for the recorded results; send a new request to continue. Actions will not be replayed automatically.`;
}
