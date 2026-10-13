import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyApprovalRequest, applyApprovalResolution, applyApprovalSnapshot, emptyApprovals } from '../renderer/approval-flow.ts';
import { normalizeTextScale, readTextScale } from '../renderer/appearance.ts';
import { currentValidation, measuredMemory } from '../renderer/model-controls.ts';
import { modelFitAllowsUse, modelIsUsable, shouldOpenModelSetup } from '../renderer/status-flow.ts';
import { outcomePresentation } from '../renderer/task-evidence.ts';
import { prepareValidationTask } from '../renderer/validation-flow.ts';
import type { AgentStatus, LocalModel, PermissionRequest, TaskOutcome } from '../renderer/types.ts';

const request = (requestId: string, revision: number, turnId = 'turn-one'): PermissionRequest => ({ requestId, revision, turnId, title: 'Review edit', arguments: { path: 'app.php' } });

test('host snapshots recover a missed approval or resolution without executing anything', () => {
  let view = emptyApprovals('chat');
  view = applyApprovalSnapshot(view, { sessionId: 'chat', revision: 4, turnId: 'turn-one', pending: [request('edit', 4)] });
  assert.equal(view.pending[0].requestId, 'edit');
  // The user response IPC may time out after the host settles. A later focus /
  // interval snapshot removes the dialog; no approval is synthesized locally.
  view = applyApprovalSnapshot(view, { sessionId: 'chat', revision: 5, turnId: 'turn-one', pending: [] });
  assert.deepEqual(view.pending, []);
  assert.equal(view.revision, 5);
  assert.equal(applyApprovalRequest(view, 'chat', request('edit', 4)), view);
  assert.equal(applyApprovalSnapshot(view, { sessionId: 'chat', revision: 4, turnId: 'turn-one', pending: [request('edit', 4)] }), view);
});

test('late resolved events and snapshots cannot dismiss or restore a newer approval', () => {
  let view = applyApprovalRequest(emptyApprovals('chat'), 'chat', request('older', 1));
  view = applyApprovalResolution(view, { sessionId: 'chat', requestId: 'older', turnId: 'turn-one', revision: 2 });
  view = applyApprovalRequest(view, 'chat', request('newer', 3, 'turn-two'));
  assert.equal(view.pending[0].requestId, 'newer');
  assert.equal(applyApprovalResolution(view, { sessionId: 'chat', requestId: 'older', turnId: 'turn-one', revision: 2 }), view);
  assert.equal(applyApprovalSnapshot(view, { sessionId: 'chat', revision: 2, turnId: 'turn-one', pending: [] }), view);
  assert.equal(applyApprovalRequest(view, 'chat', request('older', 1)), view);
  assert.equal(applyApprovalResolution(view, { sessionId: 'another-chat', requestId: 'newer', turnId: 'turn-two', revision: 100 }), view);
  const wrongTurn = applyApprovalResolution(view, { sessionId: 'chat', requestId: 'newer', turnId: 'turn-one', revision: 4 });
  assert.equal(wrongTurn.pending[0].requestId, 'newer');
});

test('new-session binding rejects old snapshots and unrevisioned compatibility events', () => {
  const view = emptyApprovals('new-chat');
  assert.equal(applyApprovalSnapshot(view, { sessionId: 'old-chat', revision: 100, turnId: 'old', pending: [request('old', 100, 'old')] }), view);
  assert.equal(applyApprovalRequest(view, 'new-chat', { requestId: 'unversioned', title: 'Old event', arguments: {} }), view);
  const authoritative = applyApprovalSnapshot(view, { sessionId: 'new-chat', revision: 101, turnId: 'current', pending: [request('valid', 101, 'current'), request('wrong-turn', 101, 'old')] });
  assert.deepEqual(authoritative.pending.map(item => item.requestId), ['valid']);
});

test('reordered settlement removes its older pending request without dismissing the newer one', () => {
  let view = applyApprovalRequest(emptyApprovals('chat'), 'chat', request('first', 1));
  // Host settled first at revision 2, but its event is delayed behind second.
  view = applyApprovalRequest(view, 'chat', request('second', 3));
  assert.deepEqual(view.pending.map(item => item.requestId), ['first', 'second']);
  view = applyApprovalResolution(view, { sessionId: 'chat', turnId: 'turn-one', requestId: 'first', revision: 2 });
  assert.deepEqual(view.pending.map(item => item.requestId), ['second']);
  assert.equal(view.revision, 3);
  assert.equal(applyApprovalRequest(view, 'chat', request('first', 1)), view);
  assert.equal(applyApprovalResolution(view, { sessionId: 'chat', turnId: 'turn-one', requestId: 'second', revision: 2 }), view);
});

test('text preferences default safely and stay within the supported 90–125 percent range', () => {
  for (const value of [null, undefined, '', 'broken', Infinity, NaN]) assert.equal(normalizeTextScale(value), 100);
  assert.equal(normalizeTextScale('90'), 90);
  assert.equal(normalizeTextScale(125), 125);
  assert.equal(normalizeTextScale(-10), 90);
  assert.equal(normalizeTextScale(500), 125);
  assert.equal(readTextScale({ getItem: () => '115' }), 115);
  assert.equal(readTextScale({ getItem: () => { throw new Error('Storage unavailable'); } }), 100);
});

test('conversation, navigation and details use scalable semantic typography at every width', async () => {
  const css = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--font-conversation: calc\(15px \* var\(--text-scale\)\)/);
  assert.match(css, /--font-navigation: calc\(13px \* var\(--text-scale\)\)/);
  assert.match(css, /--font-detail: calc\(14px \* var\(--text-scale\)\)/);
  assert.doesNotMatch(css, /font-size:\s*\d+px/);
  assert.match(css, /\.markdown, \.composer textarea \{ font-size: var\(--font-conversation\)/);
});

const model: LocalModel = { id: 'weights', name: 'Weights', installed: true, fit: 'insufficient', fitReason: 'Too large', toolCapable: true, digest: 'digest', templateHash: 'template', integrity: 'verified', downloadGB: 20, description: '', license: '', quantization: 'Q4', workingMemoryGB: 24 };
const status = { runtime: { ready: true, state: 'ready', version: 'v0.6.0' }, selectedModel: model.id, models: [model], slowMode: false } as AgentStatus;

test('experimental readiness requires the explicit matching successful trial', () => {
  assert.equal(modelIsUsable(status), false);
  for (const state of ['loading', 'calibrating', 'failed', 'cancelled', 'stopped']) {
    const next = { ...status, memoryMode: 'experimental-disk' as const, experimentalTrial: { modelId: model.id, state } };
    assert.equal(modelIsUsable(next), false);
    assert.equal(shouldOpenModelSetup(next), true);
  }
  const passed = { ...status, memoryMode: 'experimental-disk' as const, experimentalTrial: { modelId: model.id, state: 'passed' } };
  assert.equal(modelIsUsable(passed), true);
  assert.equal(shouldOpenModelSetup(passed), false);
  assert.equal(modelIsUsable({ ...passed, experimentalTrial: { modelId: 'different', state: 'passed' } }), false);
  assert.equal(modelIsUsable({ ...passed, memoryMode: 'automatic' }), false);
  assert.equal(modelIsUsable({ ...passed, models: [{ ...model, blockedReason: 'Digest mismatch' }] }), false);
});

test('low-memory mode permits slow profiles but still refuses insufficient weight memory', () => {
  assert.equal(modelFitAllowsUse({ ...status, memoryMode: 'low-memory' }, model.id), false);
  assert.equal(modelFitAllowsUse({ ...status, models: [{ ...model, fit: 'slow' }] }, model.id), false);
  assert.equal(modelFitAllowsUse({ ...status, memoryMode: 'low-memory', models: [{ ...model, fit: 'slow' }] }, model.id), true);
  assert.equal(measuredMemory(undefined), 'Unknown');
  assert.equal(measuredMemory(0), '0.00 GiB');
});

test('task results require recorded passed evidence rather than completion claims', () => {
  const outcome: TaskOutcome = { status: 'completed', finishReason: 'Assistant said complete', checks: [] };
  assert.equal(outcomePresentation(outcome).checksPassed, false);
  const checked = { ...outcome, checks: [{ id: 'file', title: 'Exact final bytes', status: 'passed' as const, detail: 'Digest matched' }] };
  assert.equal(outcomePresentation(checked).checksPassed, true);
  for (const checkStatus of ['failed', 'unverified'] as const) assert.equal(outcomePresentation({ ...checked, checks: [...checked.checks, { id: 'test', title: 'Project check', status: checkStatus, detail: 'No success evidence' }] }).checksPassed, false);
  assert.equal(outcomePresentation({ ...checked, status: 'cancelled' }).title, 'Task stopped');
  assert.equal(outcomePresentation({ ...checked, status: 'timed-out' }).checksPassed, false);
});

test('a successfully recorded mutation of the wrong file never claims the task was verified', () => {
  const outcome: TaskOutcome = { status: 'completed', finishReason: 'end_turn', checks: [
    { id: 'mutation:wrong-file', title: 'File creation recorded', status: 'passed', detail: JSON.stringify({ operation: 'write_file', path: 'wrong-file.txt', changed: true }) },
  ] };
  assert.equal(outcomePresentation(outcome).title, 'Recorded checks passed');
  assert.doesNotMatch(outcomePresentation(outcome).title, /Task verified/i);
  assert.equal(outcomePresentation({ ...outcome, checks: [] }).title, 'Task completed; review checks');
});

test('task validation is distinct from speed calibration and a different runtime profile', () => {
  const record = { id: 'validation', modelId: model.id, digest: 'digest', templateHash: 'template', runtime: 'v0.6.0', profileSignature: 'profile-A', startedAt: 'now', status: 'passed' as const, checks: [{ id: 'files', title: 'Final bytes checked', status: 'passed' as const, detail: 'Matched requested content' }] };
  assert.equal(currentValidation({ ...status, models: [{ ...model, measuredTokensPerSecond: 10 }] }, model).current, false);
  assert.equal(currentValidation({ ...status, profile: { backend: 'cpu', contextTokens: 4096, profileSignature: 'profile-B' }, validationRecords: [record] }, model).current, false);
  assert.equal(currentValidation({ ...status, profile: { backend: 'cpu', contextTokens: 4096, profileSignature: 'profile-A' }, validationRecords: [record] }, model).current, true);
  assert.equal(currentValidation({ ...status, profile: { backend: 'cpu', contextTokens: 4096, profileSignature: 'profile-A' }, validationRecords: [{ ...record, checks: [] }] }, model).current, false);
  const identity = { ...status, profile: { backend: 'cpu', contextTokens: 4096, profileSignature: 'profile-A' }, validationRecords: [record] };
  assert.equal(currentValidation(identity, { ...model, digest: 'different-model-bytes' }).current, false);
  assert.equal(currentValidation(identity, { ...model, digest: undefined }).current, false);
  assert.equal(currentValidation({ ...identity, runtime: { ...identity.runtime, version: 'v0.7.0' } }, model).current, false);
  assert.equal(currentValidation({ ...identity, runtime: { ...identity.runtime, version: undefined } }, model).current, false);
});

test('validation preparation binds the scratch task before loading and sending', async () => {
  const order: string[] = [];
  let selected = 'previous-chat';
  const task = await prepareValidationTask(async () => { order.push('prepare'); return { sessionId: 'scratch', prompt: 'Use file tools' }; },
    id => { selected = id; order.push('bind'); }, async id => {
      assert.equal(selected, id); order.push('load'); return { id, mode: 'coding', messages: [], taskEffort: 'careful' };
    }, () => false);
  assert.equal(task.session.id, 'scratch'); assert.equal(task.prompt, 'Use file tools');
  order.push('send');
  assert.deepEqual(order, ['prepare', 'bind', 'load', 'send']);
});

test('stopping validation across either preparation boundary never starts its task', async () => {
  for (const stopAt of ['create', 'load']) {
    let stopped = false; let loads = 0; let sends = 0;
    await assert.rejects(async () => {
      await prepareValidationTask(async () => { if (stopAt === 'create') stopped = true; return { sessionId: 'scratch', prompt: 'Check files' }; },
        () => {}, async id => { loads++; if (stopAt === 'load') stopped = true; return { id, mode: 'coding', messages: [] }; }, () => stopped);
      sends++;
    }, /stopped before its task ran/);
    assert.equal(sends, 0); assert.equal(loads, stopAt === 'load' ? 1 : 0);
  }
});
