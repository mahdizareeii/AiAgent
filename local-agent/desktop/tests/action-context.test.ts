import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionContext } from '../action-context.ts';
import { BudgetedInference, compactionPartition, type ChatBody, type InferenceRuntime } from '../inference-gateway.ts';
import type { ActionToolEvent } from '../actions.ts';

function recordedFile(content = 'exact UTF-8\r\n1: literal\n') {
  const args = { path: 'app.txt', content };
  const receipt = { ok: true, operation: 'write_file', status: 'changed', changed: true,
    path: 'app.txt', sha256: 'a'.repeat(64), bytes: Buffer.byteLength(content), action_id: 'host-write' };
  const resultText = `${JSON.stringify(receipt)}\nUpdated app.txt. A snapshot is available for undo.`;
  const event: ActionToolEvent = { id: 'host-write', title: 'Write file', status: 'completed', input: args,
    output: { content: [{ type: 'text', text: resultText }], structuredContent: receipt } };
  const messages: ChatBody['messages'] = [{ role: 'assistant', content: null,
    tool_calls: [{ id: 'model-write', function: { name: 'reviewed_actions__write_file', arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: 'model-write', content: resultText }];
  const history = new ActionContext(); history.record(event);
  return { args, receipt, event, resultText, messages, history };
}
const latest: ChatBody['messages'] = [{ role: 'assistant', content: null,
  tool_calls: [{ id: 'current-read', function: { name: 'local_files_and_research__read_file', arguments: '{"path":"app.txt"}' } }] },
  { role: 'tool', tool_call_id: 'current-read', content: 'CURRENT_FILE_TEXT_MUST_STAY_EXACT' }];

test('closed actions bind exact arguments and output to independent host receipts', () => {
  const f = recordedFile(); const call = f.messages[0].tool_calls![0];
  const closed = f.history.find(call, f.resultText);
  assert.ok(closed); assert.equal(closed.actionId, f.event.id); assert.equal(closed.callId, call.id);
  assert.equal(closed.status, 'completed'); assert.equal(closed.evidence.sha256, f.receipt.sha256);
  assert.equal(closed.evidence.path, f.args.path); assert.match(closed.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(closed).includes(f.args.content), false);
  assert.deepEqual(f.history.find(call, f.receipt), closed, 'An exact structured receipt binds as well as provider text.');
  assert.equal(f.history.find({ ...call, function: { ...call.function, arguments: JSON.stringify({ ...f.args, content: f.args.content.replace('\r\n', '\n') }) } }, f.resultText), undefined);
  assert.equal(f.history.find(call, { ...f.receipt, sha256: 'b'.repeat(64) }), undefined);
  assert.equal(f.history.find(call, `${f.resultText}\nInvented success.`), undefined);
  assert.equal(f.history.find({ ...call, function: { ...call.function, name: 'unknown_plugin__write_file' } }, f.resultText), undefined);
  assert.equal(new ActionContext().find(call, f.receipt), undefined, 'Model/source receipts alone cannot establish a completed action.');
});

test('command receipt matching honors declared defaults while preserving exact command text and saved output references', () => {
  const history = new ActionContext(); const receipt = { ok: true, operation: 'run_command', log_id: 'log-12345678', durable_id: 'host-command', exit_code: 0, exit_signal: null, output_complete: true, next_offset: null };
  const output = `${JSON.stringify(receipt)}\nCommand output (complete): verified`;
  history.record({ id: 'host-command', title: 'Run command', status: 'completed', input: { command: 'node check.js', timeout_ms: 60000 },
    output: { content: [{ type: 'text', text: output }], structuredContent: receipt } });
  const call = { id: 'model-command', function: { name: 'reviewed_actions__run_command', arguments: '{"command":"node check.js"}' } };
  const closed = history.find(call, output); assert.ok(closed);
  assert.equal(closed.evidence.log_id, receipt.log_id); assert.equal(closed.evidence.exit_code, 0);
  assert.equal(history.find({ ...call, function: { ...call.function, arguments: '{"command":"node check.js "}' } }, output), undefined);
});

test('denials and failed actions retain their owned identities and never become successful receipts', () => {
  const history = new ActionContext(); const text = 'The user denied this action. No action was taken.';
  history.record({ id: 'denied-host-action', title: 'Edit file', status: 'failed', input: { path: 'app.txt', old_text: 'old', new_text: 'new' },
    output: { isError: true, errorCode: 'PERMISSION_DENIED', content: [{ type: 'text', text }] } });
  const closed = history.find({ id: 'denied-model-call', function: { name: 'reviewed_actions__edit_file', arguments: '{"path":"app.txt","old_text":"old","new_text":"new"}' } }, text);
  assert.ok(closed); assert.equal(closed.status, 'failed'); assert.equal(closed.evidence.errorCode, 'PERMISSION_DENIED');
  assert.equal(closed.evidence.message, text);
  assert.equal(history.find({ id: 'wrong', function: { name: 'reviewed_actions__edit_file', arguments: '{"path":"app.txt","old_text":"old","new_text":"different"}' } }, text), undefined);
});

test('latest, pending, mixed, unknown and ambiguous action exchanges remain exact', () => {
  const f = recordedFile(); const user = { role: 'user', content: 'The current request stays exact.' };
  assert.deepEqual(compactionPartition([user, ...f.messages], f.history).actionIndexes, []);
  assert.deepEqual(compactionPartition([user, f.messages[0], ...latest], f.history).actionIndexes, []);
  const mixed = [{ ...f.messages[0], tool_calls: [...f.messages[0].tool_calls!, { id: 'mixed-read', function: { name: 'local_files_and_research__read_file', arguments: '{}' } }] },
    f.messages[1], { role: 'tool', tool_call_id: 'mixed-read', content: 'Read evidence' }];
  assert.deepEqual(compactionPartition([user, ...mixed, ...latest], f.history).actionIndexes, []);
  assert.deepEqual(compactionPartition([user, ...f.messages, ...f.messages, ...latest], f.history).actionIndexes, []);
  const unknown = structuredClone(f.messages); unknown[0].tool_calls![0].function!.name = 'unknown_plugin__write_file';
  assert.deepEqual(compactionPartition([user, ...unknown, ...latest], f.history).actionIndexes, []);
  const partition = compactionPartition([user, ...f.messages, ...latest], f.history);
  assert.deepEqual(partition.actionIndexes, [1, 2]); assert.deepEqual(partition.older, []);
  assert.deepEqual(partition.retained, [user, ...latest]); assert.equal(partition.actions.length, 1);
});

function inferenceFixture() {
  const completed: ChatBody[] = [];
  const runtime: InferenceRuntime = { requestJson: async <T>(url: string, body?: object) => {
    const request = body as ChatBody;
    if (url.endsWith('input_tokens')) return { input_tokens: JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length } as T;
    completed.push(request); return { choices: [{ message: { content: 'Source facts retained.' } }] } as T;
  }, requestStream: async () => { throw new Error('Preparation must not run the agent.'); },
    restartLowerProfile: async () => { throw new Error('Closed actions must never restart inference.'); } };
  return { runtime, completed };
}

test('deterministic action receipts free context without generation, lost checks or changed pending/current inputs', async () => {
  const f = recordedFile('LARGE_RAW_FILE_CONTENT '.repeat(300)); const runtime = inferenceFixture();
  const inference = new BudgetedInference(runtime.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  inference.recordHostAction(f.event);
  const user = { role: 'user', content: 'Verify the created file; never repeat its creation.' };
  const tools = [{ function: { name: 'read_file', parameters: { type: 'object' } } }];
  const body: ChatBody = { messages: [{ role: 'system', content: 'Exact app safety policy' }, user, ...f.messages, ...latest], tools };
  const original = JSON.stringify(body); const prepared = await inference.prepare(body);
  assert.equal(JSON.stringify(body), original); assert.strictEqual(prepared.tools, tools);
  assert.strictEqual(prepared.messages[0], body.messages[0]); assert.ok(prepared.messages.includes(user));
  for (const message of latest) assert.ok(prepared.messages.includes(message));
  const ledger = prepared.messages.find(message => String(message.content).startsWith('Closed action receipts'));
  assert.ok(ledger); assert.match(String(ledger.content), /host-write.*write_file.*completed/);
  assert.ok(String(ledger.content).includes(f.receipt.sha256)); assert.ok(!JSON.stringify(prepared).includes('LARGE_RAW_FILE_CONTENT'));
  assert.match(String(ledger.content), /Never repeat completed or denied actions/);
  assert.equal(runtime.completed.length, 0, 'Closed action receipts must not require generated summaries or another action.');
  assert.ok(await inference.count(prepared) + 100 <= 1936);
});

test('generated read summaries never receive closed raw effectful arguments/results', async () => {
  const f = recordedFile('RAW_EFFECTFUL_ARGUMENT_MUST_NOT_REPLAY '.repeat(150)); const runtime = inferenceFixture();
  const inference = new BudgetedInference(runtime.runtime, { model: 'owned', contextTokens: 2500, outputTokens: 100 });
  inference.recordHostAction(f.event);
  const olderRead: ChatBody['messages'] = [{ role: 'assistant', tool_calls: [{ id: 'old-read', function: { name: 'local_files_and_research__read_file', arguments: '{"path":"notes.txt"}' } }] },
    { role: 'tool', tool_call_id: 'old-read', content: 'Older source facts '.repeat(200) }];
  const body: ChatBody = { messages: [{ role: 'user', content: 'Verify without repeating actions' }, ...olderRead, ...f.messages, ...latest] };
  const original = JSON.stringify(body); const prepared = await inference.prepare(body);
  assert.ok(runtime.completed.length > 0, 'Oversized read evidence must actually be reduced.');
  assert.ok(runtime.completed.every(request => !JSON.stringify(request).includes('RAW_EFFECTFUL_ARGUMENT_MUST_NOT_REPLAY')));
  assert.ok(JSON.stringify(prepared).includes('host-write')); assert.ok(JSON.stringify(prepared).includes('old-read'));
  assert.equal(JSON.stringify(body), original);
});
