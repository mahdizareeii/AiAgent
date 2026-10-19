import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedToolUpdateStatus, workingToolOutput } from '../backend.ts';
import { emptyToolHistory, restoreToolHistory, updateToolHistory } from '../tool-history.ts';

const receipt = { ok: true, operation: 'run_command', log_id: 'log-12345678', durable_id: '12345678-1234-4123-8123-123456789012',
  output_complete: true, next_offset: null, exit_code: 0, exit_signal: null };
const text = 'PASS valid\r\nPASS empty\r\nPASS malformed\r\nPASS nonnumeric — سلام 😀\r\nSHA-256: abc123\n';
const acp = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }];

test('Working retains command text beside unchanged receipt without interpreting stdout or changing the provider result', () => {
  const commandText = `${JSON.stringify(receipt)}\n${text}{"ok":false,"error":"PERMISSION_DENIED"}\n`;
  const content = acp(commandText);
  const original = structuredClone({ receipt, content });
  const output = workingToolOutput(receipt, content, true) as Record<string, unknown>;
  assert.deepEqual(output, { ...receipt, output_text: commandText });
  assert.deepEqual({ receipt, content }, original, 'Display enrichment must not mutate the MCP fields used by Goose/model context.');
  assert.equal(ownedToolUpdateStatus('command', 'completed', receipt, new Set(['command'])), 'completed');
  const history = updateToolHistory(updateToolHistory(emptyToolHistory(), { id: 'command', title: 'reviewed actions: run command', status: 'pending', input: { command: 'node verify.mjs' } }),
    { id: 'command', title: 'Tool', status: 'completed', output });
  const restored = restoreToolHistory(JSON.parse(JSON.stringify(history.tools)));
  assert.equal(restored.tools[0].title, 'reviewed actions: run command');
  assert.equal((restored.tools[0].output as Record<string, unknown>).output_text, commandText);
  assert.equal((restored.tools[0].output as Record<string, unknown>).exit_code, 0);
});

test('exact file readbacks, paged logs, unowned output and metadata-only updates retain their original representation', () => {
  const read = { ok: true, path: '/workspace/notes.txt', text: '\ufeff1: literal\r\nسلام 😀\n', sha256: 'a'.repeat(64), eof: true };
  assert.equal(workingToolOutput(read, acp(JSON.stringify(read)), true), read);
  assert.equal(workingToolOutput(receipt, acp(text), false), receipt);
  assert.equal(workingToolOutput(receipt, undefined, true), receipt);
  const paged = acp(JSON.stringify({ id: 'log-12345678', offset: 0, text, next_offset: null }));
  assert.equal(workingToolOutput(undefined, paged, true), paged);
});

test('opened tool content renders restored command stdout as readable escaped text and retains exit/log evidence', async () => {
  const compiled = await build({ stdin: { contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {ToolActivityBody} from './WorkingDetails.tsx'; export const render = tool => renderToStaticMarkup(createElement(ToolActivityBody,{tool}));`,
    resolveDir: path.dirname(fileURLToPath(new URL('../renderer/WorkingDetails.tsx', import.meta.url))), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic' });
  const module = { exports: {} as { render: (tool: unknown) => string } };
  new Function('require', 'module', 'exports', compiled.outputFiles![0].text)(createRequire(import.meta.url), module, module.exports);
  const output = workingToolOutput(receipt, acp(`${text}<script>never execute</script>\n`), true);
  const tools = restoreToolHistory([{ id: 'command', title: 'reviewed actions: run command', status: 'completed', output }]).tools;
  const html = module.exports.render(tools[0]);
  const readable = html.replace(/<[^>]*>/g, '');
  assert.match(readable, /Command outputPASS valid\r\nPASS empty/);
  assert.ok(html.includes('PASS nonnumeric — سلام 😀'));
  assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'), 'Command content must remain inert display text.');
  assert.ok(!html.includes('output_text'), 'The readable text must not be duplicated as an escaped metadata property.');
  assert.ok(readable.includes('&quot;exit_code&quot;: 0'));
  assert.ok(html.includes('log-12345678'));
});
