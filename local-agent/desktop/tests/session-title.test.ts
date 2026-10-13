import test from 'node:test';
import assert from 'node:assert/strict';
import { newSessionTitle, titleFromFirstRequest } from '../session-title.ts';

test('task and Chat names identify their mode before the first request', () => {
  assert.equal(newSessionTitle('coding'), 'New task');
  assert.equal(newSessionTitle('assistant'), 'New chat');
  assert.equal(newSessionTitle('research'), 'New research');
});

test('a first request names all generic and legacy placeholders without renaming existing tasks', () => {
  for (const generic of ['New task', 'New chat', 'New research'])
    assert.equal(titleFromFirstRequest(generic, '  Build a CLI  '), 'Build a CLI');
  assert.equal(titleFromFirstRequest('Validate this model', 'Build a CLI'), 'Validate this model');
  assert.equal(titleFromFirstRequest('New task', '   '), 'New task');
  assert.equal(titleFromFirstRequest('New task', 'x'.repeat(90)).length, 60);
});
