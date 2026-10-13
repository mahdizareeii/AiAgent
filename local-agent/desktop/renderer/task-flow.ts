import type { Mode, TaskEffort } from './types';

/** New Chat has no hidden workspace grant; the global folder remains available for later tasks. */
export function newSessionOptions(mode: Mode, projectPath: string | undefined, taskEffort: TaskEffort) {
  return { mode, taskEffort, ...(mode !== 'assistant' && projectPath ? { projectPath } : {}) };
}

/** Stop stays authoritative across an asynchronous first-session IPC boundary. */
export async function resolveTaskSession(currentId: string | null, create: () => Promise<{ id: string }>,
  select: (id: string) => void, stopped: () => boolean): Promise<string> {
  const assertRunning = () => { if (stopped()) throw new Error('Task preparation stopped. Your request has not run.'); };
  assertRunning();
  if (currentId) return currentId;
  const created = await create();
  select(created.id);
  assertRunning();
  return created.id;
}
