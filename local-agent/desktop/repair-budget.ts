import { createHash } from 'node:crypto';
import type { ActionToolEvent } from './actions.ts';

const criterionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validCheckIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 12 && new Set(value).size === value.length
    && value.every(id => typeof id === 'string' && criterionId.test(id));
}

/** Only an executed, normally exited host verification command can start a repair cycle. */
export function isFailedVerificationCheck(event: ActionToolEvent): boolean {
  if (event.status !== 'failed') return false;
  const input = record(event.input), output = record(event.output), receipt = record(output?.structuredContent);
  if (!input || !output || !receipt || output.isError !== true || output.errorCode !== undefined || receipt.error !== undefined) return false;
  if (receipt.operation !== 'run_command' || receipt.ok !== false || receipt.purpose !== 'verification' || input.purpose !== 'verification') return false;
  if (!Number.isInteger(receipt.exit_code) || receipt.exit_code === 0 || receipt.exit_signal !== null) return false;
  const receiptIds = receipt.check_ids, inputIds = input.checkIds;
  if (!validCheckIds(receiptIds) || !validCheckIds(inputIds)
    || receiptIds.length !== inputIds.length || receiptIds.some((id, index) => id !== inputIds[index])) return false;
  if (typeof input.command !== 'string' || receipt.action_id !== event.id || receipt.durable_id !== event.id) return false;
  return receipt.command_sha256 === createHash('sha256').update(input.command, 'utf8').digest('hex');
}

/** A repair attempt starts with the next effectful operation after an observed failed check. */
export class RepairBudget {
  private awaitingRepair = false;
  private attempts = 0;
  private seen = new Set<string>();
  failedCheck(): void { this.awaitingRepair = true; }
  beginAction(id: string): number {
    if (this.seen.has(id)) return this.attempts;
    this.seen.add(id);
    if (this.awaitingRepair) { this.awaitingRepair = false; this.attempts++; }
    if (this.attempts > 3) throw new Error('Repair limit reached after three repair attempts following failed checks. Completed actions are preserved. Send a new request with the observed blocker.');
    return this.attempts;
  }
}
