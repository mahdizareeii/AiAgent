import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalRegistry, stopTurnOnApprovalExpiry } from '../approvals.ts';
import { LocalActions } from '../actions.ts';
import { mkdtemp, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '../renderer/types.ts';

test('expiry stops only its active turn and never overwrites another cancellation', () => {
  const event: AgentEvent = { type: 'permission_resolved', requestId: 'a', resolution: 'expired', revision: 1, sessionId: 's', turnId: 'old' };
  const controller = new AbortController(), active = { sessionId: 's', turnId: 'new', controller };
  assert.equal(stopTurnOnApprovalExpiry(event, active), false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(stopTurnOnApprovalExpiry({ ...event, turnId: 'new' }, active), true);
  assert.equal(controller.signal.reason.code, 'APPROVAL_EXPIRED');
  assert.doesNotMatch(controller.signal.reason.message, /user denied/i);
  const cancelled = new AbortController(); cancelled.abort('user stopped');
  assert.equal(stopTurnOnApprovalExpiry({ ...event, turnId: 'new' }, { ...active, controller: cancelled }), false);
  assert.equal(cancelled.signal.reason, 'user stopped');
  for (const resolution of ['approved', 'denied', 'cancelled'] as const)
    assert.equal(stopTurnOnApprovalExpiry({ ...event, resolution, turnId: 'new' }, { ...active, controller: new AbortController() }), false);
});

test('real expired approval cannot mutate a file or accept a delayed response', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'approval-expiry-')));
  const controller = new AbortController(), turn = { sessionId: 's', turnId: 't', controller };
  let requestId = '';
  const registry = new ApprovalRegistry({ timeoutMs: 10, emit: event => stopTurnOnApprovalExpiry(event, turn) });
  const actions = new LocalActions({ projectPath: directory, historyDirectory: path.join(directory, 'history'),
    onPermission: request => { requestId = request.requestId; return registry.request('s', 't', request, controller.signal); } });
  try {
    const running = actions.execute('write_file', { path: 'expired.txt', content: 'must not run' }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await running;
    assert.equal(controller.signal.reason.code, 'APPROVAL_EXPIRED');
    assert.equal(result.errorCode, 'CANCELLED');
    assert.doesNotMatch(result.content.map(part => part.text).join(' '), /user denied/i);
    await assert.rejects(access(path.join(directory, 'expired.txt')));
    assert.equal(registry.respond({ requestId, approved: true }).status, 'expired');
    assert.deepEqual(registry.snapshot('s', 't').pending, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host settles once before a delayed client can respond and leaves newer approval intact', async () => {
  const events: AgentEvent[] = []; const registry = new ApprovalRegistry({ emit: event => events.push(event) });
  const signal = new AbortController();
  const first = registry.request('s', 't1', { requestId: 'a', title: 'First', arguments: {} }, signal.signal);
  const before = registry.snapshot('s', 't1');
  assert.equal(registry.respond({ requestId: 'a', sessionId: 's', turnId: 't1', approved: true }).status, 'settled');
  assert.equal(await first, true);
  const second = registry.request('s', 't2', { requestId: 'b', title: 'Second', arguments: {} }, signal.signal);
  assert.equal(registry.respond({ requestId: 'a', approved: true }).status, 'expired');
  const current = registry.snapshot('s', 't2');
  assert.ok(current.revision > before.revision);
  assert.deepEqual(current.pending.map(request => request.requestId), ['b']);
  registry.respond({ requestId: 'b', approved: false }); assert.equal(await second, false);
  assert.equal(events.filter(event => event.type === 'permission_resolved' && event.requestId === 'a').length, 1);
});

test('wrong session/turn, cancellation and expiry cannot produce permission or replay', async () => {
  const events: AgentEvent[] = []; const registry = new ApprovalRegistry({ emit: event => events.push(event), timeoutMs: 20 });
  const abort = new AbortController(); const waiting = registry.request('s', 't', { requestId: 'a', title: 'Edit', arguments: {} }, abort.signal);
  assert.equal(registry.respond({ requestId: 'a', sessionId: 'other', approved: true }).status, 'expired');
  assert.equal(registry.respond({ requestId: 'a', turnId: 'older', approved: true }).status, 'expired');
  assert.equal(registry.snapshot('s', 't').pending.length, 1);
  abort.abort(); assert.equal(await waiting, false); assert.equal(registry.snapshot('s', null).pending.length, 0);
  assert.equal(registry.respond({ requestId: 'a', approved: true }).status, 'expired');
  const expired = registry.request('s', 't2', { requestId: 'b', title: 'Edit', arguments: {} }, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(await expired, false);
  assert.ok(events.some(event => event.type === 'permission_resolved' && event.resolution === 'expired'));
});
