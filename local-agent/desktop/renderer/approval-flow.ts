import type { PermissionRequest, PermissionSnapshot } from './types';

export interface ApprovalView {
  sessionId: string | null;
  revision: number;
  turnId: string | null;
  pending: PermissionRequest[];
}

export function emptyApprovals(sessionId: string | null = null): ApprovalView {
  return { sessionId, revision: -1, turnId: null, pending: [] };
}

/** A complete host snapshot is authoritative; a stale one cannot undo an event. */
export function applyApprovalSnapshot(current: ApprovalView, snapshot: PermissionSnapshot): ApprovalView {
  if (snapshot.sessionId !== current.sessionId || snapshot.revision < current.revision) return current;
  return { sessionId: snapshot.sessionId, revision: snapshot.revision, turnId: snapshot.turnId,
    pending: snapshot.pending.filter(request => !request.turnId || request.turnId === snapshot.turnId) };
}

export function applyApprovalRequest(current: ApprovalView, sessionId: string | undefined, request: PermissionRequest): ApprovalView {
  // Unversioned compatibility events trigger a snapshot in the caller. They
  // cannot restore an approval the host has already settled.
  if (sessionId !== current.sessionId || !request.turnId || request.revision === undefined || request.revision <= current.revision) return current;
  const pending = current.turnId === request.turnId ? current.pending.filter(item => item.requestId !== request.requestId) : [];
  return { sessionId: current.sessionId, revision: request.revision, turnId: request.turnId, pending: [...pending, request] };
}

export function applyApprovalResolution(current: ApprovalView, event: { sessionId?: string; turnId: string; requestId: string; revision: number }): ApprovalView {
  if (event.sessionId !== current.sessionId) return current;
  // Resolution A can arrive after request B. It may settle only A's exact
  // older identity, while B and the highest observed revision remain intact.
  const pending = current.pending.filter(request => request.requestId !== event.requestId || request.turnId !== event.turnId
    || (request.revision !== undefined && request.revision >= event.revision));
  if (pending.length === current.pending.length && event.revision <= current.revision) return current;
  return { ...current, revision: Math.max(current.revision, event.revision), pending };
}
