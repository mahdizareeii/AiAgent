import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, tokenizeSyntax } from '../renderer/syntax.ts';

test('tokenizer highlights common TypeScript and preserves exact source', () => {
  const source = 'const answer = 42; // local\n';
  const tokens = tokenizeSyntax(source, 'ts');
  assert.equal(tokens.map(token => token.text).join(''), source);
  assert.equal(tokens.some(token => token.kind === 'keyword' && token.text === 'const'), true);
  assert.equal(tokens.some(token => token.kind === 'number' && token.text === '42'), true);
  assert.equal(tokens.some(token => token.kind === 'comment'), true);
});

test('unknown languages safely fall back to plain text', () => {
  const source = '<script>alert("literal")</script>\r\n';
  const tokens = tokenizeSyntax(source, 'made-up-language');
  assert.deepEqual(tokens, [{ kind: 'plain', text: source }]);
  assert.equal(normalizeLanguage('javascript'), 'javascript');
  assert.equal(normalizeLanguage('language-ts'), 'typescript');
});

