import type { AgentEvent, PermissionRequest, PermissionSnapshot } from './renderer/types.ts';
import { RuntimeError } from '../runtime/errors.ts';

/** Expiry is a host timeout, not a human denial. Never affect a newer turn. */
export function stopTurnOnApprovalExpiry(event: AgentEvent,
  turn: { sessionId: string; turnId: string; controller: AbortController } | undefined): boolean {
  if (event.type !== 'permission_resolved' || event.resolution !== 'expired' || !turn
    || event.sessionId !== turn.sessionId || event.turnId !== turn.turnId || turn.controller.signal.aborted) return false;
  turn.controller.abort(new RuntimeError('APPROVAL_EXPIRED', 'The approval expired before it was answered. No permission was granted. Completed actions are preserved; send a new request to continue.'));
  return true;
}

type Resolution = 'approved' | 'denied' | 'cancelled' | 'expired';
interface PendingApproval { sessionId: string; turnId: string; request: PermissionRequest; settle(resolution: Resolution): void }

/** Approval state belongs to the host. Settlement never asserts action execution. */
export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();
  private revision = 0;
  private options: { emit(event: AgentEvent): void; waiting?(sessionId: string, waiting: boolean): void; timeoutMs?: number };
  constructor(options: ApprovalRegistry['options']) { this.options = options; }

  request(sessionId: string, turnId: string, request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.pending.has(request.requestId)) throw new Error('Approval IDs must be unique.');
    return new Promise(resolve => {
      let settled = false;
      const settle = (resolution: Resolution) => {
        if (settled) return;
        settled = true; this.pending.delete(request.requestId); clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.options.waiting?.(sessionId, false);
        this.options.emit({ type: 'permission_resolved', sessionId, turnId, requestId: request.requestId, resolution, revision: ++this.revision });
        resolve(resolution === 'approved' && !signal.aborted);
      };
      const cancel = () => settle('cancelled');
      const timer = setTimeout(() => settle('expired'), this.options.timeoutMs ?? 600_000);
      timer.unref?.();
      const owned = { ...request, turnId, revision: ++this.revision };
      this.pending.set(request.requestId, { sessionId, turnId, request: owned, settle });
      this.options.waiting?.(sessionId, true);
      signal.addEventListener('abort', cancel, { once: true });
      this.options.emit({ type: 'permission', sessionId, ...owned });
      if (signal.aborted) cancel();
    });
  }

  respond(options: { requestId: string; approved: boolean; sessionId?: string; turnId?: string }): { status: 'settled' | 'expired'; revision: number } {
    const pending = this.pending.get(options.requestId);
    if (!pending || options.sessionId && pending.sessionId !== options.sessionId || options.turnId && pending.turnId !== options.turnId) return { status: 'expired', revision: this.revision };
    pending.settle(options.approved ? 'approved' : 'denied');
    return { status: 'settled', revision: this.revision };
  }

  snapshot(sessionId: string, turnId: string | null): PermissionSnapshot {
    return { revision: this.revision, sessionId, turnId, pending: [...this.pending.values()].filter(item => item.sessionId === sessionId).map(item => ({ ...item.request })) };
  }

  cancelSession(sessionId: string): void { for (const item of [...this.pending.values()]) if (item.sessionId === sessionId) item.settle('cancelled'); }
  cancelAll(): void { for (const item of [...this.pending.values()]) item.settle('cancelled'); }
}
