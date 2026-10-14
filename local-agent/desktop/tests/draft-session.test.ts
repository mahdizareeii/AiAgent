import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyState, migrateState } from '../state.ts';

const id = '596c9bc7-bacc-44bf-9f43-9eb5108acb5d';

test('v5 chats migrate with an empty optional composer draft and retain submitted files', () => {
  const state = migrateState({
    ...emptyState(), version: 5,
    sessions: [{ id, title: 'Saved task', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding',
      projectPath: '/workspace', files: [{ name: 'already.txt', path: '/workspace/already.txt' }], messages: [] }],
  });
  assert.equal(state.sessions[0].draft, undefined);
  assert.equal(state.sessions[0].draftFiles, undefined);
  assert.deepEqual(state.sessions[0].files, [{ name: 'already.txt', path: '/workspace/already.txt' }]);
});

test('idle chat composer draft and attachments survive state migration', () => {
  const state = migrateState({
    ...emptyState(),
    sessions: [{ id, title: 'Draft task', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding',
      files: [], messages: [], draft: 'Continue from the saved draft', draftFiles: [{ name: 'notes.md', path: '/tmp/notes.md' }], draftRevision: 7 }],
  });
  assert.equal(state.sessions[0].draft, 'Continue from the saved draft');
  assert.deepEqual(state.sessions[0].draftFiles, [{ name: 'notes.md', path: '/tmp/notes.md' }]);
  assert.equal(state.sessions[0].draftRevision, 7);
});

test('draft revision is bounded and malformed composer data is rejected', () => {
  const base = { ...emptyState(), sessions: [{ id, title: 'Draft', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding', files: [], messages: [] }] };
  assert.throws(() => migrateState({ ...base, sessions: [{ ...base.sessions[0], draftRevision: -1 }] }));
  assert.throws(() => migrateState({ ...base, sessions: [{ ...base.sessions[0], draftFiles: Array.from({ length: 21 }, (_, index) => ({ name: `${index}`, path: `/tmp/${index}` })) }] }));
});
