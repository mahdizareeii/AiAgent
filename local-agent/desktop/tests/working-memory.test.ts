import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
import WorkingDetails, {ToolActivityBody} from './WorkingDetails.tsx';
export const working = props => renderToStaticMarkup(createElement(WorkingDetails,props));
export const tool = tool => renderToStaticMarkup(createElement(ToolActivityBody,{tool}));`,
  resolveDir: path.dirname(fileURLToPath(new URL('../renderer/WorkingDetails.tsx', import.meta.url))), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic' });
const module = { exports: {} as { working: (props: object) => string; tool: (tool: object) => string } };
new Function('require', 'module', 'exports', compiled.outputFiles![0].text)(createRequire(import.meta.url), module, module.exports);
const fixture = module.exports;

test('256 collapsed retained activities allocate no formatted payload or syntax body even when Working opens', () => {
  let reads = 0;
  const tools = Array.from({ length: 256 }, (_, index) => ({ id: `tool-${index}`, title: `Activity ${index}`, status: 'completed',
    get input() { reads++; throw new Error('Closed input was accessed'); },
    get output() { reads++; throw new Error('Closed result was accessed'); } }));
  const closed = fixture.working({ active: false, expanded: false, thinking: 'PRIVATE THOUGHTS', tools });
  assert.equal(reads, 0); assert.doesNotMatch(closed, /PRIVATE THOUGHTS|working-content|syntax-block|data-tool-id/);
  assert(closed.length < 1500); assert.match(closed, /256 activities/);
  const opened = fixture.working({ active: false, expanded: true, thinking: 'ACTUAL THOUGHTS', tools });
  assert.equal(reads, 0); assert.match(opened, /ACTUAL THOUGHTS/);
  assert.equal((opened.match(/data-tool-id=/g) ?? []).length, 256);
  assert.doesNotMatch(opened, /syntax-block|<h3>Input|<h3>Result/);
});

test('an opened tool formats complete original multilingual evidence inertly without modifying its receipt', () => {
  const tool = { id: 'read', title: 'Read file', status: 'completed', input: { path: 'سلام.txt' },
    output: { ok: true, text: '\ufeff1: literal\r\nسلام 😀\n<script>inert</script>', sha256: 'a'.repeat(64), eof: true } };
  const before = structuredClone(tool), opened = fixture.tool(tool), readable = opened.replace(/<[^>]*>/g, '');
  assert.match(readable, /سلام\.txt/); assert.match(readable, /literal/); assert.match(readable, /سلام 😀/); assert.match(readable, /eof/);
  assert.match(opened, /&lt;script&gt;inert&lt;\/script&gt;/); assert.doesNotMatch(opened, /<script>/); assert.deepEqual(tool, before);
});
