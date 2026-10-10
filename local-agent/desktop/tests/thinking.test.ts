import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendThinking, MAX_THINKING_BYTES } from '../thinking.ts';

test('local thoughts preserve exact streamed text and stop at a separate byte budget', () => {
  let thoughts = '';
  for (const chunk of ['Read the ', 'selected folder first.\n', 'سلام 🌍']) thoughts = appendThinking(thoughts, chunk);
  assert.equal(thoughts, 'Read the selected folder first.\nسلام 🌍');
  thoughts = appendThinking(thoughts, 'x'.repeat(MAX_THINKING_BYTES));
  assert.equal(new TextEncoder().encode(thoughts).length, MAX_THINKING_BYTES);
  assert.equal(appendThinking(thoughts, 'later thoughts'), thoughts);
});

test('byte limits preserve whole multilingual characters without replacement glyphs', () => {
  const base = 'x'.repeat(MAX_THINKING_BYTES - 3);
  assert.equal(appendThinking(base, '🌍Z'), base);
  const retained = appendThinking('', 'سلام 🌍'.repeat(MAX_THINKING_BYTES));
  assert.ok(new TextEncoder().encode(retained).length <= MAX_THINKING_BYTES);
  assert.ok(retained.length > 0);
  assert.ok(!retained.includes('\ufffd'));
  assert.equal(appendThinking('x'.repeat(MAX_THINKING_BYTES + 1), 'new text'), 'x'.repeat(MAX_THINKING_BYTES));
});
