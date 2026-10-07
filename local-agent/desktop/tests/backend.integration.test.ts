import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GooseBackend, type BackendOptions } from '../backend.ts';
import type { AgentEvent, Mode, UtilityPreferences } from '../renderer/types.ts';

// These tests use the actual downloaded Goose binary and frozen research sidecar.
// The provider is a deterministic authenticated loopback fixture; no LLM download,
// real web search, or public internet request is needed.
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const goose = path.join(repository, 'resources', 'goose', `goose${suffix}`);
const research = path.join(repository, 'local-agent', 'research', 'dist', 'local-agent-research', `local-agent-research${suffix}`);
const bridge = path.join(repository, 'dist', 'action-bridge.cjs');
const requireIntegration = process.env.LOCAL_AGENT_REQUIRE_INTEGRATION === '1';
const model = 'local-agent-integration-fixture';
const plainReply = 'LOCAL_AGENT_PLAIN_OK';
const readPrompt = 'READ_LOCAL_FIXTURE';
const fixtureText = 'offline fixture text from the granted document — سلام 😀';
const citation = '[offline fixture source](https://example.org/local-agent-fixture)';
const apiKey = 'local-agent-owned-fixture-key';
const outputTokens = 1024;

interface ChatRequest {
  model: string;
  stream?: boolean;
  max_tokens?: number;
  tools?: { type: string; function: { name: string; parameters?: unknown } }[];
  messages?: { role: string; content?: unknown; tool_call_id?: string }[];
}

function missingResources(mode: Mode): string[] {
  return [goose, research, ...(mode === 'coding' ? [bridge] : [])].filter(file => !existsSync(file));
}

function skipReason(mode: Mode): string | false {
  const missing = missingResources(mode);
  return !requireIntegration && missing.length ?
    `Prepare native resources (npm run prepare:backend; npm run prepare:research; npm run build): ${missing.join(', ')}` : false;
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function sendStream(response: ServerResponse, delta: object, finishReason = 'stop'): void {
  const base = { id: 'local-agent-fixture-completion', object: 'chat.completion.chunk', created: 1, model };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function sendFragmentedToolStream(response: ServerResponse, name: string, argumentsText: string): void {
  const base = { id: 'local-agent-fixture-completion', object: 'chat.completion.chunk', created: 1, model };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames: object[] = [{ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-read-call', type: 'function', function: { name, arguments: '' } }] }];
  const characters = Array.from(argumentsText);
  for (let offset = 0; offset < characters.length; offset += 7) {
    frames.push({ tool_calls: [{ index: 0, function: { arguments: characters.slice(offset, offset + 7).join('') } }] });
  }
  for (const delta of frames) {
    const bytes = Buffer.from(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    // Split UTF-8 characters and SSE records at transport boundaries too.
    for (let offset = 0; offset < bytes.length; offset += 11) response.write(bytes.subarray(offset, offset + 11));
  }
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function toolNames(request: ChatRequest): string[] {
  return (request.tools ?? []).map(tool => tool.function.name).sort();
}

function defaults(mode: Mode): UtilityPreferences {
  return { fileReading: true, projectSearch: mode === 'coding', fileEditing: mode === 'coding', terminal: mode === 'coding', webResearch: false };
}

function assertToolSet(request: ChatRequest, utilities: UtilityPreferences): void {
  const expected = [
    ...(utilities.fileReading ? ['inspect_file', 'read_file', 'read_pdf'] : []),
    ...(utilities.projectSearch ? ['list_files', 'search_files'] : []),
    ...(utilities.fileEditing ? ['edit_file', 'write_file'] : []),
    ...(utilities.terminal ? ['run_command', 'read_command_output'] : []),
    ...(utilities.webResearch ? ['web_search', 'web_fetch'] : []),
  ];
  const names = toolNames(request);
  assert.deepEqual(names.map(name => name.split('__').at(-1)!).sort(), expected.sort(),
    `Only application-owned tools may be advertised: ${names.join(', ')}`);
  for (const name of names) {
    assert.ok(!name.includes('__') || /^(local_files_and_research|reviewed_actions)__/.test(name), name);
    assert.doesNotMatch(name, /developer|(?:^|__)shell$|manage_extensions|code_execution|orchestrator/i);
  }
  assert.equal(request.model, model);
  assert.equal(request.stream, true);
  assert.equal(request.max_tokens, outputTokens, 'Every agent request must include the explicit local output allowance.');
}

async function fixture(mode: Mode, overrides: Partial<UtilityPreferences> = {}) {
  assert.deepEqual(missingResources(mode), [], 'Native integration resources must be prepared when LOCAL_AGENT_REQUIRE_INTEGRATION=1.');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-backend-integration-')));
  const project = path.join(directory, 'project');
  const data = path.join(directory, 'goose-data');
  await mkdir(project);
  const selectedFile = path.join(project, 'selected-مطالعه-😀.txt');
  await writeFile(selectedFile, `${fixtureText}\n`);
  const requests: { url: string; body: unknown; authorization?: string }[] = [];
  const chats: ChatRequest[] = [];
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  let actionRequests = 0;
  const actionToken = 'a'.repeat(64);
  const utilities = { ...defaults(mode), ...overrides };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += Buffer.byteLength(chunk);
        if (length > 2 * 1024 * 1024) { sendJson(response, 413, { error: 'fixture payload too large' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const url = request.url ?? '';
      requests.push({ url, body, authorization: request.headers.authorization });
      if (url.startsWith('/v1/') && request.headers.authorization !== `Bearer ${apiKey}`) {
        errors.push(`Missing application-owned Bearer authorization for ${url}`);
        sendJson(response, 401, { error: 'Loopback authentication required' });
      } else if (url === '/v1/models') {
        sendJson(response, 200, { object: 'list', data: [{ id: model, object: 'model' }] });
      } else if (url === `/${actionToken}`) {
        actionRequests++;
        sendJson(response, 403, { error: 'Integration fixture never executes actions.' });
      } else if (url === '/v1/chat/completions') {
        const chat = body as ChatRequest;
        chats.push(chat);
        const messages = chat.messages ?? [];
        const wantsRead = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(readPrompt));
        const readResult = messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes(fixtureText));
        // Goose may make auxiliary title-generation requests without agent tools.
        if (!chat.tools?.length) sendStream(response, { content: 'Read selected document' });
        else if (!wantsRead) sendStream(response, { content: plainReply });
        else if (readResult) sendStream(response, { content: `LOCAL_AGENT_READ_OK ${citation}` });
        else {
          const readTool = chat.tools.find(tool => /(?:^|__)read_file$/.test(tool.function.name));
          if (!readTool) sendStream(response, { content: 'READ_TOOL_MISSING' });
          else sendFragmentedToolStream(response, readTool.function.name, JSON.stringify({ path: selectedFile, start_line: 1, max_lines: 2 }));
        }
      } else {
        errors.push(`Unexpected local provider endpoint: ${url}`);
        sendJson(response, 404, { error: 'Unsupported integration fixture endpoint' });
      }
    })().catch(error => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) sendJson(response, 500, { error: 'Local integration fixture failed' });
      else response.end();
    });
  });
  let backend: GooseBackend | undefined;
  try {
    const baseUrl = await listen(server);
    const options: BackendOptions = { executable: goose, researchExecutable: research, bridgeExecutable: bridge,
      nodeExecutable: process.execPath, dataDirectory: data, cwd: project, mode, model, baseUrl,
      apiKey, outputTokens, utilities, contextTokens: 8192,
      grantedRoots: mode === 'coding' ? [project] : [], grantedFiles: [selectedFile],
      actionUrl: mode === 'coding' ? `${baseUrl}/${actionToken}` : undefined,
      onEvent: event => events.push(event) };
    backend = new GooseBackend(options);
    await backend.start();
    return { backend, chats, events, requests, errors, selectedFile, utilities, actions: () => actionRequests,
      cleanup: async () => {
        await backend!.stop();
        await close(server);
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } };
  } catch (error) {
    await backend?.stop();
    await close(server);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    throw error;
  }
}

test('real Goose research mode defaults to local files and authenticates the loopback provider',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research');
    try {
      await run.backend.prompt('Say hello using the local fixture.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1, 'The real Goose agent must reach the bundled-engine loopback endpoint.');
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.ok(run.requests.every(request => /^\/v1\//.test(request.url)), 'Ollama endpoints must never be requested.');
      assert.ok(run.requests.every(request => request.authorization === `Bearer ${apiKey}`));
      assert.equal(run.events.filter(event => event.type === 'message').map(event => event.text).join(''), plainReply);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose handles fragmented Unicode SSE tool arguments and reads through the frozen sidecar',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research');
    try {
      await run.backend.prompt(`${readPrompt}: read the selected document and summarize its text.`);
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 2, 'A tool round trip must call the provider again with its result.');
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.ok(agentRequests.some(request => request.messages?.some(message =>
        message.role === 'tool' && JSON.stringify(message.content).includes(fixtureText))));
      const tools = run.events.filter(event => event.type === 'tool');
      assert.ok(tools.some(event => JSON.stringify(event.input).includes(run.selectedFile)), 'The ACP tool event must expose the selected read path.');
      assert.ok(tools.some(event => event.status === 'completed' && JSON.stringify(event.output).includes(fixtureText)),
        'The ACP completed event must expose actual local tool output.');
      const text = run.events.filter(event => event.type === 'message').map(event => event.text).join('');
      assert.match(text, /LOCAL_AGENT_READ_OK/);
      assert.ok(text.includes(citation), 'Markdown citation URLs must survive provider streaming and ACP events.');
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose coding mode advertises reviewed actions without built-in shell or unrestricted developer tools',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding');
    try {
      await run.backend.prompt('Say hello without calling any tool.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.equal(run.events.filter(event => event.type === 'message').map(event => event.text).join(''), plainReply);
      assert.equal(run.actions(), 0, 'The test must never execute a host action or shell command.');
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose research mode exposes web tools only with explicit opt-in',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research', { webResearch: true });
    try {
      await run.backend.prompt('Say hello without searching the web.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose assistant mode exposes no search, editing, terminal, or network tools',
  { skip: skipReason('assistant'), timeout: 120_000 }, async () => {
    const run = await fixture('assistant');
    try {
      await run.backend.prompt('Say hello without calling tools.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose coding utility controls remove the reviewed-actions extension',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { fileEditing: false, terminal: false, projectSearch: false });
    try {
      await run.backend.prompt('Say hello without calling tools.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });
