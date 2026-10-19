import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import { loopbackOnlyFetch, selectHarnessInferenceFetch } from '../../../scripts/validate-local-coding.ts';

async function localhost(t: TestContext, handle: RequestListener): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('updated harness uses production delayed-header/body transport while snapshot retains its original global wrapper', async t => {
  const original = globalThis.fetch; let globalCalls = 0;
  globalThis.fetch = async (input, init) => {
    globalCalls++;
    assert.equal(String(input), 'http://[::1]:12345/baseline');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    return new Response('{"baseline":true}', { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  let requests = 0, submitted = '';
  const url = await localhost(t, (request, response) => {
    requests++; assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, 'Bearer fixture-only');
    request.on('data', chunk => { submitted += chunk.toString(); });
    request.on('end', () => { setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"answer":');
      setTimeout(() => response.end('42}'), 70);
    }, 70); });
  });
  const updated = selectHarnessInferenceFetch({});
  const response = await updated(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-only' }, body: '{"stream":false}', signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await response.json(), { answer: 42 }); assert.equal(requests, 1); assert.equal(submitted, '{"stream":false}');
  assert.equal(globalCalls, 0, 'updated inference cannot reintroduce Undici header limits through global fetch');
  const baseline = selectHarnessInferenceFetch({ sourceSnapshot: '/preserved/source' });
  assert.equal(baseline, loopbackOnlyFetch, 'historical comparison keeps the original wrapper exactly');
  assert.deepEqual(await (await baseline('http://[::1]:12345/baseline', { redirect: 'follow', credentials: 'include' })).json(), { baseline: true });
  assert.equal(globalCalls, 1);
});

test('updated harness obeys reviewed cancellation before headers and during a stalled body', async t => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('global fetch must not handle updated inference'); };
  t.after(() => { globalThis.fetch = original; });
  let closedHeaders!: () => void, closedBody!: () => void;
  const headerClosed = new Promise<void>(resolve => { closedHeaders = resolve; });
  const bodyClosed = new Promise<void>(resolve => { closedBody = resolve; });
  const url = await localhost(t, (request, response) => {
    if (request.url === '/headers') { response.on('close', closedHeaders); return; }
    response.on('close', closedBody); response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"answer":');
  });
  const updated = selectHarnessInferenceFetch({});
  await assert.rejects(updated(`${url}/headers`, { signal: AbortSignal.timeout(80) }), { name: 'TimeoutError' });
  const body = await updated(`${url}/body`, { signal: AbortSignal.timeout(100) });
  await assert.rejects(body.json(), { name: 'TimeoutError' });
  await Promise.race([Promise.all([headerClosed, bodyClosed]), new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('cancelled inference left a localhost connection open')), 1000); t.after(() => clearTimeout(timer));
  })]);
});

test('updated harness keeps IPv4-only HTTP credentials guards and never follows redirects', async t => {
  const updated = selectHarnessInferenceFetch({}); let requests = 0;
  const url = await localhost(t, (_request, response) => { requests++; response.writeHead(302, { Location: 'https://example.org/forbidden' }).end(); });
  const response = await updated(url, { redirect: 'follow', credentials: 'include' });
  assert.equal(response.status, 302); assert.equal(requests, 1);
  for (const invalid of ['https://127.0.0.1:12345/', 'http://localhost:12345/', 'http://[::1]:12345/', 'http://192.0.2.1:12345/', 'http://user:password@127.0.0.1:12345/', 'http://127.0.0.1/']) {
    await assert.rejects(updated(invalid), { code: 'INVALID_INFERENCE_HOST' });
  }
  await assert.rejects(updated(new Request(url)), /explicit JSON request options/);
  assert.equal(requests, 1, 'invalid endpoints are rejected before any request');
});
