import { createHash } from 'node:crypto';
import type { ActionResult, ActionToolEvent } from './actions.ts';

interface ClosedAction {
  callId?: string;
  actionId: string;
  operation: string;
  status: 'completed' | 'failed';
  inputSha256: string;
  evidence: Record<string, unknown>;
}
interface RecordedAction extends ClosedAction { outputHash: string; receiptHash?: string }
const operations: Record<string, string> = { 'Edit file': 'edit_file', 'Write file': 'write_file', 'Create project files': 'create_files', 'Run command': 'run_command' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function argumentsHash(operation: string, value: unknown): string | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  // MCP's command schema adds these declared defaults before the host receives
  // arguments. Exact text, file contents and edit strings are never normalized.
  return hash(canonical(operation === 'run_command' ? { ...args, cwd: args.cwd ?? '.', timeout_ms: args.timeout_ms ?? 60_000 } : args));
}
function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return;
  const parts = value.map(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text'
    && typeof (item as Record<string, unknown>).text === 'string' ? (item as Record<string, unknown>).text as string : undefined);
  return parts.every(part => part !== undefined) ? parts.join(' ') : undefined;
}
function outerReceipt(value: unknown): Record<string, unknown> | undefined {
  // Serialized MCP text must match the complete host output. Parsing a prefix
  // would also accept a receipt with an invented suffix or omitted evidence.
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).ok === 'boolean') return value as Record<string, unknown>;
}

/** Receipt identity comes from LocalActions, never an assistant or file's prose. */
export class ActionContext {
  private records = new Map<string, RecordedAction>();
  record(event: ActionToolEvent): void {
    if (event.status !== 'completed' && event.status !== 'failed') return;
    const operation = operations[event.title];
    const inputSha256 = operation && argumentsHash(operation, event.input);
    const result = event.output as ActionResult | undefined;
    if (!operation || !inputSha256 || !result || !Array.isArray(result.content)) return;
    const receipt = result.structuredContent;
    const evidence: Record<string, unknown> = {};
    for (const key of ['ok', 'changed', 'path', 'sha256', 'bytes', 'log_id', 'durable_id', 'output_complete', 'next_offset', 'exit_code', 'exit_signal', 'error', 'input_sha256', 'attempts']) {
      const value = receipt?.[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) evidence[key] = value;
    }
    if (Array.isArray(receipt?.files)) evidence.files = receipt.files.map(file => {
      const row = file as Record<string, unknown>;
      return { path: row.path, sha256: row.sha256, bytes: row.bytes, changed: row.changed };
    });
    if (result.errorCode) evidence.errorCode = result.errorCode;
    if (event.status === 'failed') {
      const message = result.content[0]?.text ?? 'The action failed.';
      evidence.message = message.slice(0, 512);
      if (message.length > 512) { evidence.messageTruncated = true; evidence.messageSha256 = hash(message); }
    }
    const output = result.content.map(part => part.text).join(' ');
    this.records.set(event.id, { actionId: event.id, operation, status: event.status, inputSha256, evidence,
      outputHash: hash(output), ...(receipt ? { receiptHash: hash(canonical(receipt)) } : {}) });
    // An evicted receipt cannot authorize compaction; its exchange stays exact.
    if (this.records.size > 512) this.records.delete(this.records.keys().next().value!);
  }
  find(call: { id: string; function?: { name?: string; arguments?: unknown } }, output: unknown): ClosedAction | undefined {
    const match = call.function?.name?.match(/^reviewed_actions__(edit_file|write_file|create_files|run_command)$/);
    if (!match) return;
    const operation = match[1], signature = argumentsHash(operation, call.function?.arguments);
    if (!signature) return;
    const text = textContent(output), receipt = outerReceipt(output);
    const outputHash = text === undefined ? undefined : hash(text);
    const receiptHash = receipt ? hash(canonical(receipt)) : undefined;
    for (const record of this.records.values()) {
      if (record.operation === operation && record.inputSha256 === signature && (record.outputHash === outputHash || record.receiptHash && record.receiptHash === receiptHash)) {
        return { callId: call.id, actionId: record.actionId, operation, status: record.status, inputSha256: record.inputSha256, evidence: { ...record.evidence } };
      }
    }
  }
}
