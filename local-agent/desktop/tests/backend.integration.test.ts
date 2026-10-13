import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { taskInstructions } from '../agent-policy.ts';
import { LocalActions, type ActionPermission } from '../actions.ts';
import { createActionHost } from '../action-host.ts';
import { DEFAULT_PLUGINS, effectiveUtilities } from '../state.ts';
import { emptyToolHistory, restoreToolHistory, updateToolHistory } from '../tool-history.ts';
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
const maxTokensPrompt = 'OUTPUT_LIMIT_FIXTURE';
const hangPrompt = 'WAIT_FOR_CANCELLATION_FIXTURE';
const failedEditPrompt = 'FAIL_IDENTICAL_EDIT_FIXTURE';
const timedCommandPrompt = 'TIMEOUT_COMMAND_FIXTURE';
const commandOutputPrompt = 'COMMAND_OUTPUT_FIXTURE';
const failedLogReadPrompt = 'MISUSE_CREATION_ID_FOR_LOG_FIXTURE';
const unsupportedReadPrompt = 'READ_UNSUPPORTED_LOCAL_FIXTURE';
const errorSourceReadPrompt = 'READ_ERROR_JSON_SOURCE_FIXTURE';
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

function mutationReceipt(events: AgentEvent[], operation: string, filePath?: string): Record<string, unknown> {
  for (const event of events) {
    if (event.type !== 'tool' || event.status !== 'completed' || !event.output || typeof event.output !== 'object' || Array.isArray(event.output)) continue;
    const receipt = event.output as Record<string, unknown>;
    if (receipt.operation === operation && (filePath === undefined || receipt.path === filePath)) return receipt;
  }
  assert.fail(`A completed ACP tool must expose the host-verified ${operation} receipt${filePath ? ` for ${filePath}` : ''}.`);
}

function receiptActionId(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const candidate of [value, value.split('\n')[0]]) {
      try { const id = receiptActionId(JSON.parse(candidate), depth + 1); if (id) return id; } catch {}
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) { const id = receiptActionId(entry, depth + 1); if (id) return id; }
    return;
  }
  if (typeof value === 'object') {
    const receipt = value as Record<string, unknown>;
    if (receipt.operation === 'create_files' && typeof receipt.action_id === 'string' && /^[a-f0-9-]{36}$/.test(receipt.action_id)) return receipt.action_id;
    for (const entry of Object.values(receipt)) { const id = receiptActionId(entry, depth + 1); if (id) return id; }
  }
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
  skillsDirectory = path.join(repository, 'local-agent', 'desktop', 'skills'),
  backendOverrides: Partial<Pick<BackendOptions, 'taskEffort' | 'signal' | 'appPolicyProvided'>> = {},
  attachmentOutsideWorkspace = false) {
  assert.deepEqual(missingResources(mode), [], 'Native integration resources must be prepared when LOCAL_AGENT_REQUIRE_INTEGRATION=1.');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-backend-integration-')));
  const project = path.join(directory, 'project');
  const data = path.join(directory, 'goose-data');
  await mkdir(project);
  const selectedFile = path.join(attachmentOutsideWorkspace ? directory : project, 'selected-مطالعه-😀.txt');
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
        const wantsFailedEdit = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(failedEditPrompt));
        const wantsMaxTokens = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(maxTokensPrompt));
        const wantsHang = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(hangPrompt));
        const wantsTimedCommand = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(timedCommandPrompt));
        const wantsCommandOutput = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(commandOutputPrompt));
        const wantsFailedLogRead = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(failedLogReadPrompt));
        const wantsUnsupportedRead = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(unsupportedReadPrompt));
        const wantsErrorSourceRead = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(errorSourceReadPrompt));
        const readResult = messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes(fixtureText));
        // Goose may make auxiliary title-generation requests without agent tools.
        if (!chat.tools?.length) sendStream(response, { content: 'Read selected document' });
        else if (wantsHang) { /* The controlled local provider remains pending until task cancellation. */ }
        else if (wantsMaxTokens) sendStream(response, { content: 'unfinished fixture answer' }, 'length');
        else if (wantsUnsupportedRead || wantsErrorSourceRead) {
          if (messages.some(message => message.role === 'tool')) sendStream(response, { content: 'LOCAL_AGENT_RECEIPT_CHECK_FINISHED' });
          else {
            const readTool = chat.tools.find(tool => /(?:^|__)read_file$/.test(tool.function.name));
            if (!readTool) sendStream(response, { content: 'READ_TOOL_MISSING' });
            else sendFragmentedToolStream(response, readTool.function.name, JSON.stringify({
              path: path.join(project, wantsUnsupportedRead ? 'unsupported-image.png' : 'error-json-source.txt'),
            }), 'receipt-status-read');
          }
        }
        else if (wantsFailedLogRead) {
          const toolMessages = messages.filter(message => message.role === 'tool');
          if (!toolMessages.length) {
            const createTool = chat.tools.find(tool => /(?:^|__)create_files$/.test(tool.function.name));
            if (!createTool) sendStream(response, { content: 'CREATE_TOOL_MISSING' });
            else sendFragmentedToolStream(response, createTool.function.name,
              JSON.stringify({ files: [{ path: 'verified-once.txt', content: 'created once\n' }] }), 'create-before-invalid-log-read');
          } else {
            const id = toolMessages.map(message => receiptActionId(message.content)).find(Boolean);
            const logTool = chat.tools.find(tool => /(?:^|__)read_command_output$/.test(tool.function.name));
            if (!id || !logTool) sendStream(response, { content: 'CREATION_RECEIPT_OR_LOG_TOOL_MISSING' });
            else sendFragmentedToolStream(response, logTool.function.name, JSON.stringify({ id, offset: 0 }), `misused-action-log-${toolMessages.length}`);
          }
        }
        else if (wantsCommandOutput) {
          if (messages.some(message => message.role === 'tool')) sendStream(response, { content: 'COMMAND_OUTPUT_VERIFIED' });
          else {
            const commandTool = chat.tools.find(tool => /(?:^|__)run_command$/.test(tool.function.name));
            const executable = process.platform === 'win32' ? `"${process.execPath}"` : `'${process.execPath.replace(/'/g, `'"'"'`)}'`;
            if (!commandTool) sendStream(response, { content: 'COMMAND_TOOL_MISSING' });
            else sendFragmentedToolStream(response, commandTool.function.name, JSON.stringify({
              command: `${executable} command-output-fixture.cjs`, cwd: '.', timeout_ms: 5000,
            }), 'actual-command-output');
          }
        }
        else if (wantsTimedCommand) {
          const commandTool = chat.tools.find(tool => /(?:^|__)run_command$/.test(tool.function.name));
          if (!commandTool) sendStream(response, { content: 'COMMAND_TOOL_MISSING' });
          else sendFragmentedToolStream(response, commandTool.function.name, JSON.stringify({
            command: process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 5', timeout_ms: 100,
          }), 'bounded-command');
        }
        else if (wantsFailedEdit) {
          const failures = messages.filter(message => message.role === 'tool').length;
          const editTool = chat.tools.find(tool => /(?:^|__)edit_file$/.test(tool.function.name));
          if (!editTool) sendStream(response, { content: 'EDIT_TOOL_MISSING' });
          else sendFragmentedToolStream(response, editTool.function.name,
            JSON.stringify({ path: path.basename(selectedFile), old_text: `1: ${fixtureText}`, new_text: 'must not be written' }), `failed-edit-${failures}`);
        }
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
      ...backendOverrides,
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
      const completion = await run.backend.prompt(thoughtPrompt);
      assert.equal(completion.stopReason, 'end_turn');
      const messages = run.events.filter(event => event.type === 'message');
      assert.equal(messages.filter(event => event.thinking).map(event => event.text).join(''), thoughtText);
      assert.equal(messages.filter(event => !event.thinking).map(event => event.text).join(''), plainReply);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose reports the actual ACP output-token stop reason without replaying the turn',
  { skip: skipReason('assistant'), timeout: 120_000 }, async () => {
    const run = await fixture('assistant');
    try {
      const completion = await run.backend.prompt(maxTokensPrompt);
      assert.equal(completion.stopReason, 'max_tokens');
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 1);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose owned unsupported-file receipt displays a failed tool despite ACP transport completion',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { fileEditing: false, terminal: false });
    try {
      await writeFile(path.join(run.project, 'unsupported-image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      assert.equal((await run.backend.prompt(unsupportedReadPrompt)).stopReason, 'end_turn');
      const call = run.events.find(event => event.type === 'tool' && /^local[ _]files[ _]and[ _]research:/i.test(event.title));
      assert.ok(call && call.type === 'tool', 'The app must identify the owned tool before processing its output.');
      const result = run.events.find(event => event.type === 'tool' && event.id === call.id && event.output);
      assert.ok(result && result.type === 'tool');
      assert.equal(result.status, 'failed');
      assert.equal((result.output as Record<string, unknown>).ok, false);
      assert.equal((result.output as Record<string, unknown>).error, 'unsupported_file');
      assert.equal(run.events.filter(event => event.type === 'message').filter(event => !event.thinking).map(event => event.text).join(''), 'LOCAL_AGENT_RECEIPT_CHECK_FINISHED');
      assert.equal(run.permissions.length, 0);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose successful owned file read keeps completed status for source containing identical error JSON',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { fileEditing: false, terminal: false });
    try {
      const source = JSON.stringify({ ok: false, error: 'unsupported_file', isError: true, message: 'This is file content.' });
      await writeFile(path.join(run.project, 'error-json-source.txt'), source);
      assert.equal((await run.backend.prompt(errorSourceReadPrompt)).stopReason, 'end_turn');
      const call = run.events.find(event => event.type === 'tool' && /^local[ _]files[ _]and[ _]research:/i.test(event.title));
      assert.ok(call && call.type === 'tool');
      const result = run.events.find(event => event.type === 'tool' && event.id === call.id && event.output);
      assert.ok(result && result.type === 'tool');
      assert.equal(result.status, 'completed');
      assert.equal((result.output as Record<string, unknown>).ok, true);
      assert.equal((result.output as Record<string, unknown>).text, source);
      assert.equal(run.events.some(event => event.type === 'tool' && event.status === 'failed'), false);
      assert.equal(run.permissions.length, 0);
      assert.equal(run.actions(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose respects cancellation while the local provider is pending and preserves its reason',
  { skip: skipReason('assistant'), timeout: 120_000 }, async () => {
    const controller = new AbortController();
    const run = await fixture('assistant', {}, undefined, DEFAULT_PLUGINS, undefined, { taskEffort: 'careful', signal: controller.signal });
    try {
      const pending = run.backend.prompt(hangPrompt);
      const rejected = assert.rejects(pending, /Active task budget expired/);
      const until = Date.now() + 10_000;
      while (!run.chats.some(chat => chat.tools?.length) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(run.chats.some(chat => chat.tools?.length), 'The task must actually reach a pending inference request.');
      controller.abort(new Error('Active task budget expired.'));
      await rejected;
      assert.equal(run.actions(), 0);
      assert.equal(run.events.some(event => event.type === 'tool'), false);
    } finally { await run.cleanup(); }
  });

test('real Goose stops after two identical exact-text edit failures without another approval or mutation',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { terminal: false }, true);
    try {
      await assert.rejects(run.backend.prompt(failedEditPrompt), /Two identical edits failed against unchanged file content/);
      assert.equal(await readFile(run.selectedFile, 'utf8'), `${fixtureText}\n`);
      assert.equal(run.permissions.length, 0, 'Nonmatching edits must not request permission.');
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 2, 'No model retry may follow the second failure.');
      assert.equal(await run.localActions.undo(), 0);
      assert.ok(run.events.some(event => event.type === 'tool' && event.status === 'failed' && JSON.stringify(event.output).includes('REPEATED_EDIT_FAILED')));
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose stops on a structured approved-command timeout and never repeats execution',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', {}, true);
    try {
      await assert.rejects(run.backend.prompt(timedCommandPrompt), /stopped after an interrupted action request/);
      assert.equal(run.permissions.length, 1);
      assert.equal(run.permissions[0].arguments.timeout_ms, 100);
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 1);
      assert.ok(run.events.some(event => event.type === 'tool' && event.status === 'failed' && JSON.stringify(event.output).includes('COMMAND_TIMEOUT')));
      assert.equal(await readFile(run.selectedFile, 'utf8'), `${fixtureText}\n`);
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose retains actual bounded command output in Working without adding it again to provider context or replaying execution',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', { fileEditing: false }, true);
    try {
      const digest = createHash('sha256').update(await readFile(run.selectedFile)).digest('hex');
      const stdout = `PASS valid\r\nPASS empty\r\nPASS malformed\r\nPASS nonnumeric — سلام 😀\r\nSHA-256: ${digest}\n`;
      const outputFile = path.join(run.project, 'command-output.txt');
      const scriptFile = path.join(run.project, 'command-output-fixture.cjs');
      await writeFile(outputFile, stdout);
      await writeFile(scriptFile, "process.stdout.write(require('node:fs').readFileSync('command-output.txt', 'utf8'));\n");
      assert.equal((await run.backend.prompt(commandOutputPrompt)).stopReason, 'end_turn');
      assert.equal(run.permissions.length, 1, 'The actual command must pass the normal approval host exactly once.');
      assert.match(run.permissions[0].command!, / command-output-fixture\.cjs$/);
      assert.equal(run.permissions[0].arguments.timeout_ms, 5000);
      const receipt = mutationReceipt(run.events, 'run_command');
      assert.equal(receipt.ok, true);
      assert.equal(receipt.exit_code, 0);
      assert.equal(receipt.output_complete, true);
      assert.equal(receipt.next_offset, null);
      assert.match(String(receipt.durable_id), /^[a-f0-9-]{36}$/);
      assert.ok(String(receipt.output_text).includes(stdout), 'Working must retain the real stdout from the ACP text content.');
      const completed = run.events.find(event => event.type === 'tool' && event.status === 'completed' && event.output === receipt);
      assert.ok(completed && completed.type === 'tool');
      const history = run.events.filter(event => event.type === 'tool').reduce((state, event) => {
        if (event.type !== 'tool') return state;
        return updateToolHistory(state, event);
      }, emptyToolHistory());
      const saved = restoreToolHistory(JSON.parse(JSON.stringify(history.tools)));
      assert.deepEqual(saved.tools.find(tool => tool.id === completed.id)?.output, receipt, 'Saved Working must retain stdout and receipt after reopening.');
      const chats = run.chats.filter(chat => chat.tools?.length);
      assert.equal(chats.length, 2, 'One actual command result must return to Goose before the final answer; no replay is permitted.');
      const toolResults = chats[1].messages?.filter(message => message.role === 'tool') ?? [];
      assert.equal(toolResults.length, 1);
      const providerResult = JSON.stringify(toolResults[0].content);
      assert.equal(providerResult.split('PASS valid').length - 1, 1, 'Display enrichment must not duplicate command stdout in model context.');
      assert.ok(providerResult.includes(digest));
      assert.ok(!providerResult.includes('output_text'), 'The UI-only field must never enter provider/MCP content.');
      const logs = path.join(path.dirname(run.project), 'history', 'command-logs');
      assert.deepEqual((await readdir(logs)).sort(), [`${receipt.durable_id}.json`, `${receipt.durable_id}.log`], 'Only one durable command log and its metadata may be created.');
      assert.equal(await readFile(path.join(logs, `${receipt.durable_id}.log`), 'utf8'), stdout);
      assert.equal(createHash('sha256').update(await readFile(run.selectedFile)).digest('hex'), digest);
      assert.equal(await readFile(outputFile, 'utf8'), stdout);
      assert.equal(run.events.filter(event => event.type === 'message' && !event.thinking).map(event => event.type === 'message' ? event.text : '').join(''), 'COMMAND_OUTPUT_VERIFIED');
      assert.deepEqual(run.errors, []);
    } finally { await run.cleanup(); }
  });

test('real Goose stops after two reads of a creation receipt UUID without replaying the completed scaffold',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', {}, true);
    try {
      await assert.rejects(run.backend.prompt(failedLogReadPrompt), /Two identical command-log reads failed without any change in available logs/);
      assert.equal(run.permissions.length, 1, 'Only the original file creation may request permission.');
      assert.equal(await readFile(path.join(run.project, 'verified-once.txt'), 'utf8'), 'created once\n');
      const receipt = mutationReceipt(run.events, 'create_files');
      const reads = run.events.filter(event => event.type === 'tool' && event.status === 'pending' && event.title.includes('read command output'));
      assert.equal(reads.length, 2);
      for (const event of reads) {
        assert.equal(event.type, 'tool');
        if (event.type === 'tool') assert.equal((event.input as Record<string, unknown>).id, receipt.action_id, 'The wrong log ID must come from the actual mutation receipt.');
      }
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 3, 'Creation and two failing log reads must be the complete provider loop.');
      assert.ok(run.events.some(event => event.type === 'tool' && event.status === 'failed' && JSON.stringify(event.output).includes('REPEATED_LOG_READ_FAILED')));
      assert.equal(await run.localActions.undo(), 1);
      await assert.rejects(readFile(path.join(run.project, 'verified-once.txt')), { code: 'ENOENT' });
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
        const receipt = mutationReceipt(run.events, 'write_file', file.path);
        assert.equal(receipt.ok, true);
        assert.equal(receipt.status, 'changed');
        assert.equal(receipt.changed, true);
        assert.equal(receipt.sha256, createHash('sha256').update(file.content, 'utf8').digest('hex'));
        assert.equal(receipt.bytes, Buffer.byteLength(file.content, 'utf8'));
        assert.match(String(receipt.action_id), /^[a-f0-9-]{36}$/);
      }
      assert.equal(run.chats.filter(chat => chat.tools?.length).length, 3, 'Two actual tool results must return to Goose before completion.');
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
      const receipt = mutationReceipt(run.events, 'create_files');
      assert.equal(receipt.ok, true);
      assert.equal(receipt.status, 'changed');
      assert.equal(receipt.changed, true);
      assert.deepEqual(receipt.files, scaffold.map(file => ({ path: file.path, changed: true,
        sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'), bytes: Buffer.byteLength(file.content, 'utf8') })));
      assert.match(String(receipt.action_id), /^[a-f0-9-]{36}$/);
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

test('real Goose app-owned Careful policy reads an absolute granted attachment outside the workspace',
  { skip: skipReason('coding'), timeout: 120_000 }, async () => {
    const run = await fixture('coding', {}, undefined, DEFAULT_PLUGINS,
      path.join(repository, 'local-agent', 'desktop', 'skills'), { taskEffort: 'careful', appPolicyProvided: true }, true);
    try {
      const policy = taskInstructions('coding', run.utilities, true, DEFAULT_PLUGINS, 'careful');
      assert.equal(path.dirname(run.selectedFile), path.dirname(run.project), 'The attachment is outside the granted project root.');
      const task = `${readPrompt}: read the granted attachment at ${run.selectedFile} and report its text.`;
      await run.backend.prompt(`${policy}\nCURRENT USER REQUEST:\n${task}`);
      const agentRequests = run.chats.filter(request => request.tools?.length);
      assert.ok(agentRequests.length >= 2, 'The actual native sidecar must return a file read to Goose.');
      for (const request of agentRequests) {
        assertToolSet(request, run.utilities);
        const userPrompt = request.messages?.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n') ?? '';
        assert.ok(userPrompt.includes(JSON.stringify(policy).slice(1, -1)), 'The complete app policy survives ACP unchanged.');
        assert.equal(userPrompt.split('Careful task:').length, 2, 'The backend must not duplicate Careful rules.');
        assert.equal(userPrompt.split('Copy old_text exactly').length, 2, 'The backend must not duplicate exact-edit rules.');
        assert.match(userPrompt, /Selected project:.*Project mutation paths are relative; never repeat its folder name/);
        assert.match(userPrompt, /Read granted attachments using their supplied absolute paths/);
        assert.doesNotMatch(userPrompt, /File-tool paths are relative/);
        assert.ok(userPrompt.includes(JSON.stringify(task).slice(1, -1)), 'The supplied absolute attachment path survives ACP unchanged.');
        assert.match(userPrompt, /Output limit: 1024 tokens/);
        assert.doesNotMatch(userPrompt, /OPTIONAL PLUGIN|Task research/);
      }
      assert.ok(run.events.some(event => event.type === 'tool' && JSON.stringify(event.input).includes(run.selectedFile)),
        'The actual sidecar read uses the granted absolute path outside the project.');
      assert.ok(run.events.some(event => event.type === 'tool' && event.status === 'completed' && JSON.stringify(event.output).includes(fixtureText)));
      assert.match(run.events.filter(event => event.type === 'message').filter(event => !event.thinking).map(event => event.text).join(''), /LOCAL_AGENT_READ_OK/);
      assert.equal(run.actions(), 0, 'Policy dedup must not add any host action.');
      assert.equal(run.permissions.length, 0, 'Reading a granted attachment needs no mutation approval.');
      assert.deepEqual(await readdir(run.project), [], 'The read-only task must not create or change project files.');
      assert.equal(await readFile(run.selectedFile, 'utf8'), `${fixtureText}\n`);
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
