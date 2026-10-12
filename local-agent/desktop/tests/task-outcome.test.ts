import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksFromReadTools, checkFromHostAction, outcomeStatus } from '../task-outcome.ts';
import { TaskClock } from '../task-clock.ts';

test('verification uses actual host receipt and read metadata rather than model success claims', () => {
  const result = checkFromHostAction({ id: 'a', title: 'Write file', status: 'completed', output: { structuredContent: { ok: true, changed: true, sha256: 'a'.repeat(64) }, content: [] } });
  assert.equal(result?.status, 'passed');
  const tools = [{ id: 'r', title: 'read file', status: 'completed', output: { ok: true, sha256: 'a'.repeat(64), path: 'a.txt', text: 'literal 1: text\r\n' } },
    { id: 'r2', title: 'read file', status: 'completed', output: 'The model says it all passed.' }];
  const checks = checksFromReadTools(tools); assert.equal(checks[0].status, 'passed'); assert.ok(checks[0].detail.includes('literal 1: text\r\n')); assert.equal(checks[1].status, 'unverified');
  assert.equal(outcomeStatus({ aborted: false, timedOut: false, finishReason: 'max_tokens', hasAnswer: true }), 'incomplete');
  assert.equal(outcomeStatus({ aborted: false, timedOut: false, error: 'denied', finishReason: 'end_turn', hasAnswer: true }), 'blocked');
});

test('approval waiting pauses the active clock and expiry still cancels active execution', async () => {
  const clock = new TaskClock(80); clock.start(); await new Promise(resolve => setTimeout(resolve, 15)); clock.pause();
  const remaining = clock.remainingMs; await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(clock.signal.aborted, false); assert.equal(clock.remainingMs, remaining);
  clock.resume(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(clock.signal.aborted, true); clock.close();
});
