import type { AgentSession, AgentStatus, NavigationRoute } from './types';
import { modelIsUsable } from './status-flow.ts';

export function currentRoute(status: AgentStatus): NavigationRoute {
  return status.navigation?.current ?? { screen: 'conversation', sessionId: status.currentSessionId ?? status.activeSessionId };
}

/** Browsing and execution have separate owners; a visible chat never retargets a running action. */
export function executionOwner(status: Pick<AgentStatus, 'activeSessionId'> | null, localOwner?: string | null): string | undefined {
  return status?.activeSessionId ?? localOwner ?? undefined;
}

export function modelForConversation(status: AgentStatus | null, sessionId: string | null): string | null {
  const session = status?.sessions.find(item => item.id === sessionId);
  return session?.preferredModel !== undefined ? session.preferredModel : status?.selectedModel ?? null;
}

export function conversationModelNeedsReview(status: AgentStatus, sessionId: string): boolean {
  return !modelIsUsable({ ...status, selectedModel: modelForConversation(status, sessionId) });
}

/** Commit the originating draft before changing the host route or reading the destination. */
export async function transitionToRoute(flush: () => Promise<void>, move: () => Promise<AgentStatus>,
  load: (id: string) => Promise<AgentSession>): Promise<{ status: AgentStatus; session?: AgentSession }> {
  await flush();
  const status = await move();
  const id = currentRoute(status).sessionId;
  return { status, session: id ? await load(id) : undefined };
}
