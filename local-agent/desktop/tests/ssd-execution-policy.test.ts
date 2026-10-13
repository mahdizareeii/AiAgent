import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionBudgetMs, MAX_TASK_BUDGET_MS, NORMAL_TASK_BUDGET_MS, providerTimeoutSeconds } from '../execution-policy.ts';
import { TaskClock, TaskTimeoutError } from '../task-clock.ts';
import { emptyState, migrateState } from '../state.ts';

test('only new SSD work receives hours; retained tasks and ordinary modes retain their caps', () => {
  assert.equal(executionBudgetMs('ssd-experts'), 4 * NORMAL_TASK_BUDGET_MS);
  assert.equal(executionBudgetMs('ssd-experts', 8), MAX_TASK_BUDGET_MS);
  for (const mode of ['automatic', 'low-memory', 'experimental-disk']) assert.equal(executionBudgetMs(mode, 8), NORMAL_TASK_BUDGET_MS);
  assert.equal(executionBudgetMs('ssd-experts', 8, NORMAL_TASK_BUDGET_MS), NORMAL_TASK_BUDGET_MS);
  for (const invalid of [0, 500, 999, -1, NaN, Infinity, MAX_TASK_BUDGET_MS + 1]) assert.throws(() => executionBudgetMs('ssd-experts', 4, invalid));
  assert.equal(executionBudgetMs('ssd-experts', 4, 1000), 1000);
  assert.equal(providerTimeoutSeconds(executionBudgetMs('ssd-experts', 8)), 28_800);
  assert.equal(providerTimeoutSeconds(), 3600);
  assert.throws(() => providerTimeoutSeconds(MAX_TASK_BUDGET_MS + 1));
});

test('saved execution budgets below the runtime transport minimum are rejected', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved', updatedAt: '2026-10-10', mode: 'coding', messages: [], files: [], executionBudgetMs: 500 };
  assert.throws(() => migrateState({ ...emptyState(), sessions: [session] }));
  assert.throws(() => providerTimeoutSeconds(500));
});

test('approval waiting pauses the selected clock and timeout names its actual budget', () => {
  let now = 0;
  const clock = new TaskClock(4 * NORMAL_TASK_BUDGET_MS, () => now);
  clock.start(); now += 1000; clock.pause();
  const remaining = clock.remainingMs;
  now += 20 * NORMAL_TASK_BUDGET_MS; assert.equal(clock.remainingMs, remaining);
  clock.pause(); clock.resume(); assert.equal(clock.remainingMs, remaining);
  clock.resume(); now += 2000; assert.equal(clock.remainingMs, remaining - 2000); clock.close();
  assert.match(new TaskTimeoutError(4 * NORMAL_TASK_BUDGET_MS).message, /4-hour/);
  assert.match(new TaskTimeoutError().message, /one-hour/);
});

test('v4 upgrade preserves exact histories and cancels legacy mmap readiness inference', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved', updatedAt: '2026-10-10', mode: 'coding', taskEffort: 'standard',
    projectPath: '/saved', files: [{ name: 'a.txt', path: '/saved/a.txt' }], messages: [{ role: 'assistant', content: 'Literal 1: text\r\n' }] };
  const upgraded = migrateState({ ...emptyState(), version: 4, memoryMode: 'experimental-disk', selectedModel: 'gemma4:26b', sessions: [session] });
  assert.equal(upgraded.version, 5); assert.equal(upgraded.memoryMode, 'automatic'); assert.equal(upgraded.ssdTaskHours, 4);
  assert.equal(upgraded.selectedModel, 'gemma4:26b');
  assert.deepEqual(upgraded.sessions[0], { ...session, executionBudgetMs: NORMAL_TASK_BUDGET_MS });
  assert.deepEqual(migrateState({ ...upgraded, memoryMode: 'ssd-experts', ssdTaskHours: 8 }), { ...upgraded, memoryMode: 'ssd-experts', ssdTaskHours: 8 });
});
