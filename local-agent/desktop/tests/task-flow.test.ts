import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTaskSession } from '../renderer/task-flow.ts';

test('Stop during first-session IPC never dispatches the task or consumes its draft and attachments', async () => {
  let finish!: (value: { id: string }) => void;
  const creating = new Promise<{ id: string }>(resolve => { finish = resolve; });
  let stopped = false, sends = 0;
  let selected: string | undefined;
  const inputs = { draft: 'Create a project', files: ['notes.txt'] };
  const task = (async () => {
    const id = await resolveTaskSession(null, () => creating, value => { selected = value; }, () => stopped);
    inputs.draft = ''; inputs.files = []; sends++;
    return id;
  })();
  stopped = true;
  finish({ id: 'saved-empty-session' });
  await assert.rejects(task, /Task preparation stopped/);
  assert.equal(sends, 0);
  assert.equal(selected, 'saved-empty-session', 'A completed empty session remains reachable for authoritative synchronization.');
  assert.deepEqual(inputs, { draft: 'Create a project', files: ['notes.txt'] });
});

test('stopped task preparation never creates a session; uninterrupted tasks reuse or select one', async () => {
  let creates = 0;
  const create = async () => { creates++; return { id: 'new-session' }; };
  const selected: string[] = [];
  await assert.rejects(resolveTaskSession(null, create, id => selected.push(id), () => true), /Task preparation stopped/);
  assert.equal(await resolveTaskSession('existing-session', create, id => selected.push(id), () => false), 'existing-session');
  assert.equal(creates, 0);
  assert.equal(await resolveTaskSession(null, create, id => selected.push(id), () => false), 'new-session');
  assert.equal(creates, 1);
  assert.deepEqual(selected, ['new-session']);
});
