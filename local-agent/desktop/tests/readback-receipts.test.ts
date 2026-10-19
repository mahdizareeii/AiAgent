/** Offline readback evidence tests using authenticated local loopback servers. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadbackReceiptScope, ReadbackStreamCompletion, exactReadbackReport,
  normalizedReadArguments, normalJsonCompletion, strictReadbackJson,
  MAX_READBACK_REPORT_BYTES, type DeliveredReadback } from '../readback-receipts.ts';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const defaults = (file = 'note.txt') => ({ path: file, start_line: 1, max_lines: 200,
  cursor: null, expected_sha256: null, max_chars: null });

async function fixture(t: TestContext, content = 'Local agents finish tasks.\n', turnId = 'turn-1') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'readback-receipt-')));
  const controller = new AbortController(); let revision = 0, inFlight = false;
  let scope: ReadbackReceiptScope | undefined;
  t.after(async () => { await scope?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'note.txt'), Buffer.from(content, 'utf8'));
  scope = await ReadbackReceiptScope.create({ turnId, requestHash: 'a'.repeat(64), workspacePath: root,
    signal: controller.signal, targets: [{ id: 'read-note', path: 'note.txt', exactCriterionId: 'exact-note', content, report: 'exact_utf8' }],
    currentRevision: () => revision, effectInFlight: () => inFlight });
  const url = await scope.start();
  const native = async (): Promise<Record<string, any>> => {
    const bytes = await readFile(path.join(root, 'note.txt'));
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const newlines = [...text].filter(character => character === '\n').length;
    return { ok: true, path: path.join(root, 'note.txt'), size: bytes.length, sha256: sha(text),
      total_lines: newlines + Number(Boolean(text) && !text.endsWith('\n')),
      start_line: 1, start_column: 1, end_line: newlines + 1,
      end_column: text.endsWith('\n') ? 1 : [...text.split('\n').at(-1)!].length + 1,
      start_byte: 0, end_byte: bytes.length, encoding: 'utf-8', text, eof: true, next_cursor: null, truncated: false };
  };
  return { root, scope, controller, url, native, bump: () => { revision++; }, setInFlight: (value: boolean) => { inFlight = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function post(url: string, value: unknown, options: { raw?: string; origin?: string; method?: string } = {}): Promise<{ status: number; body: any }> {
  const raw = options.raw ?? JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'POST', headers: { 'Content-Type': 'application/json',
      ...(options.origin !== undefined ? { Origin: options.origin } : {}) } }, response => {
      const parts: Buffer[] = []; let size = 0;
      response.on('data', (part: Buffer) => { size += part.length; if (size > 16 * 1024) response.destroy(new Error('Oversized fixture response.')); else parts.push(part); });
      response.on('error', reject);
      response.on('end', () => {
        try { const text = Buffer.concat(parts).toString('utf8'); resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('Receipt fixture timed out.'))); req.end(raw);
  });
}

async function begin(f: Fixture, args: Record<string, unknown> = { path: 'note.txt' }): Promise<string> {
  const result = await post(f.url, { schemaVersion: 1, phase: 'begin', arguments: args });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.match(result.body.token, HEX);
  return result.body.token;
}

async function minted(f: Fixture, args: Record<string, unknown> = { path: 'note.txt' }) {
  const token = await begin(f, args);
  const native = await f.native(); // A real temporary-file read occurs AFTER begin.
  const result = await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: native });
  assert.equal(result.body.ok, true); assert.match(result.body.nonce, HEX);
  return { native, args, nonce: result.body.nonce as string };
}
type Mint = Awaited<ReturnType<typeof minted>>;

function forwarded(mint: Mint, callId = 'native-read-1'): any[] {
  return [{ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: {
    name: 'local_files_and_research__read_file', arguments: JSON.stringify(mint.args) } }] },
  { role: 'tool', tool_call_id: callId, content: JSON.stringify({ ...mint.native,
    readback_receipt: { schemaVersion: 1, nonce: mint.nonce } }) }];
}

test('real UTF8 read mint and exact final tool payload require successful delivery before a record exists', async t => {
  const f = await fixture(t), mint = await minted(f);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  const ticket = f.scope.reserveDelivery(forwarded(mint));
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  f.scope.settleDelivery({}, true); // An object shaped like a ticket grants nothing.
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  f.scope.settleDelivery(ticket, true);
  const read = f.scope.deliveredFor('read-note'); assert.ok(read);
  assert.deepEqual(read, { criterionId: 'read-note', exactCriterionId: 'exact-note', path: path.join(f.root, 'note.txt'),
    text: mint.native.text, sha256: mint.native.sha256, size: mint.native.size, nonce: mint.nonce, providerCallId: 'native-read-1', revision: 0 });
  assert.equal(Object.isFrozen(read), true);
  assert.equal('token' in read, false);
});

test('closed Python-compatible defaults preserve literal paths and reject ambiguous arguments', () => {
  assert.deepEqual(normalizedReadArguments({ path: 'note.txt' }), defaults());
  const input = { path: './nested/عنوان.txt', start_line: 2, max_lines: 7, cursor: 'cursor', expected_sha256: 'd'.repeat(64), max_chars: 500 };
  assert.deepEqual(normalizedReadArguments(input), input);
  for (const value of [{ path: 'note.txt', check_id: 'read-note' }, { path: 'note.txt', start_line: true },
    { path: 'note.txt', max_lines: 501 }, { path: 'note.txt', max_chars: 499 }, { path: 'note.txt', cursor: 1 },
    { path: 'note.txt', expected_sha256: 'short' }, { path: '\ud800' }]) assert.equal(normalizedReadArguments(value), undefined);
});

test('pre-read token cannot be re-dated across mutation and change-and-revert', async t => {
  const f = await fixture(t), token = await begin(f), oldRead = await f.native();
  f.bump(); await writeFile(path.join(f.root, 'note.txt'), 'temporary change');
  f.bump(); await writeFile(path.join(f.root, 'note.txt'), oldRead.text);
  const rejected = await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: oldRead });
  assert.notEqual(rejected.body.ok, true);
  const replay = await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: await f.native() });
  assert.notEqual(replay.body.ok, true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
});

test('an effect in flight prevents begin, finish and successful settlement', async t => {
  const f = await fixture(t); f.setInFlight(true);
  assert.notEqual((await post(f.url, { schemaVersion: 1, phase: 'begin', arguments: { path: 'note.txt' } })).body.ok, true);
  f.setInFlight(false); const token = await begin(f); f.setInFlight(true);
  assert.notEqual((await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: await f.native() })).body.ok, true);
  f.setInFlight(false); const mint = await minted(f); const ticket = f.scope.reserveDelivery(forwarded(mint));
  f.setInFlight(true); f.scope.settleDelivery(ticket, true); f.setInFlight(false);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(mint)), true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
});

test('native finalize requires all full-file ranges, original SHA, UTF8 text and exact target fields', async t => {
  const f = await fixture(t);
  const changes: [string, (value: Record<string, any>) => void][] = [
    ['first-partial', value => { value.end_byte--; }], ['last-partial', value => { value.start_byte = 1; }],
    ['not-eof', value => { value.eof = false; }], ['truncated', value => { value.truncated = true; }],
    ['cursor', value => { value.next_cursor = 'next'; }], ['encoding', value => { value.encoding = 'utf-16'; }],
    ['size', value => { value.size++; }], ['hash', value => { value.sha256 = 'd'.repeat(64); }],
    ['path', value => { value.path = path.join(f.root, 'other.txt'); }], ['wrong-text', value => { value.text = 'different'; }],
    ['extra', value => { value.trusted = true; }], ['missing-total-lines', value => { delete value.total_lines; }],
    ['boolean-size', value => { value.size = true; }], ['surrogate', value => { value.text = '\ud800'; }],
    ['failed', value => { value.ok = false; }], ['line-start', value => { value.start_line = 2; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const token = await begin(f), native = await f.native(); change(native);
    assert.notEqual((await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: native })).body.ok, true);
    assert.notEqual((await post(f.url, { schemaVersion: 1, phase: 'finish', token, result: await f.native() })).body.ok, true, 'Rejected finalize spends its begin token.');
  });
  for (const args of [{ path: 'other.txt' }, { path: '../note.txt' }, { path: 'note.txt', cursor: 'opaque' },
    { path: 'note.txt', start_line: 2 }, { path: 'note.txt', extra: true }]) {
    assert.notEqual((await post(f.url, { schemaVersion: 1, phase: 'begin', arguments: args })).body.ok, true);
  }
});

test('delivery rejects wrong inputs, output, namespace, nonce, prose, pair order and duplicate call/result identities', async t => {
  const f = await fixture(t);
  const changes: [string, (messages: any[], mint: Mint) => any[]][] = [
    ['wrong-arguments', messages => { messages[0].tool_calls[0].function.arguments = JSON.stringify({ path: 'note.txt', max_lines: 1 }); return messages; }],
    ['wrong-namespace', messages => { messages[0].tool_calls[0].function.name = 'pretend_read_file'; return messages; }],
    ['wrong-call-id', messages => { messages[1].tool_call_id = 'other-call'; return messages; }],
    ['result-first', messages => messages.reverse()],
    ['source-prose', messages => { messages[1].role = 'user'; return messages; }],
    ['embedded-json', messages => { messages[1].content = 'File contents: ' + messages[1].content; return messages; }],
    ['truncated-result', messages => { messages[1].content = messages[1].content.slice(0, -20); return messages; }],
    ['wrong-output', messages => { const value = JSON.parse(messages[1].content); value.text += 'x'; messages[1].content = JSON.stringify(value); return messages; }],
    ['wrong-nonce', messages => { const value = JSON.parse(messages[1].content); value.readback_receipt.nonce = 'd'.repeat(64); messages[1].content = JSON.stringify(value); return messages; }],
    ['only-receipt', messages => { const value = JSON.parse(messages[1].content); messages[1].content = JSON.stringify({ readback_receipt: value.readback_receipt }); return messages; }],
    ['duplicate-call', messages => { messages[0].tool_calls.push(structuredClone(messages[0].tool_calls[0])); return messages; }],
    ['duplicate-result', messages => [...messages, structuredClone(messages[1])]],
    ['nonce-two-call-ids', (messages, mint) => [...messages, ...forwarded(mint, 'native-read-2')]],
    ['duplicate-json-key', messages => { messages[1].content = messages[1].content.replace('"ok":true', '"ok":false,"ok":true'); return messages; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const mint = await minted(f); f.scope.settleDelivery(f.scope.reserveDelivery(change(forwarded(mint), mint)), true);
    assert.equal(f.scope.deliveredFor('read-note'), undefined);
    f.scope.invalidate();
  });
});

test('failed inference spends delivery attempt while committed history cannot refresh its revision', async t => {
  const f = await fixture(t), failed = await minted(f);
  f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(failed)), false);
  f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(failed)), true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  const good = await minted(f); const messages = forwarded(good);
  f.scope.settleDelivery(f.scope.reserveDelivery(messages), true);
  const committed = f.scope.deliveredFor('read-note'); assert.ok(committed);
  f.scope.settleDelivery(f.scope.reserveDelivery(messages), true);
  assert.deepEqual(f.scope.deliveredFor('read-note'), committed);
  f.bump(); f.scope.settleDelivery(f.scope.reserveDelivery(messages), true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
});

test('explicit invalidation cannot resurrect a previously reserved delivery ticket', async t => {
  const f = await fixture(t), mint = await minted(f), ticket = f.scope.reserveDelivery(forwarded(mint));
  f.scope.invalidate(); f.scope.settleDelivery(ticket, true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
  f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(mint)), true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
});

test('bounded-store eviction cannot deliver a detached reserved record later', { timeout: 15000 }, async t => {
  const f = await fixture(t), first = await minted(f), ticket = f.scope.reserveDelivery(forwarded(first));
  for (let i = 0; i < 128; i++) await minted(f);
  f.scope.settleDelivery(ticket, true);
  assert.equal(f.scope.deliveredFor('read-note'), undefined);
});

test('a foreign scope, closed original signal, or fresh caller cannot reuse an old proof', async t => {
  const first = await fixture(t), second = await fixture(t, 'Local agents finish tasks.\n', 'turn-2');
  const mint = await minted(first), ticket = first.scope.reserveDelivery(forwarded(mint));
  second.scope.settleDelivery(ticket, true);
  second.scope.settleDelivery(second.scope.reserveDelivery(forwarded(mint)), true);
  assert.equal(second.scope.deliveredFor('read-note'), undefined);
  first.controller.abort(); first.scope.settleDelivery(ticket, true);
  assert.equal(first.scope.deliveredFor('read-note'), undefined);
  assert.equal(first.scope.url, undefined);
  const unrelated = new AbortController(); assert.equal(unrelated.signal.aborted, false);
  first.scope.settleDelivery(first.scope.reserveDelivery(forwarded(mint)), true);
  assert.equal(first.scope.deliveredFor('read-note'), undefined);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(ReadbackReceiptScope.create({ turnId: 'new', requestHash: 'a'.repeat(64), workspacePath: first.root,
    signal: aborted.signal, targets: [], currentRevision: () => 0, effectInFlight: () => false }));
});

test('private endpoint rejects wrong secret, Origin, method, oversized and duplicate-key requests', async t => {
  const f = await fixture(t), valid = { schemaVersion: 1, phase: 'begin', arguments: { path: 'note.txt' } };
  const wrong = f.url.replace(/[a-f0-9]{64}$/, 'd'.repeat(64));
  assert.equal((await post(wrong, valid)).status, 403);
  assert.equal((await post(f.url, valid, { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await post(f.url, valid, { method: 'GET' })).status, 403);
  const oversized = await post(f.url, valid, { raw: ' '.repeat(64 * 1024 + 1) }).catch(() => undefined);
  assert.notEqual(oversized?.body?.ok, true);
  const duplicate = await post(f.url, valid, { raw: '{"schemaVersion":1,"phase":"ignored","phase":"begin","arguments":{"path":"note.txt"}}' });
  assert.notEqual(duplicate.body?.ok, true);
  for (const value of [{ ...valid, extra: true }, { ...valid, schemaVersion: '1' }, { ...valid, phase: 'unknown' }]) {
    assert.notEqual((await post(f.url, value)).body.ok, true);
  }
});

test('strict JSON rejects decoded duplicate keys, nesting, trailing data and nonfinite numbers', () => {
  assert.equal((strictReadbackJson('{"a":1}') as any).a, 1);
  for (const input of ['{"a":1,"a":2}', String.raw`{"phase":1,"\u0070hase":2}`, '{"x":1e999}',
    '{"x":NaN}', '{} trailing', '['.repeat(34) + '0' + ']'.repeat(34), ' '.repeat(64 * 1024 + 1)]) {
    assert.throws(() => strictReadbackJson(input));
  }
});

function streamResult(text: string, oneByte = false): boolean {
  const stream = new ReadbackStreamCompletion(), bytes = Buffer.from(text, 'utf8');
  if (oneByte) for (const value of bytes) stream.push(Uint8Array.of(value)); else stream.push(bytes);
  return stream.finish();
}
const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const terminal = (reason = 'stop') => event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

test('complete JSON and split UTF8 SSE completion are distinct from headers or partial responses', () => {
  for (const reason of ['stop', 'tool_calls', 'function_call']) {
    assert.equal(normalJsonCompletion({ choices: [{ message: {}, finish_reason: reason }] }), true);
    assert.equal(streamResult(event({ choices: [{ index: 0, delta: { content: 'سلام 🌍' }, finish_reason: null }] }) + terminal(reason) + 'data: [DONE]\n\n', true), true);
  }
  for (const value of [{ choices: [] }, { choices: [{ message: {}, finish_reason: 'length' }] },
    { choices: [{ message: {}, finish_reason: 'stop' }], error: { message: 'failed' } },
    { choices: [{ message: {}, finish_reason: 'stop' }, { message: {}, finish_reason: 'stop' }] },
    { choices: [{ message: null, finish_reason: 'stop' }] }]) assert.equal(normalJsonCompletion(value), false);
});

test('length, missing DONE, duplicate/foreign choices, malformed data and failed streams do not commit', async t => {
  const malformed = [terminal(), 'data: [DONE]\n\n', terminal('length') + 'data: [DONE]\n\n',
    terminal() + event({ error: { message: 'failed' } }) + 'data: [DONE]\n\n',
    event({ choices: [{ index: 1, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
    event({ choices: [{ index: 0, finish_reason: 'stop' }, { index: 1, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
    terminal() + terminal() + 'data: [DONE]\n\n', terminal() + 'data: [DONE]\n\ndata: [DONE]\n\n',
    'data: {"choices":[],"choices":[{"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    terminal() + 'data: [DONE]\n\ntrailing fragment', 'data: ' + 'x'.repeat(64 * 1024 + 1)];
  const f = await fixture(t);
  for (const text of malformed) {
    const mint = await minted(f), normal = streamResult(text);
    assert.equal(normal, false); f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(mint)), normal);
    assert.equal(f.scope.deliveredFor('read-note'), undefined);
  }
  const invalidUtf8 = new ReadbackStreamCompletion(); invalidUtf8.push(Uint8Array.of(0xff));
  assert.equal(invalidUtf8.finish(), false);
});

test('BOM, Unicode, CRLF and final LF survive native mint, delivery and literal fenced JSON report', async t => {
  const text = '\ufeffعنوان: سلام 🌍\r\n[x](https://example.invalid/) `data` ~~~~~\r\nFinal LF\n';
  const f = await fixture(t, text), mint = await minted(f);
  f.scope.settleDelivery(f.scope.reserveDelivery(forwarded(mint)), true);
  const delivered = f.scope.deliveredFor('read-note'); assert.ok(delivered);
  assert.equal(delivered.text, text); assert.equal(delivered.size, Buffer.byteLength(text, 'utf8'));
  const report = exactReadbackReport([delivered]), lines = report.split('\n');
  const opening = lines.findIndex(line => /^~{3,}json$/.test(line)); assert.ok(opening >= 0);
  const fence = lines[opening].slice(0, -4); assert.equal(lines.at(-1), fence); assert.ok(fence.length > 5);
  const records = JSON.parse(lines.slice(opening + 1, -1).join('\n'));
  assert.deepEqual(records, [{ path: path.join(f.root, 'note.txt'), encoding: 'utf-8', size: delivered.size,
    sha256: delivered.sha256, content: text }]);
  assert.ok(Buffer.byteLength(report, 'utf8') <= MAX_READBACK_REPORT_BYTES);
});

test('exact reporting rejects empty or over-cap representations instead of truncating content', () => {
  const record: DeliveredReadback = { criterionId: 'read', exactCriterionId: 'exact', path: '/workspace/note.txt',
    text: 'x', sha256: sha('x'), size: 1, nonce: 'a'.repeat(64), providerCallId: 'call', revision: 0 };
  assert.throws(() => exactReadbackReport([]));
  const text = '\u0001'.repeat(2048);
  assert.throws(() => exactReadbackReport([{ ...record, text, size: Buffer.byteLength(text), sha256: sha(text) }]), /bound|truncat/i);
  assert.equal(record.text, 'x');
});


test('a finish frame permits usage-only evidence but rejects later choice deltas or SSE error events', () => {
  const usage = event({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  assert.equal(streamResult(terminal() + usage + 'data: [DONE]\n\n'), true);
  for (const after of [event({ choices: [{ index: 0, delta: { content: 'late text' }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
    'event: error\n\n', 'event: error\ndata: {"choices":[]}\n\n']) {
    assert.equal(streamResult(terminal() + after + 'data: [DONE]\n\n'), false);
  }
  assert.equal(streamResult('event:error\n\n' + terminal() + 'data: [DONE]\n\n'), false);
});
