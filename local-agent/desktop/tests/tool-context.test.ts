import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactPortableToolDocumentation } from '../tool-context.ts';

const readDescription = 'Read exact UTF-8 source in text, including BOM, CRLF and trailing newlines. Line/column and byte positions are separate metadata, never inserted into text. Copy text exactly for edits; never add/remove line-number prefixes. Continue next_cursor until eof, including long single lines. expected_sha256 detects changed checkpoints. Secret files/symlinks are denied.';
const commandDescription = 'Propose an implementation/debugging shell command in the project directory. Prefer run_verification with one frozen command check_id for acceptance; legacy exact command/cwd/purpose/checkIds remain supported. Approval is required for every command, including its execution time limit; verification metadata grants no permission. timeout_ms defaults to 60000; explicitly select up to 600000 for dependency setup. Result metadata gives log_id, output_complete and next_offset. When output_complete is true, use the shown output without another log read. Interrupted commands preserve partial work and are never automatically repeated. Commands run as the user and are not OS sandboxed.';
const timeoutDescription = 'Approved execution time limit in milliseconds, 100–600000; default 60000. Longer dependency setup requires an explicit value.';
const schema = () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', title: 'read_fileArguments', additionalProperties: false,
  properties: { path: { type: 'string', title: 'Path', minLength: 1, maxLength: 1024, pattern: 'no-parent' },
    start_line: { type: 'integer', title: 'Start Line', default: 1, minimum: 1 },
    max_chars: { title: 'Max Chars', anyOf: [{ type: 'integer', minimum: 1, maximum: 4000 }, { type: 'null' }], default: null },
    cursor: { title: 'Unknown cursor policy', description: 'Unexpected producer metadata stays exact.', anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
    extra: { title: 'Path', description: 'Not a known property; never removed.', enum: ['a', 'b'] } },
  required: ['path'], $defs: { extra: { title: 'Path', description: 'Do not traverse unrelated definitions.', type: 'string' } } });
const readTool = () => ({ type: 'function', strict: true, function: { name: 'local_files_and_research__read_file', description: readDescription, parameters: schema() } });
function withoutDocs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDocs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'title' && key !== 'description').map(([key, child]) => [key, withoutDocs(child)]));
}

test('portable documentation saves only approved annotations while every schema validator and unknown annotation stays exact', () => {
  const original = readTool(), before = JSON.stringify(original);
  const [compacted] = compactPortableToolDocumentation([original])! as typeof original[];
  assert.ok(Buffer.byteLength(JSON.stringify(compacted)) < Buffer.byteLength(before));
  assert.deepEqual(withoutDocs(compacted), withoutDocs(original));
  assert.equal(compacted.function.parameters.$schema, original.function.parameters.$schema);
  assert.equal('title' in compacted.function.parameters, false);
  assert.equal('title' in compacted.function.parameters.properties.path, false);
  assert.deepEqual(compacted.function.parameters.properties.max_chars.anyOf, original.function.parameters.properties.max_chars.anyOf);
  assert.equal(compacted.function.parameters.properties.max_chars.default, null);
  assert.strictEqual(compacted.function.parameters.properties.cursor, original.function.parameters.properties.cursor);
  assert.strictEqual(compacted.function.parameters.properties.extra, original.function.parameters.properties.extra);
  assert.strictEqual(compacted.function.parameters.$defs, original.function.parameters.$defs);
  assert.match(compacted.function.description, /BOM, CRLF and final LF/);
  assert.match(compacted.function.description, /next_cursor until eof.*expected_sha256/);
  assert.equal(JSON.stringify(original), before);
  assert.strictEqual(compactPortableToolDocumentation([compacted])![0], compacted, 'Second formatting is idempotent.');
});

test('command field documentation compacts without changing exact timeout, approval, verification and replay contracts', () => {
  const command = { type: 'function', function: { name: 'reviewed_actions__run_command', description: commandDescription,
    parameters: { type: 'object', properties: { command: { type: 'string' }, purpose: { type: 'string', enum: ['implementation', 'verification'] },
      checkIds: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' } },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 600000, default: 60000, description: timeoutDescription } }, required: ['command'], additionalProperties: false } } };
  const [compacted] = compactPortableToolDocumentation([command])! as typeof command[];
  assert.deepEqual(withoutDocs(compacted), withoutDocs(command));
  assert.ok(compacted.function.parameters.properties.timeout_ms.description.length < timeoutDescription.length);
  assert.match(compacted.function.description, /no approval.*60000ms.*100–600000.*Interrupted commands never replay/);
  assert.equal(compacted.function.parameters.properties.timeout_ms.default, 60000);
  assert.strictEqual(compacted.function.parameters.properties.checkIds, command.function.parameters.properties.checkIds);
});

test('unknown tools, changed producer descriptions and malformed data never inherit host documentation rewrites', () => {
  const original = readTool();
  const unknown = { ...original, function: { ...original.function, name: 'plugin__read_file' } };
  const changed = { ...original, function: { ...original.function, description: readDescription + ' Additional unreviewed requirement.' } };
  const values = [unknown, changed, { function: { name: 'read_file', description: readDescription, parameters: schema() } },
    { function: { name: 'toString', description: readDescription, parameters: schema() } }, null, 7, { function: [] }];
  const before = JSON.stringify(values);
  assert.strictEqual(compactPortableToolDocumentation(values), values);
  assert.equal(JSON.stringify(values), before);
  assert.equal(compactPortableToolDocumentation(undefined), undefined);
});
