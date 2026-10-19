import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { SavedState, SavedSession } from './state.ts';
import type { Mode, NavigationRoute, TaskEffort, WorkspaceSummary } from './renderer/types.ts';

export function registerWorkspace(state: SavedState, folder: string): WorkspaceSummary {
  let workspace = state.workspaces.find(row => row.path === folder);
  if (!workspace) {
    workspace = { id: `workspace-${createHash('sha256').update(folder).digest('hex').slice(0, 32)}`, path: folder, name: path.basename(folder) || folder, updatedAt: new Date().toISOString() };
    state.workspaces.push(workspace);
  }
  return workspace;
}

export function createConversation(state: SavedState, options: { mode: Mode; projectPath?: string; workspaceId?: string; taskEffort?: TaskEffort; executionBudgetMs: number }): SavedSession {
  if (state.sessions.length >= 1000) throw new Error('This alpha supports up to 1000 chats.');
  const workspace = options.workspaceId ? state.workspaces.find(row => row.id === options.workspaceId) : options.projectPath ? registerWorkspace(state, options.projectPath) : undefined;
  if (options.workspaceId && !workspace) throw new Error('This workspace no longer exists. Choose its folder again.');
  if (workspace && options.projectPath && workspace.path !== options.projectPath) throw new Error('Workspace identity does not match its folder.');
  const session: SavedSession = { id: randomUUID(), title: options.mode === 'assistant' ? 'New chat' : options.mode === 'research' ? 'New research' : 'New task', updatedAt: new Date().toISOString(), mode: options.mode,
    taskEffort: options.taskEffort ?? state.defaultTaskEffort,
    ...(options.mode !== 'assistant' && workspace ? { projectPath: workspace.path, workspaceId: workspace.id } : {}),
    preferredModel: state.selectedModel, messages: [], files: [], draft: '', draftFiles: [], draftRevision: 0 };
  state.sessions.unshift(session);
  state.mode = options.mode;
  return session;
}

export function navigateConversation(state: SavedState, route: NavigationRoute, replace = false): void {
  if (route.sessionId && !state.sessions.some(row => row.id === route.sessionId)) throw new Error('This chat does not exist.');
  const current = state.navigation.current;
  if (current.screen === route.screen && current.sessionId === route.sessionId) return;
  if (!replace) state.navigation.back = [...state.navigation.back, current].slice(-100);
  state.navigation.current = { ...route };
}

export function backConversation(state: SavedState): void {
  const previous = state.navigation.back.pop();
  if (previous) state.navigation.current = previous;
}

/** One queue per conversation also serializes asynchronous attachment validation. */
export class ConversationWrites {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.tails.set(id, task);
    try { return await task; }
    finally { if (this.tails.get(id) === task) this.tails.delete(id); }
  }
}
