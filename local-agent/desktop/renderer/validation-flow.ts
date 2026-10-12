import type { AgentSession } from './types';

/** Preparation binds the scratch session before any streamed task can start. */
export async function prepareValidationTask(create: () => Promise<{ sessionId: string; prompt: string }>,
  bind: (id: string) => void, load: (id: string) => Promise<AgentSession>, stopped: () => boolean) {
  const assertRunning = () => { if (stopped()) throw new Error('Model validation stopped before its task ran.'); };
  assertRunning();
  const task = await create();
  bind(task.sessionId);
  assertRunning();
  const session = await load(task.sessionId);
  assertRunning();
  return { session, prompt: task.prompt };
}
