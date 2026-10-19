import type { AgentSession, ChatMessage } from './renderer/types.ts';
import type { SavedSession } from './state.ts';

/** Send UI state without copying the host's model transcripts and verification state. */
export function sessionForRenderer(session: SavedSession, activeMessage?: ChatMessage): AgentSession {
  return {
    id: session.id,
    mode: session.mode,
    messages: activeMessage ? [...session.messages, activeMessage] : session.messages,
    files: session.files,
    ...(session.draft !== undefined ? { draft: session.draft } : {}),
    ...(session.draftFiles !== undefined ? { draftFiles: session.draftFiles } : {}),
    ...(session.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(session.projectPath !== undefined ? { projectPath: session.projectPath } : {}),
    ...(session.workspaceId !== undefined ? { workspaceId: session.workspaceId } : {}),
    ...(session.preferredModel !== undefined ? { preferredModel: session.preferredModel } : {}),
    ...(session.taskEffort !== undefined ? { taskEffort: session.taskEffort } : {}),
  };
}
