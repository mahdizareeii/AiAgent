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
