import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventEmitter } from 'node:events';
import { RuntimeError, type ExecutionStoppedEvent } from '../local-agent/runtime/index.ts';
import type { ApprovalRegistry } from '../local-agent/desktop/approvals.ts';
import { outerEvidence } from '../local-agent/desktop/task-outcome.ts';
import type { TaskCheck, ToolActivity } from '../local-agent/desktop/renderer/types.ts';

const relativePath = z.string().min(1).max(4096).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'Use a path inside the test workspace.');
const commandSchema = z.object({ name: z.string().min(1).max(200), command: z.string().min(1).max(4096), args: z.array(z.string().max(32000)).max(100).default([]), stdin: z.string().max(100000).optional(),
  timeoutMs: z.number().int().min(100).max(600000).default(30000), expectedExitCode: z.number().int().min(0).max(255), expectedOutput: z.string().max(100000).optional(), expectedOutputIncludes: z.string().max(100000).optional(), expectedJson: z.unknown().optional() }).strict();
const requestSchema = z.object({ name: z.string().min(1).max(200), mode: z.enum(['assistant', 'coding']), request: z.string().trim().min(1).max(100000),
  expectedAnswer: z.string().optional(), expectedAnswerContains: z.string().optional(), expectedFiles: z.record(relativePath, z.string().max(2 * 1024 * 1024)).optional(),
  expectedFileSequence: z.object({ path: relativePath, initial: z.string().max(2 * 1024 * 1024), final: z.string().max(2 * 1024 * 1024), fileOnly: z.boolean().default(true) }).strict().optional(),
  independentCommands: z.array(commandSchema).max(20).optional() }).strict().superRefine((value, context) => {
  if (value.mode === 'assistant' && (value.expectedFileSequence || Object.keys(value.expectedFiles ?? {}).length || value.independentCommands?.length)) context.addIssue({ code: 'custom', message: 'Chat acceptance has no file or command actions.' });
  if (value.expectedAnswer === undefined && !value.expectedAnswerContains && !Object.keys(value.expectedFiles ?? {}).length && !value.expectedFileSequence && !value.independentCommands?.length) context.addIssue({ code: 'custom', message: 'Every task needs an independent assertion; a model success claim is insufficient.' });
});
export type AcceptanceRequest = z.infer<typeof requestSchema>;
export type AcceptanceCommand = z.infer<typeof commandSchema>;
export function parseAcceptanceRequests(value: unknown): AcceptanceRequest[] {
  const requests = z.array(requestSchema).min(1).max(10).parse(value);
  if (new Set(requests.map(item => item.name)).size !== requests.length) throw new Error('Acceptance request names must be unique.');
  return requests;
}
export function contains(root: string, target: string) { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
export const sha256Text = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** CLI test arguments are quoted as data; shell syntax is never inferred from them. */
export function commandText(command: AcceptanceCommand) {
  const invocation = [command.command, ...command.args].map(shellQuote).join(' ');
  return command.stdin === undefined ? invocation : `printf '%s' ${shellQuote(command.stdin)} | ${invocation}`;
}
export function parseApprovalLine(line: string): { type: 'cancel' } | { type: 'decision'; requestId: string; approved: boolean } | { type: 'invalid' } {
  if (line.trim() === 'cancel') return { type: 'cancel' };
  const match = /^(approve|deny) ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(line.trim());
  return match ? { type: 'decision', requestId: match[2], approved: match[1].toLowerCase() === 'approve' } : { type: 'invalid' };
}

/** Only the owned runtime channel can stop a turn. A late prior trial cannot cancel its successor. */
export function bindExecutionStopped(runtime: Pick<EventEmitter, 'on' | 'removeListener'>, options: {
  model: string; trialId: () => string | undefined; controller: AbortController; signal: AbortSignal;
  registry: ApprovalRegistry; sessionId: string; cancelBackend: () => void | Promise<void>;
  onStopped?: (reason: ExecutionStoppedEvent) => void;
}) {
  let stopped = false, disposed = false;
  const listener = (reason: ExecutionStoppedEvent) => {
    const ownedTrial = options.trialId();
    if (disposed || stopped || reason.model !== options.model || reason.trialId && ownedTrial && reason.trialId !== ownedTrial) return;
    stopped = true;
    options.onStopped?.(reason);
    // Preserve an earlier manual cancellation or task deadline as the cause.
    if (!options.signal.aborted) options.controller.abort(new RuntimeError(reason.code, reason.message));
    options.registry.cancelSession(options.sessionId);
    try { void Promise.resolve(options.cancelBackend()).catch(() => {}); } catch { /* The turn and approvals are already synchronously cancelled. */ }
  };
  runtime.on('executionStopped', listener);
  return () => { disposed = true; runtime.removeListener('executionStopped', listener); };
}

/** The final bytes alone cannot prove an actual create/read/edit/read tool loop. */
export function sequenceCheck(root: string, expected: NonNullable<AcceptanceRequest['expectedFileSequence']>, tools: ToolActivity[], hostChecks: TaskCheck[]): TaskCheck {
  const before = sha256Text(expected.initial), after = sha256Text(expected.final), absolute = path.resolve(root, expected.path);
  let step = 0;
  const mutation = (receipt: Record<string, unknown>, operation: string, digest: string) => receipt.operation === operation && receipt.path === expected.path && receipt.changed === true && receipt.sha256 === digest && hostChecks.some(check => check.status === 'passed' && check.evidence?.operation === operation && check.evidence.path === expected.path && check.evidence.sha256 === digest && check.evidence.actionId === receipt.action_id);
  const creation = (receipt: Record<string, unknown>) => receipt.operation === 'create_files' && receipt.changed === true && Array.isArray(receipt.files) && receipt.files.some(item => item.path === expected.path && item.changed === true && item.sha256 === before && item.bytes === Buffer.byteLength(expected.initial)) && hostChecks.some(check => {
    if (check.status !== 'passed' || check.evidence?.operation !== 'create_files' || check.evidence.actionId !== receipt.action_id) return false;
    try { const owned = JSON.parse(check.detail); return owned.ok === true && Array.isArray(owned.files) && owned.files.some((item: Record<string, unknown>) => item.path === expected.path && item.sha256 === before && item.changed === true); } catch { return false; }
  });
  const read = (receipt: Record<string, unknown>, text: string, digest: string) => receipt.path === absolute && receipt.text === text && receipt.sha256 === digest && receipt.size === Buffer.byteLength(text) && receipt.eof === true && receipt.start_byte === 0 && receipt.end_byte === receipt.size;
  for (const tool of tools) {
    if (tool.status !== 'completed') continue;
    const receipt = outerEvidence(tool.output); if (receipt?.ok !== true) continue;
    if (step === 0 && (mutation(receipt, 'write_file', before) || creation(receipt))) step++;
    else if (step === 1 && read(receipt, expected.initial, before)) step++;
    else if (step === 2 && mutation(receipt, 'edit_file', after)) step++;
    else if (step === 3 && read(receipt, expected.final, after)) step++;
  }
  const commandSeen = tools.some(tool => /run[ _-]*command/i.test(tool.title)) || hostChecks.some(check => check.evidence?.operation === 'run_command');
  const complete = step === 4 && (!expected.fileOnly || !commandSeen);
  return { id: 'independent:file-sequence', title: 'Approved create → read → exact edit → read', status: complete ? 'passed' : 'failed', detail: complete ? `The complete ordered sequence matches actual host receipts and full tool readbacks for ${expected.path}.` : `Established ${step}/4 ordered steps.${expected.fileOnly && commandSeen ? ' An unexpected terminal call was observed.' : ''}`, evidence: { path: expected.path, sha256: after, complete } };
}
