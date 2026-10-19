import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanonicalTranscript, StreamCompletionCapture, validateTranscript, type TranscriptMessage } from '../transcript.ts';

const call: TranscriptMessage = { role: 'assistant', content: null, reasoning_content: 'Read exact facts — سلام 🌍',
  tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'local_files_and_research__read_file', arguments: '{"path":"notes.txt"}' } }] };
const result: TranscriptMessage = { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: '{"ok":true,"text":"exact result"}' }] };

test('seeded canonical exchanges preserve reasoning, arguments, call IDs and results across user turns', () => {
  const seed: TranscriptMessage[] = [{ role: 'system', content: 'Previous provider instructions' }, { role: 'user', content: 'First task' }, call, result,
    { role: 'assistant', content: 'First final', reasoning_content: 'Earlier final thinking' }];
  const transcript = new CanonicalTranscript(seed);
  const request = transcript.observeRequest([{ role: 'system', content: 'Current provider instructions' }, { role: 'user', content: 'Second task' }]);
  assert.deepEqual(request, [{ role: 'system', content: 'Current provider instructions' }, ...seed.slice(1), { role: 'user', content: 'Second task' }]);
  transcript.recordCompletion(request, { role: 'assistant', content: 'Second final', reasoning_content: 'Second reasoning' });
  assert.deepEqual(transcript.snapshot.at(-1), { role: 'assistant', content: 'Second final', reasoning_content: 'Second reasoning' });
  request[2].reasoning_content = 'Modified outside';
  assert.equal(transcript.snapshot[2].reasoning_content, call.reasoning_content);
});

test('gateway capture restores a provider omitted reasoning envelope without duplicating seed history', () => {
  const transcript = new CanonicalTranscript([{ role: 'user', content: 'Old task' }, { role: 'assistant', content: 'Old answer' }]);
  const first = transcript.observeRequest([{ role: 'user', content: 'Current task' }]);
  transcript.recordCompletion(first, call);
  const dropped = { ...call, content: '', reasoning_content: undefined,
    tool_calls: [{ ...call.tool_calls![0], function: { ...call.tool_calls![0].function, arguments: { path: 'notes.txt' } } }] };
  delete dropped.reasoning_content;
  const next = transcript.observeRequest([{ role: 'user', content: 'Current task' }, dropped, result]);
  assert.deepEqual(next.slice(-2), [call, result]);
  transcript.recordCompletion(next, { content: 'Done', reasoning: 'Preserved final' });
  assert.equal(transcript.snapshot.filter(message => message.content === 'Old task').length, 1);
  assert.equal(transcript.incomplete, false);
});

test('unfinished tool groups are retained in live requests but excluded from future seeds', () => {
  const transcript = new CanonicalTranscript();
  const request = transcript.observeRequest([{ role: 'user', content: 'Action that was cancelled' }]);
  transcript.recordCompletion(request, call);
  assert.equal(transcript.incomplete, true);
  assert.deepEqual(transcript.snapshot, request);
  assert.deepEqual(transcript.observeRequest([...request, call]).at(-1), call);
  transcript.recordClosing({ content: 'Stopped after the cancelled action.', reasoning_content: 'Recorded closure reasoning' });
  assert.equal(transcript.incomplete, true, 'A final response cannot erase the incomplete exchange marker.');
  assert.deepEqual(transcript.snapshot, [...request, { role: 'assistant', content: 'Stopped after the cancelled action.', reasoning_content: 'Recorded closure reasoning' }]);
});

test('disk validation is bounded, rejects malformed envelopes and never accepts UI display thoughts', () => {
  assert.deepEqual(validateTranscript([call, result]), [call, result]);
  assert.equal(validateTranscript([{ role: 'assistant', thinking: 'display only', content: 'text' }]), undefined);
  assert.equal(validateTranscript([{ role: 'tool', content: 'orphan' }]), undefined);
  assert.equal(validateTranscript([{ ...call, tool_calls: [{ id: '', function: { name: 'read', arguments: '{}' } }] }]), undefined);
  assert.equal(validateTranscript([{ ...call, tool_calls: [call.tool_calls![0], call.tool_calls![0]] }]), undefined);
  for (const argumentsValue of ['{"path":', '[]', 'null', '"text"']) {
    assert.equal(validateTranscript([{ ...call, tool_calls: [{ ...call.tool_calls![0], function: { name: 'read', arguments: argumentsValue } }] }]), undefined);
  }
  assert.equal(validateTranscript(Array.from({ length: 513 }, () => ({ role: 'user', content: 'a' }))), undefined);
  assert.equal(validateTranscript([{ role: 'user', content: 'a'.repeat(8 * 1024 * 1024) }]), undefined);
});

test('completed fragmented SSE retains UTF-8 reasoning and structured tool calls exactly once', () => {
  const captured: TranscriptMessage[] = [], stream = new StreamCompletionCapture(message => captured.push(message));
  const frames = [{ reasoning_content: 'Read exact facts — سلام 🌍' },
    { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'local_files_and_research__read_file', arguments: '{"path":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] }];
  const text = frames.map(delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\r\n\r\n`).join('') +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length; index += 3) stream.push(bytes.subarray(index, index + 3));
  stream.finish();
  assert.deepEqual(captured, [call]);
});

test('interrupted streaming generations fail at EOF and cannot become canonical completed responses', () => {
  const captured: TranscriptMessage[] = [], stream = new StreamCompletionCapture(message => captured.push(message));
  stream.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial', reasoning: 'partial thought' }, finish_reason: null }] })}\n\n`));
  assert.throws(() => stream.finish(), /ended before its response completed/);
  assert.deepEqual(captured, []);
});

test('length terminated or malformed tool responses never become completed canonical calls', () => {
  const captured: TranscriptMessage[] = [];
  for (const [argumentsValue, finishReason] of [['{}', 'length'], ['{"path":', 'tool_calls']]) {
    const stream = new StreamCompletionCapture(message => captured.push(message));
    assert.throws(() => stream.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {
      tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: argumentsValue } }],
    }, finish_reason: finishReason }] })}\n\n`)), /did not complete its tool calls|invalid completed tool envelope/);
  }
  assert.deepEqual(captured, []);
  const transcript = new CanonicalTranscript(), request = transcript.observeRequest([{ role: 'user', content: 'Read once' }]);
  assert.throws(() => transcript.recordCompletion(request, call, 'length'), /did not complete its tool calls/);
  assert.deepEqual(transcript.snapshot, request);
  assert.throws(() => transcript.recordClosing(call), /reserved final response/);
  assert.deepEqual(new CanonicalTranscript([request[0], result]).snapshot, request, 'An orphan result cannot enter a future seed.');
});
