import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RepairBudget } from '../repair-budget.ts';

test('initial operations do not consume repairs and three repairs are allowed after observed failures', () => {
  const budget = new RepairBudget();
  assert.equal(budget.beginAction('initial-file'), 0);
  assert.equal(budget.beginAction('initial-check'), 0);
  for (let repair = 1; repair <= 3; repair++) {
    budget.failedCheck();
    assert.equal(budget.beginAction(`repair-${repair}`), repair);
    assert.equal(budget.beginAction(`verify-${repair}`), repair);
  }
  budget.failedCheck();
  assert.throws(() => budget.beginAction('fourth-repair'), /Repair limit reached after three repair attempts/);
});

test('multiple failures before the next action form one repair attempt rather than burning the whole limit', () => {
  const budget = new RepairBudget();
  budget.beginAction('initial');
  budget.failedCheck(); budget.failedCheck(); budget.failedCheck(); budget.failedCheck();
  assert.equal(budget.beginAction('repair-batch'), 1);
  assert.equal(budget.beginAction('independent-followup'), 1);
});

test('duplicate action updates cannot consume a second repair or erase a pending observed failure', () => {
  const budget = new RepairBudget();
  budget.beginAction('initial');
  budget.failedCheck();
  assert.equal(budget.beginAction('initial'), 0);
  assert.equal(budget.beginAction('repair'), 1);
  budget.failedCheck();
  assert.equal(budget.beginAction('repair'), 1);
  assert.equal(budget.beginAction('next-repair'), 2);
  assert.equal(budget.beginAction('next-repair'), 2);
});
