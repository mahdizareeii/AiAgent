import test from 'node:test';
import assert from 'node:assert/strict';
import { ownsTrialCancellation } from '../model-trial-control.ts';

test('trial cancellation is scoped to its live owned preflight', () => {
  assert.equal(ownsTrialCancellation('a', 'a', { id: 'a', state: 'loading' }), true);
  assert.equal(ownsTrialCancellation('a', 'a', { id: 'a', state: 'calibrating' }), true);
  // An old click cannot cancel a new trial, a normal preparation, or settled work.
  assert.equal(ownsTrialCancellation('a', 'b', { id: 'b', state: 'loading' }), false);
  assert.equal(ownsTrialCancellation('a', undefined, { id: 'a', state: 'loading' }), false);
  assert.equal(ownsTrialCancellation('a', 'a', { id: 'b', state: 'loading' }), false);
  for (const state of ['passed', 'failed', 'cancelled'])
    assert.equal(ownsTrialCancellation('a', 'a', { id: 'a', state }), false);
  assert.equal(ownsTrialCancellation('a', 'a', undefined), false);
});
