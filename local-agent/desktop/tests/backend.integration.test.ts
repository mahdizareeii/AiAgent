import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { GooseBackend, backendEnvironment, type BackendOptions } from '../backend.ts';
import { loadTaskResearchSkill } from '../skills/task-research.ts';
import { LocalActions, type ActionPermission } from '../actions.ts';
import { createActionHost } from '../action-host.ts';
import { DEFAULT_PLUGINS, effectiveUtilities } from '../state.ts';
import type { AgentEvent, Mode, PluginPreferences, UtilityPreferences } from '../renderer/types.ts';

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
const thoughtPrompt = 'SHOW_LOCAL_THOUGHT_FIXTURE';
const thoughtText = 'Inspect the selected folder first.\nسلام 🌍\nThen report the verified result.';
const fixtureText = 'offline fixture text from the granted document — سلام 😀';
const citation = '[offline fixture source](https://example.org/local-agent-fixture)';
const apiKey = 'local-agent-owned-fixture-key';
const outputTokens = 1024;
const scaffoldPrompt = 'CREATE_WORDPRESS_FIXTURE';
const scaffold = [
  { path: 'docker-compose.yml', content: 'services:\n  wordpress:\n    image: wordpress:6\n    ports: ["8080:80"]\n    volumes: ["./wp-content:/var/www/html/wp-content"]\n' },
  { path: 'wp-content/themes/local-demo/style.css', content: '/*\nTheme Name: Local Demo\nDescription: سلام — local theme fixture\n*/\n' },
];

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

function sendFragmentedToolStream(response: ServerResponse, name: string, argumentsText: string, callId = 'fixture-read-call'): void {
  const base = { id: 'local-agent-fixture-completion', object: 'chat.completion.chunk', created: 1, model };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames: object[] = [{ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }];
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

function sendThoughtStream(response: ServerResponse): void {
  const base = { id: 'local-agent-thought-fixture', object: 'chat.completion.chunk', created: 1, model };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const characters = Array.from(thoughtText);
  const frames: object[] = [];
  for (let offset = 0; offset < characters.length; offset += 5) frames.push({ reasoning_content: characters.slice(offset, offset + 5).join('') });
  frames.push({ content: plainReply });
  for (const delta of frames) {
    const bytes = Buffer.from(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    for (let offset = 0; offset < bytes.length; offset += 11) response.write(bytes.subarray(offset, offset + 11));
  }
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
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
    ...(utilities.fileEditing ? ['edit_file', 'write_file', 'create_files'] : []),
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

async function fixture(mode: Mode, overrides: Partial<UtilityPreferences> = {}, approveScaffold?: boolean,
  plugins: PluginPreferences = DEFAULT_PLUGINS,
  skillsDirectory = path.join(repository, 'local-agent', 'desktop', 'skills')) {
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
  const configuredUtilities = { ...defaults(mode), ...overrides };
  const utilities = effectiveUtilities(mode, configuredUtilities, plugins);
  const controller = new AbortController();
  const permissions: ActionPermission[] = [];
  const actions = new LocalActions({ projectPath: project, historyDirectory: path.join(directory, 'history'), utilities,
    onPermission: async permission => { permissions.push(permission); return approveScaffold === true; } });
  const host = approveScaffold === undefined ? undefined : await createActionHost(actions, controller.signal);
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
        const wantsThoughts = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(thoughtPrompt));
        const wantsScaffold = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(scaffoldPrompt));
        const readResult = messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes(fixtureText));
        // Goose may make auxiliary title-generation requests without agent tools.
        if (!chat.tools?.length) sendStream(response, { content: 'Read selected document' });
        else if (wantsScaffold) {
          const results = messages.filter(message => message.role === 'tool').map(message => JSON.stringify(message.content));
          const batch = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(`BATCH_${scaffoldPrompt}`));
          const writeTool = chat.tools.find(tool => (batch ? /(?:^|__)create_files$/ : /(?:^|__)write_file$/).test(tool.function.name));
          const next = scaffold.find(file => !results.some(result => result.includes(`Created ${file.path}.`)));
          if (results.some(result => /denied/i.test(result))) sendStream(response, { content: 'SCAFFOLD_DENIED_NO_CHANGES' });
          else if (!next || batch && results.some(result => result.includes(`Created ${scaffold.length} project files.`))) sendStream(response, { content: 'SCAFFOLD_CREATED_FROM_TOOL_RESULTS' });
          else if (!writeTool) sendStream(response, { content: 'WRITE_TOOL_MISSING' });
          else if (batch) sendFragmentedToolStream(response, writeTool.function.name, JSON.stringify({ files: scaffold }), 'batch-scaffold');
          else sendFragmentedToolStream(response, writeTool.function.name, JSON.stringify(next), `write-${scaffold.indexOf(next)}`);
        }
        else if (wantsThoughts) sendThoughtStream(response);
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
      apiKey, outputTokens, utilities: configuredUtilities, plugins, contextTokens: 8192,
      grantedRoots: mode === 'coding' ? [project] : [], grantedFiles: [selectedFile],
      skillsDirectory, currentDate: '2026-10-10',
      actionUrl: host?.url ?? (mode === 'coding' ? `${baseUrl}/${actionToken}` : undefined),
      onEvent: event => events.push(event) };
    backend = new GooseBackend(options);
    await backend.start();
    return { backend, chats, events, requests, errors, selectedFile, utilities, project, permissions, localActions: actions, actions: () => actionRequests,
      cleanup: async () => {
        await backend!.stop();
        controller.abort();
        if (host) { await host.drain(); await close(host.server); }
        await close(server);
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } };
  } catch (error) {
    await backend?.stop();
    controller.abort();
    if (host) { await host.drain(); await close(host.server); }
    await close(server);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    throw error;
  }
}

test('real Goose initializes bundled file tools after a delayed cold start with one fixed MCP handshake',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-cold-start-')));
    const dataDirectory = path.join(directory, 'data');
    const wirePath = path.join(directory, 'first-mcp-request.json');
    const launcher = path.join(directory, 'delayed-research.cjs');
    await mkdir(path.join(dataDirectory, 'config'), { recursive: true });
    await writeFile(path.join(dataDirectory, 'config/config.yaml'), JSON.stringify({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: model,
      GOOSE_MODE: 'auto', GOOSE_TELEMETRY_ENABLED: false, CONTEXT_FILE_NAMES: [],
      extensions: { developer: { type: 'platform', name: 'developer', enabled: false } } }));
    // Delay exceeds the discovery probe's eight-second fallback window. No
    // inference, tools, edits, or commands are requested by this fixture.
    await writeFile(launcher, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
let child, wire = '', recorded = false;
process.on('SIGTERM', () => { child?.kill('SIGTERM'); process.exit(0); });
setTimeout(() => {
  child = spawn(${JSON.stringify(research)}, [], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'], shell: false });
  process.stdin.on('data', chunk => {
    if (recorded) return;
    wire += String(chunk);
    const boundary = wire.indexOf('\\n');
    if (boundary < 0) return;
    const request = JSON.parse(wire.slice(0, boundary));
    fs.writeFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ method: request.method, protocolVersion: request.params?.protocolVersion }));
    recorded = true;
  });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  child.on('close', code => { process.stdin.destroy(); process.exitCode = code ?? 1; });
}, 9000);
`);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/v1/models') sendJson(response, 200, { object: 'list', data: [{ id: model, object: 'model' }] });
      else sendJson(response, 404, { error: 'This fixture does not provide inference or actions.' });
    });
    const baseUrl = await listen(server);
    const options: BackendOptions = { executable: goose, researchExecutable: research, nodeExecutable: process.execPath,
      bridgeExecutable: bridge, dataDirectory, cwd: directory, mode: 'research', model, baseUrl, apiKey, contextTokens: 8192,
      outputTokens, utilities: defaults('research'), grantedRoots: [directory], grantedFiles: [], onEvent: () => assert.fail('No agent events expected without a prompt.') };
    const child = spawn(goose, ['acp'], { cwd: directory, env: backendEnvironment(options), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      const connection = new ClientSideConnection(() => ({ sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'free-local-agent-cold-start-test', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const started = Date.now();
      const session = await connection.newSession({ cwd: directory, mcpServers: [], _meta: { enabledExtensions: [
        { type: 'mcp', timeout: 180, server: { name: 'local_files_and_research', command: process.execPath, args: [launcher], env: [] } },
      ] } });
      assert.deepEqual(session._meta?.extensionResults, [{ name: 'local_files_and_research', success: true }], stderr);
      assert.ok(Date.now() - started >= 9000, 'The file-tools startup delay must actually be exercised.');
      assert.deepEqual(JSON.parse(await readFile(wirePath, 'utf8')), { method: 'initialize', protocolVersion: '2025-11-25' });
      assert.ok(requests.every(url => url === '/v1/models'), 'Startup cannot request inference or perform project actions.');
    } finally {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
      await closed;
      await close(server);
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

test('real Goose streams local-model thoughts separately from its final answer through ACP',
  { skip: skipReason('assistant'), timeout: 120_000 }, async () => {
    const run = await fixture('assistant');
    try {
      await run.backend.prompt(thoughtPrompt);
      const messages = run.events.filter(event => event.type === 'message');
      assert.equal(messages.filter(event => event.thinking).map(event => event.text).join(''), thoughtText);
      assert.equal(messages.filter(event => !event.thinking).map(event => event.text).join(''), plainReply);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose enabled research plugin without web permission uses local files and authenticates the loopback provider',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research', {}, undefined, { taskResearch: true });
    try {
      const running = run.backend.prompt('Say hello using the local fixture.');
      await assert.rejects(run.backend.prompt('Start overlapping work.'), /task is already running/);
      await running;
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1, 'The real Goose agent must reach the bundled-engine loopback endpoint.');
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      const skill = await loadTaskResearchSkill(path.join(repository, 'local-agent', 'desktop', 'skills'));
      const userPrompt = agentRequests[0].messages?.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n') ?? '';
      assert.ok(userPrompt.includes(JSON.stringify(skill.instructions).slice(1, -1)), 'The actual Goose provider request must contain the shipped skill.');
      assert.ok(userPrompt.includes('Web research is OFF'));
      assert.ok(userPrompt.includes('2026-10-10'));
      assert.ok(run.requests.every(request => /^\/v1\//.test(request.url)), 'Ollama endpoints must never be requested.');
      assert.ok(run.requests.every(request => request.authorization === `Bearer ${apiKey}`));
      assert.equal(run.events.filter(event => event.type === 'message').map(event => event.text).join(''), plainReply);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose ordinary Agent starts with missing optional skill assets and preserves local tools without injecting research',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', {}, undefined, DEFAULT_PLUGINS, path.join(repository, 'missing-optional-skills'));
    try {
      await run.backend.prompt('Say hello without calling any tool.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) {
        assertToolSet(request, run.utilities);
        const userPrompt = request.messages?.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n') ?? '';
        assert.doesNotMatch(userPrompt, /OPTIONAL PLUGIN|Task research|Web research is enabled|Inspect local versions/);
        assert.match(userPrompt, /create_files/);
      }
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose disabled research plugin omits web tools even with configured web permission',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research', { webResearch: true }, undefined, { taskResearch: false });
    try {
      await run.backend.prompt('Say hello without researching.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) {
        assertToolSet(request, run.utilities);
        assert.ok(toolNames(request).every(name => !/(?:^|__)web_(search|fetch)$/.test(name)));
        const userPrompt = request.messages?.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n') ?? '';
        assert.doesNotMatch(userPrompt, /OPTIONAL PLUGIN|Task research/);
      }
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.ok(run.requests.every(request => /^\/v1\//.test(request.url)));
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose scaffolds project files through MCP and per-file approval, with durable undo',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { terminal: false }, true);
    try {
      await run.backend.prompt(`${scaffoldPrompt}: create the WordPress fixture files in the selected project.`);
      assert.equal(run.permissions.length, scaffold.length, 'Every file must pass the actual approval host.');
      for (const [index, file] of scaffold.entries()) {
        assert.equal(await readFile(path.join(run.project, file.path), 'utf8'), file.content);
        assert.equal(run.permissions[index].arguments.path, file.path);
        assert.equal(run.permissions[index].arguments.content, file.content);
        assert.match(run.permissions[index].preview!, /--- \/dev\/null/);
      }
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 3, 'Two actual tool results must return to Goose before completion.');
      assert.ok(run.events.some(event => event.type === 'tool' && event.status === 'completed' && JSON.stringify(event.output).includes('Created docker-compose.yml.')));
      assert.match(run.events.filter(event => event.type === 'message').map(event => event.text).join(''), /SCAFFOLD_CREATED_FROM_TOOL_RESULTS/);
      for (const _file of scaffold) assert.equal(await run.localActions.undo(), 1);
      for (const file of scaffold) await assert.rejects(readFile(path.join(run.project, file.path)), { code: 'ENOENT' });
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose receives denied scaffold results without writing or replaying the action',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { terminal: false }, false);
    try {
      await assert.rejects(run.backend.prompt(`${scaffoldPrompt}: create the WordPress fixture files in the selected project.`), /Action denied.*task stopped/);
      assert.equal(run.permissions.length, 1, 'A denied action must not be retried.');
      assert.deepEqual(await readdir(run.project), [path.basename(run.selectedFile)]);
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 1, 'The backend must stop before the model can propose a retry.');
      assert.ok(run.events.some(event => event.type === 'tool' && JSON.stringify(event.output ?? null).includes('denied')));
      assert.equal(await run.localActions.undo(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose creates a reviewed multi-file scaffold batch with grouped undo',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { terminal: false }, true);
    try {
      await run.backend.prompt(`BATCH_${scaffoldPrompt}: create the WordPress fixture as one reviewed file group.`);
      assert.equal(run.permissions.length, 1);
      assert.deepEqual(run.permissions[0].arguments.files, scaffold);
      for (const file of scaffold) {
        assert.equal(await readFile(path.join(run.project, file.path), 'utf8'), file.content);
        assert.ok(run.permissions[0].preview!.includes(`+++ ${file.path}`));
      }
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 2);
      assert.equal(await run.localActions.undo(), scaffold.length);
      for (const file of scaffold) await assert.rejects(readFile(path.join(run.project, file.path)), { code: 'ENOENT' });
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

test('real Goose research mode exposes web tools only with plugin and web opt-in',
  { skip: skipReason('research'), timeout: 120_000 }, async () => {
    const run = await fixture('research', { webResearch: true }, undefined, { taskResearch: true });
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

test('real Goose Agent research opt-in registers only web tools when local utilities are disabled',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { fileReading: false, projectSearch: false, fileEditing: false, terminal: false, webResearch: true }, undefined, { taskResearch: true });
    try {
      await run.backend.prompt('Say hello without searching the web.');
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 1);
      for (const request of agentRequests) assertToolSet(request, run.utilities);
      const userPrompt = agentRequests[0].messages?.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n') ?? '';
      assert.ok(userPrompt.includes('Web research is enabled'));
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
