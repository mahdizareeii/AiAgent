import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { BudgetedInference, compactionPartition, createInferenceGateway, type ChatBody, type InferenceRuntime } from '../inference-gateway.ts';
import { DEFAULT_UTILITIES, effectiveUtilities, migrateState } from '../state.ts';

function fixture() {
  const counted: ChatBody[] = []; let calls = 0; let restarts = 0; let failure: string | undefined;
  const runtime: InferenceRuntime = {
    requestJson: async <T>(url: string, raw?: object) => {
      const body = raw as ChatBody;
      if (url.endsWith('input_tokens')) { counted.push(body); return { input_tokens: JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length } as T; }
      calls++; if (failure) { const value = failure; failure = undefined; throw new Error(value); }
      return { choices: [{ message: { content: 'Saved earlier facts.' } }] } as T;
    },
    requestStream: async () => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    restartLowerProfile: async () => { restarts++; return { contextTokens: 1500, outputTokens: 100 }; },
  };
  return { runtime, counted, calls: () => calls, restarts: () => restarts, fail: (value: string) => { failure = value; } };
}
test('native token budget includes tools and output reserve; pending exchanges survive compaction', async () => {
  const f = fixture(); const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  const call = { role: 'assistant', tool_calls: [{ id: 'pending' }], content: null };
  const tool = { role: 'tool', tool_call_id: 'pending', content: 'exact result' };
  const body: ChatBody = { messages: [{ role: 'system', content: 'Keep instructions' }, { role: 'user', content: 'Old question' }, { role: 'assistant', content: 'x'.repeat(2200) }, { role: 'user', content: 'Current request' }, call, tool], tools: [{ function: { name: 'read_file' } }], max_tokens: 9999 };
  const prepared = await inference.prepare(body);
  assert.equal(prepared.max_tokens, 100); assert.equal(prepared.parallel_tool_calls, false);
  assert.equal(prepared.cache_prompt, false);
  assert.deepEqual(prepared.messages.slice(-2), [call, tool]);
  assert.equal(prepared.messages[0].content, 'Keep instructions');
  assert.match(String(prepared.messages.find(message => message.role === 'user')?.content), /Current request/);
  assert.ok(f.counted.some(counted => counted.tools?.length === 1));
  assert.ok(await inference.count(prepared) + 100 <= 1936);
});
test('an oversized active request is rejected rather than silently truncated', async () => {
  const f = fixture(); const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 1000, outputTokens: 100 });
  await assert.rejects(inference.prepare({ messages: [{ role: 'user', content: 'x'.repeat(1000) }] }), /current request/);
  assert.equal(f.calls(), 0);
});
test('allocation recovery retries only inference; ordinary errors do not restart the engine', async () => {
  const f = fixture(); const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  f.fail('failed to allocate memory');
  await inference.completeJson({ messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(f.restarts(), 1); assert.equal(f.calls(), 2);
  f.fail('invalid chat template');
  await assert.rejects(inference.completeJson({ messages: [{ role: 'user', content: 'Hello' }] }), /invalid chat template/);
  assert.equal(f.restarts(), 1);
});
test('compaction preserves every action and result from the active user turn', () => {
  const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Old task' }, { role: 'assistant', content: 'Old result' },
    { role: 'user', content: 'Create the project' }, { role: 'assistant', tool_calls: [{ id: 'written' }] },
    { role: 'tool', tool_call_id: 'written', content: 'Created index.php. Snapshot available.' },
    { role: 'assistant', content: 'The file is created; now verify it.' }, { role: 'assistant', tool_calls: [{ id: 'new' }] },
    { role: 'tool', tool_call_id: 'new', content: 'Verification passed' }];
  const partition = compactionPartition(messages);
  assert.deepEqual(partition.retained, [messages[0], ...messages.slice(3)]);
  assert.deepEqual(partition.older, messages.slice(1, 3));
});
test('an oversized active action history is rejected without summarizing or replaying actions', async () => {
  const f = fixture(); const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 1000, outputTokens: 100 });
  await assert.rejects(inference.prepare({ messages: [{ role: 'user', content: 'Build project' },
    { role: 'assistant', tool_calls: [{ id: 'write' }] }, { role: 'tool', tool_call_id: 'write', content: 'Created file. '.repeat(100) },
    { role: 'assistant', tool_calls: [{ id: 'verify' }] }, { role: 'tool', tool_call_id: 'verify', content: 'Passed' }] }), /current request/);
  assert.equal(f.calls(), 0);
});
test('gateway rejects browser origins and missing tokens and streams authenticated local completions', async () => {
  const f = fixture(), controller = new AbortController();
  const gateway = await createInferenceGateway(new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 }), controller.signal);
  try {
    assert.equal((await fetch(`${gateway.baseUrl}/v1/models`)).status, 403);
    assert.equal((await fetch(`${gateway.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${gateway.apiKey}`, Origin: 'https://example.org' } })).status, 403);
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Hello' }] }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
  } finally { controller.abort(); await gateway.close(); }
});
test('disconnected active and queued gateway requests cannot continue or start generation', { timeout: 5000 }, async () => {
  const controller = new AbortController(); let generations = 0;
  let started!: () => void; const active = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const runtime: InferenceRuntime = {
    requestJson: async <T>(url: string) => ({ input_tokens: 10 }) as T,
    requestStream: async (_url, _body, signal) => {
      generations++; started();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => { aborted(); reject(new Error('Generation cancelled')); }, { once: true });
      });
      return new Response();
    },
    restartLowerProfile: async () => { throw new Error('Cancellation must not restart inference'); },
  };
  const gateway = await createInferenceGateway(new BudgetedInference(runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 }), controller.signal);
  const outgoing = () => {
    const client = request(`${gateway.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}`, 'Content-Type': 'application/json' } });
    client.on('error', () => {});
    client.end(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Create project' }] }));
    return client;
  };
  try {
    const first = outgoing(); await active;
    const second = outgoing();
    await new Promise(resolve => setTimeout(resolve, 30));
    second.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
    first.destroy(); await cancelled;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(generations, 1, 'Cancelled queued work must not call the model after the active request stops.');
  } finally { controller.abort(); await gateway.close(); }
});
test('legacy settings migrate without losing chats/grants and web is off by default', () => {
  const session = { id: randomUUID(), title: 'Saved chat', updatedAt: '2026-10-07', mode: 'coding', projectPath: '/project', messages: [{ role: 'user', content: 'Keep me' }], files: [{ name: 'file.txt', path: '/project/file.txt' }] };
  const state = migrateState({ selectedModel: 'qwen3.5:4b', executablePath: '/old/ollama', mode: 'coding', sessions: [session] });
  assert.equal(state.version, 2); assert.deepEqual(state.sessions, [session]); assert.equal(state.utilities.webResearch, false); assert.ok(!('executablePath' in state));
  assert.equal(effectiveUtilities('assistant', DEFAULT_UTILITIES).terminal, false);
  assert.throws(() => migrateState({ ...state, version: 999 }));
});
