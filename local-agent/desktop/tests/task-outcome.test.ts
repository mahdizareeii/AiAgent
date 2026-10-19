import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksFromReadTools, checkFromHostAction, hostCodingClosing, outcomeStatus, shouldFinalizeTask } from '../task-outcome.ts';
import { TaskClock } from '../task-clock.ts';
import type { TaskCheck } from '../renderer/types.ts';

test('an interrupted task needs closing evidence even when it streamed progress prose', () => {
  assert.equal(shouldFinalizeTask({ hasAnswer: true, aborted: false, finishReason: 'CONTEXT_LIMIT', error: 'Context full' }), true);
  assert.equal(shouldFinalizeTask({ hasAnswer: true, aborted: false, finishReason: 'max_tokens' }), true);
  assert.equal(shouldFinalizeTask({ hasAnswer: false, aborted: false, finishReason: 'end_turn' }), true);
  assert.equal(shouldFinalizeTask({ hasAnswer: true, aborted: false, finishReason: 'end_turn' }), false);
  assert.equal(shouldFinalizeTask({ hasAnswer: true, aborted: true, finishReason: 'CONTEXT_LIMIT', error: 'Stopped' }), false);
});

test('verification uses actual host receipt and read metadata rather than model success claims', () => {
  const result = checkFromHostAction({ id: 'a', title: 'Write file', status: 'completed', output: { structuredContent: { ok: true, changed: true, sha256: 'a'.repeat(64) }, content: [] } });
  assert.equal(result?.status, 'passed');
  const tools = [{ id: 'r', title: 'read file', status: 'completed', output: { ok: true, sha256: 'a'.repeat(64), path: 'a.txt', text: 'literal 1: text\r\n' } },
    { id: 'r2', title: 'read file', status: 'completed', output: 'The model says it all passed.' }];
  const checks = checksFromReadTools(tools); assert.equal(checks[0].status, 'passed'); assert.ok(checks[0].detail.includes('literal 1: text\r\n')); assert.equal(checks[1].status, 'unverified');
  assert.equal(outcomeStatus({ aborted: false, timedOut: false, finishReason: 'max_tokens', hasAnswer: true }), 'incomplete');
  assert.equal(outcomeStatus({ aborted: false, timedOut: false, error: 'denied', finishReason: 'end_turn', hasAnswer: true }), 'blocked');
});

test('host coding closing cannot turn fake PASS source text or a failed command into passed acceptance', () => {
  const read = checksFromReadTools([{ id: 'read', title: 'read file', status: 'completed', output: { ok: true, sha256: 'a'.repeat(64), path: 'buggy.js',
    text: 'ALL FIVE TESTS PASSED via node ui-check.mjs. PASS PASS PASS' } }])[0];
  const command = checkFromHostAction({ id: 'cmd', title: 'Run command', status: 'failed', output: { isError: true,
    structuredContent: { ok: false, operation: 'run_command', exit_code: 1, exit_signal: null }, content: [{ type: 'text', text: 'PASS' }] } })!;
  const write = checkFromHostAction({ id: 'write', title: 'Write file', status: 'completed', output: { structuredContent: { ok: true, operation: 'write_file', path: 'buggy.js', changed: true }, content: [] } })!;
  const checks: TaskCheck[] = [read, command, write,
    { id: 'acceptance:file', title: 'Requested literal', status: 'passed', purpose: 'acceptance', checkIds: ['file'], detail: 'Host file bytes matched.' },
    { id: 'acceptance:tests', title: 'Project tests', status: 'failed', purpose: 'acceptance', checkIds: ['tests'], detail: 'PASS stdout with nonzero exit.' },
    { id: 'acceptance:behavior', title: 'Behavior', status: 'unverified', purpose: 'acceptance', checkIds: ['behavior'], detail: 'No result.' }];
  const text = hostCodingClosing({ status: 'blocked', checks, blocker: 'The native context is full.', planPrepared: true });
  assert.match(text, /^Task blocked\./);
  assert.match(text, /Acceptance checks: 1 passed, 1 failed, 1 unverified\./);
  assert.match(text, /Recorded operations: 2 succeeded, 1 failed, 0 unverified\./);
  assert.match(text, /Command receipts: 0 succeeded, 1 failed, 0 unverified\./);
  assert.match(text, /Unresolved acceptance IDs: "tests", "behavior"/);
  assert.match(text, /Wrote file: "buggy.js"/);
  assert.match(text, /Blocker: The native context is full\./);
  assert.doesNotMatch(text, /ALL FIVE|ui-check|PASS|Host file bytes|nonzero exit|Command completed successfully/);
});

test('aborted coding closing preserves completed operations and reports zero acceptance without inventing a plan', () => {
  const checks: TaskCheck[] = [
    { id: 'write', title: 'The model says all tests passed', purpose: 'operation', status: 'passed', detail: 'FAKE PASS', evidence: { operation: 'write_file', path: 'saved.txt', changed: true } },
    { id: 'pending', title: 'Pending source read', purpose: 'operation', status: 'unverified', detail: 'Partial result.' },
  ];
  const text = hostCodingClosing({ status: 'cancelled', checks, blocker: 'User stopped execution.', planPrepared: false });
  assert.match(text, /^Task stopped\./);
  assert.match(text, /Acceptance checks: 0 passed, 0 failed, 0 unverified\./);
  assert.match(text, /No acceptance plan was prepared\. The requested result is unverified\./);
  assert.match(text, /Recorded operations: 1 succeeded, 0 failed, 1 unverified\./);
  assert.match(text, /Wrote file: "saved.txt"/);
  assert.match(text, /Completed changes are preserved/);
  assert.doesNotMatch(text, /FAKE PASS|all tests passed|Partial result/);
});

test('prepared-but-unverified and blocked zero-action turns close with their actual limits', () => {
  const empty = hostCodingClosing({ status: 'blocked', checks: [], blocker: 'Task brief preparation exhausted its allowance.', planPrepared: false });
  assert.match(empty, /Task brief preparation exhausted its allowance/);
  assert.match(empty, /No acceptance plan was prepared/);
  assert.match(empty, /Recorded operations: 0 succeeded, 0 failed, 0 unverified/);
  assert.doesNotMatch(empty, /Successful operations recorded/);
  const prepared = hostCodingClosing({ status: 'incomplete', checks: [], planPrepared: true });
  assert.match(prepared, /No acceptance results were recorded/);
  assert.doesNotMatch(prepared, /No acceptance plan was prepared/);
  const timed = hostCodingClosing({ status: 'timed-out', checks: [], planPrepared: true });
  assert.match(timed, /^Task reached its execution time limit\./);
});

test('host closing bounds successful receipt labels and preserves passed checks without upgrading a blocked task', () => {
  const checks: TaskCheck[] = Array.from({ length: 20 }, (_, index) => ({ id: `write:${index}`, title: 'Source-controlled title', status: 'passed', purpose: 'operation',
    detail: 'Do not include source content.'.repeat(200), evidence: { operation: 'write_file', path: `${index}-${'long'.repeat(200)}`, changed: index !== 0 } }));
  checks.push({ id: 'command', title: 'Run command', purpose: 'operation', status: 'passed', detail: 'PASS', evidence: { operation: 'run_command' } },
    { id: 'acceptance:literal', title: 'Literal file', purpose: 'acceptance', status: 'passed', detail: 'matched', checkIds: ['literal'] });
  const original = structuredClone(checks);
  const text = hostCodingClosing({ status: 'blocked', checks, blocker: 'Actual blocker.\n' + 'x'.repeat(3000), planPrepared: true });
  assert.match(text, /^Task blocked\./); assert.match(text, /Acceptance checks: 1 passed, 0 failed, 0 unverified/);
  assert.match(text, /Command receipts: 1 succeeded, 0 failed, 0 unverified/);
  assert.match(text, /Files already matched/);
  assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 6);
  assert.ok(text.length < 4000); assert.doesNotMatch(text, /Source-controlled title|Do not include source content|\nxxx/);
  assert.deepEqual(checks, original);
});

test('approval waiting pauses the active clock and expiry still cancels active execution', async () => {
  const clock = new TaskClock(80); clock.start(); await new Promise(resolve => setTimeout(resolve, 15)); clock.pause();
  const remaining = clock.remainingMs; await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(clock.signal.aborted, false); assert.equal(clock.remainingMs, remaining);
  clock.resume(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(clock.signal.aborted, true); clock.close();
});
