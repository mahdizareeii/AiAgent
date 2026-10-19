import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backConversation, ConversationWrites, createConversation, navigateConversation, registerWorkspace } from '../conversations.ts';
import { bindSessionTranscript, emptyState, migrateState } from '../state.ts';

test('draft identity exists before model readiness and its workspace and preference remain fixed', () => {
  const state = emptyState(); state.selectedModel = 'model-a';
  const workspace = registerWorkspace(state, '/workspace/a');
  const a = createConversation(state, { mode: 'coding', workspaceId: workspace.id, executionBudgetMs: 3600000 });
  assert.match(a.id, /^[a-f0-9-]{36}$/); assert.equal(a.preferredModel, 'model-a');
  assert.equal(a.executionBudgetMs, undefined, 'A new draft has no execution budget until Send.');
  a.draft = 'Keep this exact draft\n'; a.draftFiles = [{ name: 'a.txt', path: '/workspace/a/a.txt' }];
  state.selectedModel = 'model-b';
  const b = createConversation(state, { mode: 'coding', projectPath: '/workspace/b', executionBudgetMs: 3600000 });
  assert.equal(b.preferredModel, 'model-b'); assert.notEqual(b.workspaceId, a.workspaceId);
  navigateConversation(state, { screen: 'conversation', sessionId: a.id });
  navigateConversation(state, { screen: 'conversation', sessionId: b.id });
  navigateConversation(state, { screen: 'plugins', sessionId: b.id }); backConversation(state); backConversation(state);
  assert.deepEqual(state.navigation.current, { screen: 'conversation', sessionId: a.id });
  assert.equal(a.projectPath, '/workspace/a'); assert.equal(a.preferredModel, 'model-a');
  const reopened = migrateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reopened, state); assert.equal(reopened.sessions.find(row => row.id === a.id)?.draft, 'Keep this exact draft\n');
  assert.throws(() => createConversation(state, { mode: 'coding', workspaceId: workspace.id, projectPath: '/other', executionBudgetMs: 3600000 }), /identity/);
});

test('legacy paths receive stable workspace IDs while transcripts, attachments and approval policies survive', () => {
  const id = '596c9bc7-bacc-44bf-9f43-9eb5108acb5d';
  const legacy = { ...emptyState(), version: 5, selectedModel: 'default-model', projectPath: '/default',
    approvalPolicies: [{ workspacePath: '/workspace', utility: 'fileReading', createdAt: '2026-10-17T00:00:00Z' }],
    sessions: [{ id, mode: 'coding', title: 'Saved', updatedAt: '2026-10-17T00:00:00Z', projectPath: '/workspace', files: [{ name: 'x', path: '/workspace/x' }],
      draft: 'draft', draftFiles: [{ name: 'y', path: '/workspace/y' }], messages: [{ role: 'assistant', content: 'old answer', outcome: { status: 'blocked', finishReason: 'incomplete', checks: [], model: { id: 'actual-model', digest: 'a', runtime: 'r', contextTokens: 4096, backend: 'cpu', memoryMode: 'low-memory' } } }] }] };
  const state = migrateState(legacy), session = state.sessions[0];
  assert.equal(state.version, 7); assert.equal(session.preferredModel, 'actual-model');
  assert.equal(state.workspaces.find(row => row.id === session.workspaceId)?.path, '/workspace');
  assert.deepEqual(session.messages, legacy.sessions[0].messages); assert.deepEqual(session.files, legacy.sessions[0].files);
  assert.deepEqual(session.draftFiles, legacy.sessions[0].draftFiles); assert.deepEqual(state.approvalPolicies, legacy.approvalPolicies);
  assert.deepEqual(migrateState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(migrateState(legacy).sessions[0].workspaceId, session.workspaceId);
});

test('switching models retains historical canonical evidence without reviving a stale execution seed', () => {
  const state = emptyState(), session = createConversation(state, { mode: 'assistant', executionBudgetMs: 3600000 });
  const binding = { modelId: 'a', digest: 'a'.repeat(64), templateHash: 'b'.repeat(64), profileSignature: 'cpu4k' };
  session.transcriptBinding = binding; session.canonicalTranscript = [{ role: 'assistant', content: 'Recorded result' }];
  const original = session.canonicalTranscript;
  assert.equal(bindSessionTranscript(session, { ...binding, modelId: 'b' }, true), undefined);
  assert.deepEqual(session.transcriptHistory?.[0].messages, original);
  assert.equal(bindSessionTranscript(session, binding, true), undefined);
  assert.deepEqual(migrateState(JSON.parse(JSON.stringify(state))).sessions[0].transcriptHistory, session.transcriptHistory);
});

test('per-conversation writes serialize asynchronous validation and recover after a rejected write', async () => {
  const queue = new ConversationWrites(), observed: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run('a', async () => { observed.push('a1-start'); await gate; observed.push('a1-end'); });
  const second = queue.run('a', async () => { observed.push('a2'); });
  await queue.run('b', async () => { observed.push('b'); });
  assert.deepEqual(observed, ['a1-start', 'b']); release(); await Promise.all([first, second]);
  assert.deepEqual(observed, ['a1-start', 'b', 'a1-end', 'a2']);
  await assert.rejects(queue.run('a', async () => { throw new Error('disk unavailable'); }), /disk/);
  assert.equal(await queue.run('a', async () => 3), 3);
});
