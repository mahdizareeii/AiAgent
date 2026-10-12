import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { assertValidationBinding, validationSequence, VALIDATION_FINAL, VALIDATION_INITIAL } from '../model-validation.ts';
import { checkFromHostAction } from '../task-outcome.ts';
import type { ModelValidationRecord, TaskCheck, ToolActivity } from '../renderer/types.ts';

const root = path.resolve('validation-fixture');
const file = path.join(root, 'model-check.txt');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const initialHash = digest(VALIDATION_INITIAL);
const finalHash = digest(VALIDATION_FINAL);

function mutation(operation: string, hash: string, id: string): Record<string, unknown> {
  return { ok: true, operation, path: 'model-check.txt', changed: true, status: 'changed', sha256: hash, action_id: id };
}
function readback(text: string): Record<string, unknown> {
  const size = Buffer.byteLength(text);
  return { ok: true, path: file, sha256: digest(text), text, size, start_line: 1, start_column: 1,
    start_byte: 0, end_byte: size, eof: true };
}
function activity(id: string, title: string, output: unknown): ToolActivity {
  return { id, title, status: 'completed', output };
}
function hostCheck(id: string, receipt: Record<string, unknown>): TaskCheck {
  const check = checkFromHostAction({ id, title: 'Write file', status: 'completed',
    output: { content: [{ type: 'text', text: `${JSON.stringify(receipt)}\nHost result.` }], structuredContent: receipt } });
  assert.ok(check);
  return check;
}
function fixture() {
  const created = mutation('write_file', initialHash, 'host-create');
  const edited = mutation('edit_file', finalHash, 'host-edit');
  const tools = [activity('create', 'reviewed_actions: write_file', created),
    activity('read-before', 'local_files_and_research: read_file', readback(VALIDATION_INITIAL)),
    activity('edit', 'reviewed_actions: edit_file', edited),
    activity('read-after', 'local_files_and_research: read_file', readback(VALIDATION_FINAL))];
  return { tools, checks: [hostCheck('host-create', created), hostCheck('host-edit', edited)] };
}

test('model validation cannot reuse results from different weights, runtime or execution profile', () => {
  const record: ModelValidationRecord = { id: 'validation', modelId: 'qwen', digest: initialHash, templateHash: 'template', runtime: '0.6.0',
    profileSignature: 'cpu-4k', startedAt: 'now', status: 'running', checks: [] };
  const current = { id: record.modelId, digest: record.digest, runtime: record.runtime, profileSignature: record.profileSignature };
  assert.doesNotThrow(() => assertValidationBinding(record, current));
  for (const key of ['id', 'digest', 'runtime', 'profileSignature'] as const) {
    assert.throws(() => assertValidationBinding(record, { ...current, [key]: 'different' }), /changed since this validation/);
  }
});

test('validation accepts ordered exact readbacks and host-bound mutation receipts in real ACP forms', () => {
  for (const format of ['raw', 'structured', 'mcp-text']) {
    const { tools, checks } = fixture();
    for (const tool of tools) {
      if (format === 'structured') tool.output = { structuredContent: tool.output, content: [] };
      if (format === 'mcp-text') tool.output = { content: [{ type: 'text', text: JSON.stringify(tool.output) }] };
    }
    // The text fallback requires an operation on receipts. Actual source tools
    // supply structured data rather than a source's arbitrary JSON text.
    if (format === 'mcp-text') {
      tools[1].output = { structuredContent: readback(VALIDATION_INITIAL) };
      tools[3].output = { structuredContent: readback(VALIDATION_FINAL) };
    }
    assert.deepEqual(validationSequence(tools, checks, root), { complete: true, fileOnly: true });
  }
});

test('validation rejects missing, reordered and incomplete operations even when final bytes would match', () => {
  const { tools, checks } = fixture();
  for (let index = 0; index < tools.length; index++) {
    assert.equal(validationSequence(tools.filter((_tool, position) => position !== index), checks, root).complete, false);
    const interrupted = structuredClone(tools); interrupted[index].status = 'interrupted';
    assert.equal(validationSequence(interrupted, checks, root).complete, false);
  }
  for (const order of [[1, 0, 2, 3], [0, 2, 1, 3], [0, 1, 3, 2]]) {
    assert.equal(validationSequence(order.map(index => tools[index]), checks, root).complete, false);
  }
});

test('validation rejects another path, digest, action ID, denied action or invented success receipt', () => {
  for (const index of [0, 2]) {
    for (const change of [{ path: 'other.txt' }, { sha256: '0'.repeat(64) }, { action_id: 'invented' }, { changed: false }, { ok: false }]) {
      const { tools, checks } = fixture();
      tools[index].output = { ...(tools[index].output as Record<string, unknown>), ...change };
      assert.equal(validationSequence(tools, checks, root).complete, false);
    }
    const { tools, checks } = fixture();
    checks[index === 0 ? 0 : 1].status = 'failed';
    assert.equal(validationSequence(tools, checks, root).complete, false);
    assert.equal(validationSequence(tools, [], root).complete, false);
  }
  const { tools, checks } = fixture();
  tools[2].output = 'I edited the file and all checks passed.';
  assert.equal(validationSequence(tools, checks, root).complete, false);
});

test('readback verification requires exact full UTF-8 content and the canonical fixture path', () => {
  for (const index of [1, 3]) {
    const expected = index === 1 ? VALIDATION_INITIAL : VALIDATION_FINAL;
    const size = Buffer.byteLength(expected);
    for (const change of [{ path: path.join(root, 'other.txt') }, { sha256: '0'.repeat(64) }, { eof: false },
      { start_byte: 1 }, { end_byte: size - 1 }, { text: `1: ${expected}` }, { text: expected.replace('\n', '\r\n') },
      { text: expected.trimEnd() }, { text: `${expected}\n` }, { text: `\uFEFF${expected}` }]) {
      const { tools, checks } = fixture();
      tools[index].output = { ...(tools[index].output as Record<string, unknown>), ...change };
      assert.equal(validationSequence(tools, checks, root).complete, false);
    }
  }
});

test('file-only validation records terminal tool calls even if they were denied or interrupted', () => {
  for (const status of ['pending', 'failed', 'interrupted', 'completed']) {
    const { tools, checks } = fixture();
    tools.push({ id: 'command', title: 'reviewed_actions: run_command', status });
    assert.equal(validationSequence(tools, checks, root).fileOnly, false);
  }
  const { tools, checks } = fixture();
  checks.push({ id: 'hidden-command', title: 'Action', status: 'failed', detail: '', evidence: { operation: 'run_command' } });
  assert.equal(validationSequence(tools, checks, root).fileOnly, false);
});

function batchCreation(): Record<string, unknown> {
  return { ok: true, operation: 'create_files', status: 'changed', changed: true, action_id: 'host-create',
    files: [{ path: 'model-check.txt', changed: true, sha256: initialHash, bytes: Buffer.byteLength(VALIDATION_INITIAL) }] };
}

function batchFixture(created = batchCreation(), hostCreated = created) {
  const { tools, checks } = fixture();
  tools[0] = activity('create', 'reviewed_actions: create_files', created);
  checks[0] = hostCheck('host-create', hostCreated);
  return { tools, checks };
}

test('a precise single-file creation batch is accepted only with its matching host receipt', () => {
  for (const format of ['raw', 'structured', 'mcp-text']) {
    const { tools, checks } = batchFixture();
    if (format === 'structured') tools[0].output = { structuredContent: tools[0].output, content: [] };
    if (format === 'mcp-text') tools[0].output = { content: [{ type: 'text', text: `${JSON.stringify(tools[0].output)}\nCreated one file.` }] };
    assert.deepEqual(validationSequence(tools, checks, root), { complete: true, fileOnly: true });
  }
});

test('creation batches with other files, wrong source identity or incomplete receipts cannot pass validation', () => {
  const original = batchCreation();
  const originalFiles = original.files as Record<string, unknown>[];
  for (const change of [{ files: [] }, { files: 'model-check.txt' },
    { files: [...originalFiles, { path: 'extra.txt', changed: true, sha256: initialHash }] },
    { files: [{ ...originalFiles[0], path: 'other.txt' }] },
    { files: [{ ...originalFiles[0], sha256: '0'.repeat(64) }] },
    { files: [{ ...originalFiles[0], bytes: 1 }] },
    { files: [{ ...originalFiles[0], changed: false }] },
    { changed: false }, { ok: false }, { action_id: undefined }]) {
    const { tools, checks } = batchFixture({ ...original, ...change });
    assert.equal(validationSequence(tools, checks, root).complete, false);
  }
});

test('a model cannot invent creation-batch success by mismatching the independently recorded host action', () => {
  const actual = batchCreation();
  const actualFiles = actual.files as Record<string, unknown>[];
  for (const differentHost of [{ ...actual, action_id: 'different-host-action' },
    { ...actual, files: [{ ...actualFiles[0], path: 'other.txt' }] },
    { ...actual, files: [{ ...actualFiles[0], sha256: '0'.repeat(64) }] },
    { ...actual, files: [...actualFiles, { path: 'extra.txt', changed: true, sha256: initialHash }] }]) {
    const { tools, checks } = batchFixture(actual, differentHost);
    assert.equal(validationSequence(tools, checks, root).complete, false);
  }
  const invented = batchFixture({ ...actual, action_id: 'invented-model-action' }, actual);
  assert.equal(validationSequence(invented.tools, invented.checks, root).complete, false);
  const denied = batchFixture(); denied.checks[0].status = 'failed';
  assert.equal(validationSequence(denied.tools, denied.checks, root).complete, false);
  assert.equal(validationSequence(denied.tools, [], root).complete, false);
  const truncated = batchFixture(); truncated.checks[0].detail = truncated.checks[0].detail.slice(0, 60);
  assert.equal(validationSequence(truncated.tools, truncated.checks, root).complete, false);
  const differentOperation = batchFixture(); differentOperation.checks[0].evidence!.operation = 'write_file';
  assert.equal(validationSequence(differentOperation.tools, differentOperation.checks, root).complete, false);
});
