import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyToolHistory, finishToolHistory, MAX_TOOL_ACTIVITIES, MAX_TOOL_DETAIL_BYTES, restoreToolHistory, updateToolHistory } from '../tool-history.ts';
import { emptyState, migrateState } from '../state.ts';
import { workingDetailsIndexes } from '../renderer/conversation-flow.ts';

test('tool updates preserve the named call and input while replacing status and result', () => {
  const input = { command: 'docker compose config --quiet', timeout_ms: 300000 };
  const started = updateToolHistory(emptyToolHistory(), { id: 'command', title: 'Review project configuration', status: 'pending', input });
  const running = updateToolHistory(started, { id: 'command', title: 'Tool', status: 'in_progress' });
  const completed = updateToolHistory(running, { id: 'command', title: 'Tool', status: 'completed', output: { exitCode: 0 } });
  assert.deepEqual(completed.tools, [{ id: 'command', title: 'Review project configuration', status: 'completed', input, output: { exitCode: 0 } }]);
  assert.equal(started.tools[0].status, 'pending', 'Updating display records cannot mutate earlier snapshots.');
});

test('finishing a stopped turn records unfinished tools without changing completed or denied actions', () => {
  const history = restoreToolHistory([
    { id: 'completed-command', title: 'Run checks', status: 'completed', output: 'Saved command log: uuid' },
    { id: 'denied-edit', title: 'Edit file', status: 'failed', output: { denied: true } },
    { id: 'pending-command', title: 'Run command', status: 'pending' },
    { id: 'running-read', title: 'Read file', status: 'in_progress' },
  ]);
  assert.deepEqual(finishToolHistory(history).tools.map(tool => tool.status), ['completed', 'failed', 'interrupted', 'interrupted']);
  assert.equal(history.tools[2].status, 'pending');
});

test('Working retains bounded UTF-8 tool details with a visible truncation notice', () => {
  const large = 'سلام 🌍'.repeat(MAX_TOOL_DETAIL_BYTES);
  const history = restoreToolHistory([{ id: 'large-read', title: 'Read text', status: 'completed', input: { content: large }, output: large }]);
  for (const detail of [history.tools[0].input, history.tools[0].output]) {
    assert.equal(typeof detail, 'string');
    assert.ok(new TextEncoder().encode(detail as string).length <= MAX_TOOL_DETAIL_BYTES);
    assert.match(detail as string, /\[Working details truncated at 16 KiB\.\]$/);
    assert.ok(!(detail as string).includes('\ufffd'));
  }
  assert.deepEqual(restoreToolHistory(history.tools), history, 'Loading bounded records does not truncate them again.');
});

test('the activity budget keeps updates to retained calls and records overflow explicitly', () => {
  let history = emptyToolHistory();
  for (let index = 0; index <= MAX_TOOL_ACTIVITIES; index++) {
    history = updateToolHistory(history, { id: `read-${index}`, title: 'Read text', status: 'pending' });
  }
  assert.equal(history.tools.length, MAX_TOOL_ACTIVITIES);
  assert.equal(history.truncated, true);
  history = updateToolHistory(history, { id: 'read-0', title: 'Tool', status: 'completed', output: 'Read finished' });
  assert.equal(history.tools[0].status, 'completed');
  assert.equal(history.tools[0].title, 'Read text');
  assert.equal(history.truncated, true);
});

test('completed and tool-only interrupted Working details survive saving, reopening and a later user turn', () => {
  const history = finishToolHistory(restoreToolHistory([
    { id: 'read', title: 'Read workspace', status: 'completed', input: { path: '.' }, output: 'README.md' },
    { id: 'command', title: 'Run project checks', status: 'pending', input: { command: 'npm test' } },
  ]));
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Task', updatedAt: '2026-10-11T00:00:00Z', mode: 'coding' as const, files: [],
    messages: [
      { role: 'user' as const, content: 'Inspect my project' },
      { role: 'assistant' as const, content: '', tools: history.tools },
      { role: 'user' as const, content: 'Now explain what you found' },
      { role: 'assistant' as const, content: 'Your workspace contains README.md.' },
    ] };
  const loaded = migrateState(JSON.parse(JSON.stringify({ ...emptyState(), sessions: [session] }))).sessions[0];
  assert.deepEqual(loaded.messages, session.messages);
  assert.equal(workingDetailsIndexes(loaded.messages, false, false).has(1), true);
  assert.equal(workingDetailsIndexes(loaded.messages, false, false).has(3), false);
  assert.deepEqual(workingDetailsIndexes(loaded.messages, true, true), new Set([1, 3]));
});

test('migration bounds oversized tool history and strips model activity from user messages', () => {
  const tools = Array.from({ length: MAX_TOOL_ACTIVITIES + 1 }, (_, index) => ({ id: `tool-${index}`, title: 'Read file', status: 'completed', output: 'x'.repeat(MAX_TOOL_DETAIL_BYTES * 2) }));
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Task', updatedAt: '2026-10-11T00:00:00Z', mode: 'coding', files: [],
    messages: [{ role: 'user', content: 'Keep my text', tools, toolsTruncated: true }, { role: 'assistant', content: 'Kept answer', tools }] };
  const messages = migrateState({ ...emptyState(), sessions: [session] }).sessions[0].messages;
  assert.deepEqual(messages[0], { role: 'user', content: 'Keep my text' });
  assert.equal(messages[1].content, 'Kept answer');
  assert.equal(messages[1].tools?.length, MAX_TOOL_ACTIVITIES);
  assert.equal(messages[1].toolsTruncated, true);
});
