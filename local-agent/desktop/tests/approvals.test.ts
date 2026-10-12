import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalRegistry } from '../approvals.ts';
import type { AgentEvent } from '../renderer/types.ts';

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
