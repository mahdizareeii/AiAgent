import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftStore, flushBeforeClose, type DraftSnapshot } from '../renderer/draft-store.ts';
import { currentRoute, executionOwner, modelForConversation, conversationModelNeedsReview, transitionToRoute } from '../renderer/navigation.ts';
import type { AgentSession, AgentStatus } from '../renderer/types.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const blank = (): DraftSnapshot => ({ draft: '', files: [], revision: 0 });
const status = (id: string, screen: 'conversation' | 'models' | 'plugins' = 'conversation') => ({ navigation: { current: { screen, sessionId: id }, back: [] }, sessions: [] }) as unknown as AgentStatus;

test('fast A→B→A navigation saves text and attachments before reading either destination', async () => {
  const saved = new Map<string, DraftSnapshot>([['A', blank()], ['B', blank()]]);
  const writes: string[] = [];
  const drafts = new DraftStore(async value => { writes.push(value.sessionId); saved.set(value.sessionId, value); return { saved: true, revision: value.revision }; }, undefined, 60000);
  try {
    drafts.restore('A', saved.get('A')!);
    drafts.queue('A', 'Unsent exact text\n', [{ name: 'source.txt', path: '/A/source.txt' }]);
    const load = async (id: string) => ({ id, mode: 'coding', messages: [], draft: saved.get(id)!.draft, draftFiles: saved.get(id)!.files, draftRevision: saved.get(id)!.revision }) as AgentSession;
    const b = await transitionToRoute(() => drafts.flush('A'), async () => status('B'), load);
    assert.equal(b.session?.id, 'B'); assert.deepEqual(writes, ['A']);
    const a = await transitionToRoute(() => drafts.flush('B'), async () => status('A'), load);
    assert.equal(a.session?.draft, 'Unsent exact text\n'); assert.equal(a.session?.draftFiles?.[0].path, '/A/source.txt');
  } finally { drafts.dispose(); }
});

test('in-flight draft writes are serialized and navigation waits for the final edit', async () => {
  const first = deferred<{ saved: boolean; revision: number }>();
  const writes: { draft: string; revision: number }[] = [];
  let active = 0, maximum = 0;
  const drafts = new DraftStore(async value => {
    active++; maximum = Math.max(maximum, active); writes.push(value);
    try { return writes.length === 1 ? await first.promise : { saved: true, revision: value.revision }; } finally { active--; }
  }, undefined, 60000);
  try {
    drafts.restore('A', blank()); drafts.queue('A', 'first', []);
    const saving = drafts.flush('A');
    drafts.queue('A', 'latest', []);
    let moved = false;
    const navigation = transitionToRoute(() => drafts.flush('A'), async () => { moved = true; return status('B'); }, async id => ({ id, mode: 'coding', messages: [] }));
    await Promise.resolve(); assert.equal(moved, false);
    first.resolve({ saved: true, revision: 1 }); await saving; await navigation;
    assert.equal(maximum, 1); assert.deepEqual(writes.map(value => [value.draft, value.revision]), [['first', 1], ['latest', 2]]);
  } finally { drafts.dispose(); }
});

test('a rejected draft save retains content and prevents navigation until a fresh revision saves', async () => {
  let attempts = 0; const revisions: number[] = [];
  const drafts = new DraftStore(async value => { revisions.push(value.revision); return ++attempts === 1 ? { saved: false, revision: 9 } : { saved: true, revision: value.revision }; }, undefined, 60000);
  try {
    drafts.restore('A', blank()); drafts.queue('A', 'keep this', []);
    let moved = false;
    await assert.rejects(transitionToRoute(() => drafts.flush('A'), async () => { moved = true; return status('B'); }, async id => ({ id, mode: 'coding', messages: [] })), /retained/);
    assert.equal(moved, false); assert.equal(drafts.restore('A', blank()).draft, 'keep this');
    await drafts.flush('A'); assert.deepEqual(revisions, [1, 10]);
  } finally { drafts.dispose(); }
});

test('a failed save never clears the latest local draft or switches conversations', async () => {
  const drafts = new DraftStore(async () => { throw new Error('disk unavailable'); }, undefined, 60000);
  try {
    drafts.restore('A', blank()); drafts.queue('A', 'retained locally', []);
    await assert.rejects(transitionToRoute(() => drafts.flush('A'), async () => assert.fail('Navigation must not start'), async () => assert.fail('No destination read')), /disk unavailable/);
    assert.equal(drafts.restore('A', blank()).draft, 'retained locally');
  } finally { drafts.dispose(); }
});

test('after accepted Send, the host draft revision rebases the next edit without restoring submitted attachments', async () => {
  const writes: (DraftSnapshot & { sessionId: string })[] = [];
  const drafts = new DraftStore(async value => { writes.push(value); return { saved: true, revision: value.revision }; }, undefined, 60000);
  try {
    drafts.restore('A', { draft: '', files: [], revision: 7 }); drafts.queue('A', 'submit', [{ name: 'once', path: '/once' }]); await drafts.flush('A');
    assert.deepEqual(drafts.restore('A', { draft: '', files: [], revision: 9 }), { draft: '', files: [], revision: 9 });
    drafts.queue('A', 'follow-up', []); await drafts.flush('A');
    assert.equal(writes[1].revision, 10); assert.deepEqual(writes[1].files, []);
  } finally { drafts.dispose(); }
});

test('Back restores the precise saved route while running-task ownership and per-chat model preference stay separate', async () => {
  const next = { ...status('B', 'plugins'), activeSessionId: 'A', selectedModel: 'default', sessions: [{ id: 'B', preferredModel: 'large', title: 'B', updatedAt: 'now' }] } as AgentStatus;
  let loaded = '';
  const moved = await transitionToRoute(async () => {}, async () => next, async id => { loaded = id; return { id, mode: 'assistant', messages: [] }; });
  assert.equal(loaded, 'B'); assert.deepEqual(currentRoute(moved.status), { screen: 'plugins', sessionId: 'B' });
  assert.equal(executionOwner(next), 'A'); assert.equal(modelForConversation(next, 'B'), 'large');
  assert.equal(modelForConversation(next, 'new'), 'default');
});

test('close acknowledgement waits for all conversations and reports failed persistence without claiming success', async () => {
  const held = deferred<{ saved: boolean; revision: number }>();
  const acknowledgements: (string | undefined)[] = [];
  const drafts = new DraftStore(async value => value.sessionId === 'A' ? held.promise : { saved: true, revision: value.revision }, undefined, 60000);
  try {
    drafts.restore('A', blank()); drafts.restore('B', blank()); drafts.queue('A', 'must survive Quit', []); drafts.queue('B', 'other draft', []);
    const closing = flushBeforeClose(drafts, async error => { acknowledgements.push(error); }, () => assert.fail('No persistence error expected'));
    await Promise.resolve(); assert.equal(acknowledgements.length, 0);
    held.resolve({ saved: true, revision: 1 }); await closing; assert.deepEqual([...acknowledgements], [undefined]);
  } finally { drafts.dispose(); }
  const failed = new DraftStore(async () => { throw new Error('disk full'); }, undefined, 60000);
  try {
    failed.restore('A', blank()); failed.queue('A', 'retain on failure', []);
    await flushBeforeClose(failed, async error => { acknowledgements.push(error); }, () => {});
    assert.equal(acknowledgements.at(-1), 'disk full'); assert.equal(failed.restore('A', blank()).draft, 'retain on failure');
  } finally { failed.dispose(); }
});

test('failure review checks the viewed conversation preference rather than the default model', () => {
  const available = { id: 'ready', installed: true, fit: 'recommended', toolCapable: true, integrity: 'verified' };
  const snapshot = { ...status('A'), runtime: { ready: true, state: 'ready' }, selectedModel: 'ready', models: [available], sessions: [{ id: 'A', title: 'A', updatedAt: 'now', preferredModel: 'missing' }] } as AgentStatus;
  assert.equal(conversationModelNeedsReview(snapshot, 'A'), true);
  assert.equal(conversationModelNeedsReview({ ...snapshot, selectedModel: 'missing', sessions: [{ ...snapshot.sessions[0], preferredModel: 'ready' }] }, 'A'), false);
});
