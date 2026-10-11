import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusLoader, modelIsUsable, modelSetupMessage, runtimePresentation, shouldOpenModelSetup } from '../renderer/status-flow.ts';
import { isNearConversationEnd, shouldFollowConversation, workingStatus, workingDetailsIndexes } from '../renderer/conversation-flow.ts';
import type { AgentStatus, LocalModel } from '../renderer/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const model: LocalModel = { id: 'local-model', name: 'Local model', installed: true, fit: 'recommended', fitReason: 'Fits', toolCapable: true, downloadGB: 1, description: '', license: '', quantization: 'Q4_K_M', workingMemoryGB: 2 };
const base = { runtime: { ready: true, state: 'ready' }, selectedModel: model.id, slowMode: false, models: [model] } as AgentStatus;

test('a late startup snapshot cannot replace a newer model-ready status', async () => {
  const loader = createStatusLoader<AgentStatus>();
  const startup = deferred<AgentStatus>();
  const committed: AgentStatus[] = [];
  const pending = loader.load(() => startup.promise, (value) => committed.push(value));
  assert.equal(await loader.load(async () => base, (value) => committed.push(value)), base);
  startup.resolve({ ...base, runtime: { ready: false, state: 'starting' }, models: [], selectedModel: null });
  assert.equal(await pending, undefined);
  assert.deepEqual(committed, [base]);
  assert.equal(modelIsUsable(committed.at(-1)!), true);
});

test('obsolete startup and setup failures do not surface over successful recovery', async () => {
  const loader = createStatusLoader<AgentStatus>();
  const obsolete = deferred<AgentStatus>();
  const pending = loader.load(() => obsolete.promise, () => assert.fail('Obsolete status committed'));
  await loader.load(async () => base, () => {});
  obsolete.reject(new Error('Old initialization failed'));
  assert.equal(await pending, undefined);
  await assert.rejects(loader.load(async () => { throw new Error('Current library failure'); }, () => {}), /Current library failure/);
});

test('unmounted status requests cannot commit after cleanup', async () => {
  const loader = createStatusLoader<AgentStatus>();
  const held = deferred<AgentStatus>();
  const pending = loader.load(() => held.promise, () => assert.fail('Unmounted UI was updated'));
  loader.invalidate(); held.resolve(base);
  assert.equal(await pending, undefined);
});

test('empty and missing-selected model libraries are onboarding, not engine failures', () => {
  const empty = { ...base, models: [], selectedModel: null };
  assert.deepEqual(runtimePresentation(empty), { phase: 'ready', message: 'Ready' });
  assert.equal(modelIsUsable(empty), false);
  assert.equal(modelSetupMessage(empty), 'Download or import your first model.');
  assert.equal(modelSetupMessage({ ...base, selectedModel: 'missing-model' }), 'Choose an available local model to begin.');
  assert.equal(modelIsUsable({ ...base, models: [{ ...model, installed: false }] }), false);
});

test('retained usable weights wait for engine preparation without unnecessary model setup', () => {
  for (const state of ['stopped', 'starting', 'loading', 'stopping'] as const) {
    const waiting = { ...base, runtime: { ready: false, state } };
    assert.equal(shouldOpenModelSetup(waiting), false);
    assert.equal(modelIsUsable(waiting), false);
  }
  assert.equal(shouldOpenModelSetup(base), false);
  for (const status of [
    { ...base, selectedModel: null },
    { ...base, models: [] },
    { ...base, models: [{ ...model, blockedReason: 'Integrity check failed' }] },
    { ...base, models: [{ ...model, fit: 'slow' as const }] },
    { ...base, models: [{ ...model, fit: 'insufficient' as const }] },
    { ...base, modelsError: 'Cache unreadable' },
    { ...base, runtime: { ready: false, state: 'error' as const, error: 'Engine missing' } },
  ]) assert.equal(shouldOpenModelSetup(status), true);
});

test('initialization, model loading, genuine engine errors, and library failures have distinct messages', () => {
  for (const state of ['stopped', 'starting', 'stopping'] as const) assert.deepEqual(runtimePresentation({ ...base, runtime: { ready: false, state } }), { phase: 'preparing', message: 'Preparing local engine…' });
  assert.deepEqual(runtimePresentation({ ...base, runtime: { ready: false, state: 'loading' } }), { phase: 'preparing', message: 'Loading local model…' });
  const failed = { ...base, runtime: { ready: false, state: 'error' as const, error: 'Bundled executable is missing.' } };
  assert.deepEqual(runtimePresentation(failed), { phase: 'error', message: 'Bundled executable is missing.' });
  assert.equal(modelSetupMessage(failed), 'Bundled executable is missing.');
  const unreadable = { ...base, models: [], modelsError: 'Model cache is unreadable.' };
  assert.match(modelSetupMessage(unreadable), /library could not be read/);
});

test('blocked, oversized, and slow-mode models cannot enable send prematurely', () => {
  for (const patch of [{ blockedReason: 'Integrity check failed' }, { fit: 'insufficient' as const }, { fit: 'slow' as const }]) assert.equal(modelIsUsable({ ...base, models: [{ ...model, ...patch }] }), false);
  assert.equal(modelIsUsable({ ...base, slowMode: true, models: [{ ...model, fit: 'slow' }] }), true);
  assert.equal(modelIsUsable({ ...base, runtime: { ready: false, state: 'loading' } }), false);
  assert.equal(modelIsUsable({ ...base, runtime: { ready: true, state: 'ready', error: 'Pinned model digest does not match.', errorCode: 'MODEL_DIGEST_MISMATCH' } }), false);
  assert.equal(modelIsUsable({ ...base, modelsError: 'Library could not be inspected.' }), false);
});

test('scrolling up or opening any Working details pauses streamed auto-follow', () => {
  assert.equal(isNearConversationEnd({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 }), false);
  assert.equal(isNearConversationEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
  assert.equal(isNearConversationEnd({ scrollHeight: 200, scrollTop: -15, clientHeight: 400 }), true);
  assert.equal(shouldFollowConversation(false, 0), false);
  assert.equal(shouldFollowConversation(true, 1), false);
  assert.equal(shouldFollowConversation(true, 2), false);
  assert.equal(shouldFollowConversation(true, 0), true);
});

test('Working gives approval and current tools precedence over an older preparation stage', () => {
  const tools = [{ id: 'read', title: 'Read README', status: 'completed' }, { id: 'cmd', title: 'Run project checks', status: 'in_progress' }];
  const context = { tools, stage: { stage: 'preparing', message: 'Preparing your local task' } };
  assert.equal(workingStatus(context), 'Running Run project checks');
  assert.equal(workingStatus({ ...context, waitingApproval: true }), 'Waiting for your approval');
  assert.equal(workingStatus({ ...context, thinkingActive: true }), 'Thinking locally');
  assert.equal(workingStatus({ tools: [{ ...tools[1], status: 'pending' }] }), 'Preparing Run project checks');
  assert.equal(workingStatus({ tools: [{ ...tools[1], status: 'completed' }], stage: { stage: 'Reading_files', message: 'Reading page 2' } }), 'Reading page 2');
});

test('fallback activity and its first assistant chunk share expansion identity; removed rows do not pause scrolling', () => {
  const before = [{ role: 'user' as const, content: 'Inspect this task' }];
  assert.deepEqual([...workingDetailsIndexes(before, true, true)], [1]);
  const after = [...before, { role: 'assistant' as const, content: '', thinking: 'Inspect prerequisites' }];
  assert.deepEqual([...workingDetailsIndexes(after, true, true)], [1]);
  const noThinking = [...before, { role: 'assistant' as const, content: 'Complete' }];
  assert.equal(workingDetailsIndexes(noThinking, false, false).has(1), false);
  assert.equal(workingDetailsIndexes(after, false, false).has(1), true);
});
