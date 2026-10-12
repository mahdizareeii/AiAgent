import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelValidationRecord, TaskCheck, ToolActivity } from './renderer/types.ts';
import { outerEvidence } from './task-outcome.ts';

export const VALIDATION_INITIAL = 'Local validation first.\n';
export const VALIDATION_FINAL = 'Local validation verified.\n';
export function assertValidationBinding(record: ModelValidationRecord, current: { id: string; digest: string; runtime: string; profileSignature: string }): void {
  if (record.modelId !== current.id || record.digest !== current.digest || record.runtime !== current.runtime || record.profileSignature !== current.profileSignature) {
    throw new Error('The model, runtime, or memory profile changed since this validation task was prepared. Start a new model validation; this task has not run.');
  }
}

/** Bind the ordered ACP results to independently recorded host mutation receipts. */
export function validationSequence(tools: ToolActivity[], hostChecks: TaskCheck[], root: string): { complete: boolean; fileOnly: boolean } {
  const beforeHash = createHash('sha256').update(VALIDATION_INITIAL).digest('hex');
  const afterHash = createHash('sha256').update(VALIDATION_FINAL).digest('hex');
  const file = path.join(root, 'model-check.txt'); let step = 0;
  const trustedMutation = (receipt: Record<string, unknown>, operation: string, digest: string) => receipt.operation === operation && receipt.path === 'model-check.txt' && receipt.changed === true && receipt.sha256 === digest &&
    hostChecks.some(check => check.status === 'passed' && check.evidence?.operation === operation && check.evidence.path === 'model-check.txt' && check.evidence.sha256 === digest && check.evidence.actionId === receipt.action_id);
  const exactCreation = (receipt: Record<string, unknown>) => receipt.operation === 'create_files' && receipt.changed === true && Array.isArray(receipt.files) && receipt.files.length === 1 &&
    receipt.files[0]?.path === 'model-check.txt' && receipt.files[0]?.changed === true && receipt.files[0]?.sha256 === beforeHash && receipt.files[0]?.bytes === Buffer.byteLength(VALIDATION_INITIAL);
  const trustedCreation = (receipt: Record<string, unknown>) => exactCreation(receipt) && hostChecks.some(check => {
    if (check.status !== 'passed' || check.evidence?.operation !== 'create_files' || check.evidence.actionId !== receipt.action_id) return false;
    // The host check is recorded independently of ACP from the owned action result.
    // A single-file receipt fits within its bounded detail; truncated batches fail closed.
    try { const owned = JSON.parse(check.detail); return owned.ok === true && owned.action_id === receipt.action_id && exactCreation(owned); } catch { return false; }
  });
  for (const tool of tools) {
    if (tool.status !== 'completed') continue;
    const receipt = outerEvidence(tool.output); if (!receipt || receipt.ok !== true) continue;
    if (step === 0 && (trustedMutation(receipt, 'write_file', beforeHash) || trustedCreation(receipt))) step++;
    else if (step === 1 && receipt.path === file && receipt.text === VALIDATION_INITIAL && receipt.sha256 === beforeHash && receipt.eof === true && receipt.start_byte === 0 && receipt.end_byte === receipt.size) step++;
    else if (step === 2 && trustedMutation(receipt, 'edit_file', afterHash)) step++;
    else if (step === 3 && receipt.path === file && receipt.text === VALIDATION_FINAL && receipt.sha256 === afterHash && receipt.eof === true && receipt.start_byte === 0 && receipt.end_byte === receipt.size) step++;
  }
  return { complete: step === 4, fileOnly: !tools.some(tool => /run command|run_command|terminal/i.test(tool.title)) && !hostChecks.some(check => check.evidence?.operation === 'run_command' || /run command/i.test(check.title)) };
}
