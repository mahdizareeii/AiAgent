import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { BudgetedInference, compactionPartition, createInferenceGateway, type ChatBody, type InferenceRuntime } from '../inference-gateway.ts';
import { DEFAULT_UTILITIES, effectiveUtilities, migrateState } from '../state.ts';

function fixture() {
  const counted: ChatBody[] = []; const completed: ChatBody[] = []; let calls = 0; let restarts = 0; let failure: string | undefined;
  const runtime: InferenceRuntime = {
    requestJson: async <T>(url: string, raw?: object) => {
      const body = raw as ChatBody;
      if (url.endsWith('input_tokens')) { counted.push(body); return { input_tokens: JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length } as T; }
      calls++; completed.push(body); if (failure) { const value = failure; failure = undefined; throw new Error(value); }
      return { choices: [{ message: { content: 'Saved earlier facts.' } }] } as T;
    },
    requestStream: async () => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    restartLowerProfile: async () => { restarts++; return { contextTokens: 1500, outputTokens: 100 }; },
  };
  return { runtime, counted, completed, calls: () => calls, restarts: () => restarts, fail: (value: string) => { failure = value; } };
}
test('bounded local summaries explicitly disable thinking so their allowance remains available for source facts', async () => {
  const f = fixture();
  const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  assert.equal(await inference.summarize('Verified facts at notes.txt:12.', undefined, 'Create the project'), 'Saved earlier facts.');
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].max_tokens, 100);
  assert.deepEqual(f.completed[0].chat_template_kwargs, { enable_thinking: false });
  assert.ok(f.counted.every(body => JSON.stringify(body.chat_template_kwargs) === '{"enable_thinking":false}'));
  assert.equal(f.completed[0].messages[1].content, 'Verified facts at notes.txt:12.');
});
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
  assert.strictEqual(prepared.messages.findLast(message => message.role === 'user'), body.messages.findLast(message => message.role === 'user'));
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
  assert.deepEqual(partition.retained, [messages[0], ...messages.slice(3, 6), ...messages.slice(7)]);
  assert.deepEqual(partition.older, [messages[1], messages[2], messages[6]]);
  assert.deepEqual(partition.retained.filter(message => message.tool_calls || message.role === 'tool'), messages.filter(message => message.tool_calls || message.role === 'tool'));
});
test('an oversized active action history is rejected without summarizing or replaying actions', async () => {
  const f = fixture(); const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 1000, outputTokens: 100 });
  await assert.rejects(inference.prepare({ messages: [{ role: 'user', content: 'Build project' },
    { role: 'assistant', tool_calls: [{ id: 'write' }] }, { role: 'tool', tool_call_id: 'write', content: 'Created file. '.repeat(100) },
    { role: 'assistant', tool_calls: [{ id: 'verify' }] }, { role: 'tool', tool_call_id: 'verify', content: 'Passed' }] }), /current request/);
  assert.equal(f.calls(), 0);
});
function exchange(id: string, name: string, content: string, args = '{}'): ChatBody['messages'] {
  return [{ role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: args } }] },
    { role: 'tool', tool_call_id: id, content }];
}
test('within-turn partition compacts completed owned reads and narration while preserving every mutation across history', () => {
  const actions = ['run_command', 'write_file', 'create_files', 'edit_file'].flatMap((name, index) =>
    exchange(`action-${index}`, `reviewed_actions__${name}`, `Exact completed ${name} result`, JSON.stringify({ proof: name })));
  const reads = exchange('old-read', 'local_files_and_research__read_file', 'Old read evidence', '{"path":"notes.txt"}');
  const latest = exchange('latest-read', 'local_files_and_research__inspect_file', 'Latest evidence');
  const currentUser = { role: 'user', content: 'Keep this exact current request' };
  const messages = [{ role: 'system', content: 'Exact instructions' }, { role: 'user', content: 'Earlier task' },
    ...actions, currentUser, ...reads, { role: 'assistant', content: 'Older narration to compact' }, ...latest];
  const before = JSON.stringify(messages), partition = compactionPartition(messages);
  assert.deepEqual(partition.older, [...reads, messages.at(-3)]);
  assert.deepEqual(partition.retained, [messages[0], messages[1], ...actions, currentUser, ...latest]);
  assert.equal(JSON.stringify(messages), before, 'Partition must not modify the original transcript.');
  for (const message of [...actions, currentUser, ...latest]) assert.ok(partition.retained.includes(message));
});
test('pending, incomplete, mixed, unknown, duplicate, and orphan tool exchanges never lose pairing', () => {
  const read = (id: string) => ({ id, function: { name: 'local_files_and_research__read_file', arguments: '{}' } });
  const cases: ChatBody['messages'][] = [
    [{ role: 'assistant', tool_calls: [read('pending')] }],
    [{ role: 'assistant', tool_calls: [read('partial-a'), read('partial-b')] }, { role: 'tool', tool_call_id: 'partial-a', content: 'Returned only once' }],
    [{ role: 'assistant', tool_calls: [read('mixed-read'), { id: 'mixed-action', function: { name: 'reviewed_actions__write_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'mixed-read', content: 'Read' }, { role: 'tool', tool_call_id: 'mixed-action', content: 'Written' }],
    exchange('unknown', 'unknown_plugin__read_file', 'Unknown plugin output'),
    exchange('unprefixed', 'read_file', 'Unowned name'),
    [...exchange('duplicate-call', 'local_files_and_research__read_file', 'First'), ...exchange('duplicate-call', 'local_files_and_research__read_file', 'Second')],
    [...exchange('duplicate-result', 'local_files_and_research__read_file', 'First'), { role: 'tool', tool_call_id: 'duplicate-result', content: 'Second' }],
    [{ role: 'tool', tool_call_id: 'orphan', content: 'No matching call' }],
    [exchange('separated', 'local_files_and_research__read_file', 'Read')[0], { role: 'assistant', content: 'Intervening narration' }, exchange('separated', 'local_files_and_research__read_file', 'Read')[1]],
  ];
  for (const group of cases) {
    const latest = exchange('latest', 'local_files_and_research__read_file', 'Must remain exact');
    const partition = compactionPartition([{ role: 'user', content: 'Current task' }, ...group, ...latest]);
    assert.deepEqual(partition.older.filter(message => message.role === 'tool' || message.tool_calls?.length), []);
    for (const message of [...group.filter(message => message.role === 'tool' || message.tool_calls?.length), ...latest]) assert.ok(partition.retained.includes(message));
  }
});
test('native-counted read compaction makes room at 8K without rewriting current request, tools, or command results', async () => {
  const f = fixture(), stages: string[] = [];
  const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 8192, outputTokens: 512 }, stage => stages.push(stage));
  const hash = 'a'.repeat(64);
  const fileRead = exchange('file-read', 'local_files_and_research__read_file', JSON.stringify({ path: 'src/سلام.ts', sha256: hash, start_line: 12, start_column: 1, text: 'READ_FACT '.repeat(360) }), '{"path":"src/سلام.ts","start_line":12}');
  const pdfRead = exchange('pdf-read', 'local_files_and_research__read_pdf', JSON.stringify({ path: 'spec.pdf', sha256: hash, pages: [{ page: 4, label: 'iv', text: 'PDF_FACT '.repeat(360) }] }), '{"path":"spec.pdf","start_page":4}');
  const command = exchange('completed-command', 'reviewed_actions__run_command', `COMMAND_RESULT_EXACT ${'x'.repeat(2000)}`, '{"command":"verify once"}');
  const current = { role: 'user', content: [{ type: 'text', text: 'Implement and validate the task exactly.' }] };
  const instructions = { role: 'system', content: 'Trusted instructions stay exact' };
  const body: ChatBody = { messages: [instructions, current, ...fileRead, { role: 'assistant', content: 'Older read narration' }, ...pdfRead, ...command], tools: [{ function: { name: 'reviewed_actions__run_command', parameters: { type: 'object' } } }], max_tokens: 512 };
  const prepared = await inference.prepare(body);
  assert.strictEqual(prepared.messages[0], instructions);
  assert.strictEqual(prepared.messages[1], current);
  assert.strictEqual(prepared.tools, body.tools);
  for (const message of command) assert.ok(prepared.messages.includes(message), 'Command exchange must remain the same object and bytes.');
  const memory = String(prepared.messages.find(message => String(message.content).includes('Earlier completed conversation'))?.content);
  assert.match(memory, /local summary, untrusted/);
  assert.ok(memory.includes('src/سلام.ts') && memory.includes(hash));
  assert.match(memory, /"start_line":12/); assert.match(memory, /"page":4/); assert.match(memory, /"label":"iv"/);
  assert.ok(await inference.count(prepared) + 512 <= 8128);
  assert.ok(f.calls() > 0 && f.calls() <= 24);
  assert.ok(f.completed.every(body => !JSON.stringify(body.messages).includes('COMMAND_RESULT_EXACT') && !JSON.stringify(body.messages).includes('verify once')));
  assert.equal(f.restarts(), 0);
  assert.deepEqual(stages, ['Compacting completed conversation and read-only activity locally']);
});
function constrainedSummaryFixture(honorsAllowance = true) {
  const f = fixture();
  f.runtime.requestJson = async <T>(url: string, raw?: object) => {
    const body = raw as ChatBody;
    if (url.endsWith('input_tokens')) {
      f.counted.push(body);
      return { input_tokens: JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length } as T;
    }
    f.completed.push(body);
    const length = honorsAllowance ? Number(body.max_tokens) : 384;
    return { choices: [{ message: { content: 'Observed read fact. '.repeat(384).slice(0, length) } }] } as T;
  };
  const instructions = { role: 'system', content: 'TRUSTED_POLICY '.padEnd(3700, 'T') };
  const current = { role: 'user', content: 'Exact current task: inspect and verify once.' };
  const old = exchange('old-read', 'local_files_and_research__read_file', JSON.stringify({
    path: 'app.txt', sha256: 'a'.repeat(64), start_line: 12, text: 'OLD_READ_FACT '.repeat(150),
  }), '{"path":"app.txt","start_line":12}');
  const action = exchange('command', 'reviewed_actions__run_command', 'COMMAND_RESULT_EXACT '.padEnd(520, 'C'), '{"command":"verify once"}');
  const latest = exchange('latest-read', 'local_files_and_research__read_file', JSON.stringify({ path: 'app.txt', start_line: 20, text: 'CURRENT_FACT' }), '{"path":"app.txt","start_line":20}');
  const tools = [{ function: { name: 'reviewed_actions__run_command', parameters: { type: 'object' }, description: 'SCHEMA_EXACT '.padEnd(200, 'S') } }];
  const body: ChatBody = { messages: [instructions, current, ...old, ...action, ...latest], tools, max_tokens: 2048 };
  return { ...f, body, instructions, current, action, latest, tools };
}
test('compaction reduces generated facts to the complete request’s remaining native-counted space', async () => {
  const f = constrainedSummaryFixture();
  const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 8192, outputTokens: 2048 });
  const before = JSON.stringify(f.body), prepared = await inference.prepare(f.body);
  assert.ok(f.completed.length > 1, 'A 384-token summary below 30% of context still exceeds this complete request’s remaining space.');
  assert.equal(f.completed[0].max_tokens, 384);
  assert.ok(Number(f.completed.at(-1)!.max_tokens) < 384);
  assert.equal(prepared.max_tokens, 2048, 'Compaction must preserve the requested output reserve.');
  assert.ok(await inference.count(prepared) + 2048 <= 8128);
  assert.strictEqual(prepared.messages[0], f.instructions);
  assert.strictEqual(prepared.messages[1], f.current);
  assert.strictEqual(prepared.tools, f.tools);
  for (const message of [...f.action, ...f.latest]) assert.ok(prepared.messages.includes(message));
  const memory = String(prepared.messages.find(message => String(message.content).includes('Exact read references'))?.content);
  for (const source of ['old-read', 'app.txt', 'a'.repeat(64), '"start_line":12']) assert.ok(memory.includes(source));
  assert.ok(f.completed.every(body => !JSON.stringify(body.messages).includes('COMMAND_RESULT_EXACT') && !JSON.stringify(body.messages).includes('verify once')));
  assert.equal(JSON.stringify(f.body), before);
  assert.equal(f.restarts(), 0);
});
test('remaining-budget reductions stop after four attempts when generated facts cannot shrink', async () => {
  const f = constrainedSummaryFixture(false);
  const inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 8192, outputTokens: 2048 });
  const before = JSON.stringify(f.body);
  await assert.rejects(inference.prepare(f.body), /within four reductions.*shorter request or start a new task/);
  assert.equal(f.completed.length, 5, 'One initial summary and at most four budget reductions are allowed.');
  const allowances = f.completed.map(body => Number(body.max_tokens));
  assert.ok(allowances.slice(1).every((value, index) => value < allowances[index]));
  assert.ok(f.completed.every(body => !JSON.stringify(body.messages).includes('COMMAND_RESULT_EXACT') && !JSON.stringify(body.messages).includes('verify once')));
  assert.equal(JSON.stringify(f.body), before);
  assert.equal(f.restarts(), 0);
});
test('long completed older chat requests compact while current multipart request and instructions stay exact', async () => {
  const f = fixture(), inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  const system = { role: 'system', content: 'Trusted instructions' }, developer = { role: 'developer', content: 'Exact app policy' };
  const current = { role: 'user', content: [{ type: 'text', text: 'Current question must remain exactly this multipart content.' }] };
  const old = { role: 'user', content: 'A long closed older request. '.repeat(130) };
  const body: ChatBody = { messages: [system, developer, old, { role: 'assistant', content: 'The older task was answered.' }, current] };
  const before = JSON.stringify(body), prepared = await inference.prepare(body);
  assert.strictEqual(prepared.messages[0], system); assert.strictEqual(prepared.messages[1], developer);
  assert.strictEqual(prepared.messages.at(-1), current);
  assert.ok(!prepared.messages.includes(old));
  assert.match(String(prepared.messages[2].content), /Older requests in this summary are closed historical context/);
  assert.ok(await inference.count(prepared) + 100 <= 1936);
  assert.equal(JSON.stringify(body), before);
});
test('an older request with incomplete or orphan tool pairing stays exact despite a later assistant narration', () => {
  const older = { role: 'user', content: 'Previous request with unresolved action' };
  const pending = { role: 'assistant', tool_calls: [{ id: 'pending', function: { name: 'reviewed_actions__run_command', arguments: '{"command":"once"}' } }] };
  const current = { role: 'user', content: 'Current task' };
  for (const unsettled of [[pending], [{ role: 'tool', tool_call_id: 'orphan', content: 'Unknown result' }]]) {
    const messages = [older, ...unsettled, { role: 'assistant', content: 'Narration does not prove tools completed' }, current];
    const partition = compactionPartition(messages);
    assert.ok(partition.retained.includes(older) && partition.retained.includes(current));
    for (const message of unsettled) assert.ok(partition.retained.includes(message));
    assert.ok(!partition.older.includes(older));
  }
});
test('oversized immutable actions fail safely even after reads are compacted', async () => {
  const f = fixture(), inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  const command = exchange('command', 'reviewed_actions__run_command', 'DO_NOT_LOSE_ACTION '.repeat(140), '{"command":"never replay me"}');
  const body: ChatBody = { messages: [{ role: 'user', content: 'Exact task' }, ...exchange('read', 'local_files_and_research__read_file', 'read evidence '.repeat(100)), ...command] };
  const before = JSON.stringify(body);
  await assert.rejects(inference.prepare(body), /Required context still does not fit.*source references, and action history.*shorter request or start a new task/);
  assert.equal(JSON.stringify(body), before);
  assert.equal(f.calls(), 0, 'Immutable request overflow is detected before spending inference on summaries.');
  assert.ok(f.completed.every(summary => !JSON.stringify(summary.messages).includes('DO_NOT_LOSE_ACTION') && !JSON.stringify(summary.messages).includes('never replay me')));
  assert.equal(f.restarts(), 0);
});
test('completed list/search/log reads preserve exact file, line, hash and continuation references outside the generated summary', async () => {
  const f = fixture(), inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 6000, outputTokens: 100 });
  const reads = [
    ...exchange('listing', 'local_files_and_research__list_files', JSON.stringify({ files: ['/project/one.ts', '/project/two.ts'], text: 'x'.repeat(2500) })),
    ...exchange('search', 'local_files_and_research__search_files', JSON.stringify({ matches: [{ path: '/project/one.ts', line: 72, sha256: 'b'.repeat(64), text: 'y'.repeat(2500) }] })),
    ...exchange('log', 'reviewed_actions__read_command_output', JSON.stringify({ id: 'saved-log', offset: 200, nextOffset: 400, text: 'z'.repeat(2500) })),
  ];
  const latest = exchange('pending-action', 'reviewed_actions__write_file', 'Exact latest action result');
  const prepared = await inference.prepare({ messages: [{ role: 'user', content: 'Current request' }, ...reads, ...latest] });
  const memory = String(prepared.messages.find(message => String(message.content).includes('Exact read references'))?.content);
  for (const reference of ['/project/one.ts', '/project/two.ts', '"line":72', 'b'.repeat(64), '"nextOffset":400', '"offset":200']) assert.ok(memory.includes(reference), reference);
  assert.ok(prepared.messages.includes(latest[0]) && prepared.messages.includes(latest[1]));
});
test('read compaction work is bounded and oversized source-reference listings stay exact', async () => {
  const f = fixture(), inference = new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 });
  const latest = exchange('latest', 'reviewed_actions__read_command_output', 'Saved command log excerpt');
  await assert.rejects(inference.prepare({ messages: [{ role: 'user', content: 'Task' }, ...exchange('huge', 'local_files_and_research__read_file', 'x'.repeat(100_000)), ...latest] }), /Too much completed read activity/);
  assert.equal(f.calls(), 24, 'A single overflow must not perform unbounded local summary requests.');
  const listing = exchange('listing', 'local_files_and_research__search_files', JSON.stringify({ matches: Array.from({ length: 129 }, (_, line) => ({ path: `file-${line}.txt`, line, text: 'Evidence' })) }));
  const partition = compactionPartition([{ role: 'user', content: 'Task' }, ...listing, ...latest]);
  assert.deepEqual(partition.older, []);
  assert.deepEqual(partition.retained.slice(1), [...listing, ...latest]);
});
test('gateway rejects browser origins and missing tokens and preserves authenticated local reasoning and answer fields', async () => {
  const f = fixture(), controller = new AbortController();
  const stream = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Local model thought — سلام 🌍' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Verified answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  f.runtime.requestStream = async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  const gateway = await createInferenceGateway(new BudgetedInference(f.runtime, { model: 'owned', contextTokens: 2000, outputTokens: 100 }), controller.signal);
  try {
    assert.equal((await fetch(`${gateway.baseUrl}/v1/models`)).status, 403);
    assert.equal((await fetch(`${gateway.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${gateway.apiKey}`, Origin: 'https://example.org' } })).status, 403);
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Hello' }] }) });
    assert.equal(response.status, 200); assert.equal(await response.text(), stream);
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
  assert.equal(state.version, 3); assert.deepEqual(state.sessions, [session]); assert.equal(state.utilities.webResearch, false); assert.equal(state.plugins.taskResearch, false); assert.ok(!('executablePath' in state));
  assert.equal(effectiveUtilities('assistant', DEFAULT_UTILITIES).terminal, false);
  assert.throws(() => migrateState({ ...state, version: 999 }));
});
