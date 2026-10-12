import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choiceKey, type ChoiceOption, type ChoiceState } from '../renderer/choice-flow.ts';

const options: ChoiceOption[] = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'blocked', label: 'Unavailable model', disabled: true },
  { value: 'low-memory', label: 'Low memory' },
  { value: 'experimental-disk', label: 'Experimental disk' },
];

test('opening and navigating a choice never changes the saved preference', () => {
  let state: ChoiceState = { open: false, activeIndex: -1 };
  const opened = choiceKey(state, 'Enter', options, 'automatic');
  assert.equal(opened.open, true); assert.equal(opened.activeIndex, 0); assert.equal(opened.commitIndex, undefined);
  state = opened;
  const down = choiceKey(state, 'ArrowDown', options, 'automatic');
  assert.equal(down.activeIndex, 2, 'Disabled options must be skipped.');
  assert.equal(down.commitIndex, undefined);
  const end = choiceKey(down, 'End', options, 'automatic');
  assert.equal(end.activeIndex, 3); assert.equal(end.commitIndex, undefined);
  const home = choiceKey(end, 'Home', options, 'automatic');
  assert.equal(home.activeIndex, 0);
  const up = choiceKey(home, 'ArrowUp', options, 'automatic');
  assert.equal(up.activeIndex, 3, 'Arrow navigation wraps to enabled options.');
  const committed = choiceKey(up, ' ', options, 'automatic');
  assert.equal(committed.commitIndex, 3); assert.equal(committed.open, false); assert.equal(committed.restoreFocus, true);
});

test('Home, End and opening arrows find enabled choices even when the selected value is unavailable', () => {
  const state = { open: false, activeIndex: -1 };
  assert.equal(choiceKey(state, 'ArrowDown', options, 'missing').activeIndex, 0);
  assert.equal(choiceKey(state, 'ArrowUp', options, 'blocked').activeIndex, 3);
  assert.equal(choiceKey(state, 'End', options, 'automatic').activeIndex, 3);
  assert.equal(choiceKey(state, 'Home', options, 'experimental-disk').activeIndex, 0);
  const enter = choiceKey({ open: true, activeIndex: 2 }, 'Enter', options, 'automatic');
  assert.equal(enter.commitIndex, 2); assert.equal(enter.handled, true); assert.equal(enter.restoreFocus, true);
});

test('Escape cancels navigation and restores trigger focus; Tab closes without intercepting tab order', () => {
  const state = { open: true, activeIndex: 3 };
  const escaped = choiceKey(state, 'Escape', options, 'automatic');
  assert.equal(escaped.open, false); assert.equal(escaped.restoreFocus, true); assert.equal(escaped.commitIndex, undefined);
  assert.equal(escaped.handled, true);
  const tabbed = choiceKey(state, 'Tab', options, 'automatic');
  assert.equal(tabbed.open, false); assert.equal(tabbed.handled, false); assert.equal(tabbed.commitIndex, undefined);
  assert.equal(choiceKey({ open: false, activeIndex: 0 }, 'Escape', options, 'automatic').handled, false);
  assert.equal(choiceKey(state, 'x', options, 'automatic').handled, false);
});

test('empty, all-disabled, or newly disabled options can never be committed', () => {
  for (const unavailable of [[], options.map(option => ({ ...option, disabled: true }))]) {
    const opened = choiceKey({ open: false, activeIndex: -1 }, 'ArrowDown', unavailable, 'automatic');
    assert.equal(opened.activeIndex, -1);
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) assert.equal(choiceKey(opened, key, unavailable, 'automatic').commitIndex, undefined);
  }
  assert.equal(choiceKey({ open: true, activeIndex: 1 }, 'Enter', options, 'automatic').commitIndex, undefined);
  assert.equal(choiceKey({ open: true, activeIndex: 99 }, ' ', options, 'automatic').commitIndex, undefined);
});
