import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createActionHost } from '../action-host.ts';
import { LocalActions, type ActionPermission } from '../actions.ts';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const body = (tool: string, args: Record<string, unknown>) => JSON.stringify({ tool, args });

async function setup(onPermission: (permission: ActionPermission) => Promise<boolean> = async () => false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-host-test-')));
  const projectPath = path.join(directory, 'project');
  await mkdir(projectPath);
  const controller = new AbortController();
  let toolEvents = 0;
  const actions = new LocalActions({ projectPath, historyDirectory: path.join(directory, 'history'), onPermission, onTool: () => toolEvents++ });
  const host = await createActionHost(actions, controller.signal);
  return {
    directory, projectPath, controller, host, actions, get toolEvents() { return toolEvents; },
    cleanup: async () => {
      controller.abort();
      await host.drain();
      host.server.closeAllConnections();
      await new Promise<void>((resolve) => host.server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function post(url: string, tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body(tool, args) });
}

test('unknown tokens, Origin headers and wrong methods are rejected before any tool', { timeout: 5000 }, async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const url = new URL(run.host.url);
    assert.equal(url.hostname, '127.0.0.1');
    const unknown = await post(`${url.origin}/${'0'.repeat(64)}`, 'write_file', { path: 'forbidden.txt', content: 'forbidden' });
    assert.equal(unknown.status, 403);
    for (const origin of ['https://example.com', 'null', '']) {
      const response = await post(run.host.url, 'write_file', { path: 'forbidden.txt', content: 'forbidden' }, { Origin: origin });
      assert.equal(response.status, 403);
    }
    assert.equal((await fetch(run.host.url)).status, 403);
    assert.equal(approvals, 0);
    assert.equal(run.toolEvents, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await run.cleanup(); }
});

test('a denied HTTP edit leaves the original file unchanged', { timeout: 5000 }, async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return false; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const response = await post(run.host.url, 'edit_file', { path: 'app.txt', old_text: 'before', new_text: 'after' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /denied/);
    assert.equal(permissions.length, 1);
    assert.match(permissions[0].preview!, /-before\n\+after/);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('Persian Unicode split inside UTF-8 codepoints is reviewed and written exactly', { timeout: 5000 }, async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return true; });
  try {
    const content = 'سلام دنیا 🌍\nاین متن باید دقیقاً حفظ شود.\n';
    const bytes = Buffer.from(body('write_file', { path: 'farsi.txt', content }));
    const split = bytes.findIndex((value) => value > 127) + 1;
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = request(run.host.url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
        incoming.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.write(bytes.subarray(0, split));
      setTimeout(() => {
        outgoing.write(bytes.subarray(split, split + 1));
        setTimeout(() => outgoing.end(bytes.subarray(split + 1)), 15);
      }, 15);
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).isError, undefined);
    assert.equal(permissions[0].arguments.content, content);
    assert.match(permissions[0].preview!, /سلام دنیا 🌍/);
    assert.equal(await readFile(path.join(run.projectPath, 'farsi.txt'), 'utf8'), content);
  } finally { await run.cleanup(); }
});

test('HTTP requests serialize so only one permission is pending at a time', { timeout: 5000 }, async () => {
  const permissions: Array<{ permission: ActionPermission; approve: (answer: boolean) => void }> = [];
  let firstPermission!: () => void;
  let secondPermission!: () => void;
  const firstShown = new Promise<void>((resolve) => { firstPermission = resolve; });
  const secondShown = new Promise<void>((resolve) => { secondPermission = resolve; });
  const run = await setup((permission) => new Promise<boolean>((resolve) => {
    permissions.push({ permission, approve: resolve });
    if (permissions.length === 1) firstPermission(); else secondPermission();
  }));
  try {
    const first = post(run.host.url, 'write_file', { path: 'first.txt', content: 'first' });
    await firstShown;
    const second = post(run.host.url, 'run_command', { command: 'exit 0' });
    await delay(80);
    assert.equal(permissions.length, 1);
    permissions[0].approve(true);
    const firstResult = await (await first).json();
    assert.equal(firstResult.isError, undefined);
    await secondShown;
    assert.equal(permissions.length, 2);
    assert.equal(permissions[1].permission.command, 'exit 0');
    permissions[1].approve(false);
    assert.equal((await (await second).json()).isError, true);
    await run.host.drain();
    assert.equal(await readFile(path.join(run.projectPath, 'first.txt'), 'utf8'), 'first');
  } finally { await run.cleanup(); }
});

test('a denied action stops queued and later writes or commands until a fresh turn', { timeout: 5000 }, async () => {
  let approvals = 0;
  let showPermission!: () => void;
  let deny!: (answer: boolean) => void;
  const shown = new Promise<void>(resolve => { showPermission = resolve; });
  const run = await setup(() => {
    approvals++;
    if (approvals > 1) return Promise.resolve(true);
    showPermission();
    return new Promise<boolean>(resolve => { deny = resolve; });
  });
  let nextHost: Awaited<ReturnType<typeof createActionHost>> | undefined;
  const nextController = new AbortController();
  try {
    const first = post(run.host.url, 'create_files', { files: [{ path: 'theme/style.css', content: 'first' }] });
    await shown;
    const queued = [
      post(run.host.url, 'run_command', { command: 'echo forbidden > command.txt' }),
      post(run.host.url, 'write_file', { path: 'write.txt', content: 'forbidden' }),
      post(run.host.url, 'create_files', { files: [{ path: 'theme/index.php', content: 'forbidden' }] }),
    ];
    await delay(50);
    assert.equal(approvals, 1);
    deny(false);
    assert.equal((await (await first).json()).errorCode, 'PERMISSION_DENIED');
    for (const response of await Promise.all(queued)) {
      const result = await response.json();
      assert.equal(result.errorCode, 'TURN_DENIED');
      assert.equal(result.isError, true);
    }
    const late = await (await post(run.host.url, 'edit_file', { path: 'unknown.txt', old_text: 'old', new_text: 'new' })).json();
    assert.equal(late.errorCode, 'TURN_DENIED');
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);

    // A new user turn creates a new host; it does not replay any denied call.
    nextHost = await createActionHost(run.actions, nextController.signal);
    const resumed = await (await post(nextHost.url, 'write_file', { path: 'new-request.txt', content: 'explicit new request' })).json();
    assert.equal(resumed.isError, undefined);
    assert.equal(approvals, 2);
    assert.deepEqual(await readdir(run.projectPath), ['new-request.txt']);
    assert.equal(await run.actions.undo(), 1);
  } finally {
    if (nextHost) {
      nextController.abort(); await nextHost.drain(); nextHost.server.closeAllConnections();
      await new Promise<void>(resolve => nextHost!.server.close(() => resolve()));
    }
    await run.cleanup();
  }
});

test('only an owned permission denial latches the turn and saved command logs stay readable', { timeout: 5000 }, async () => {
  let approvals = 0;
  const run = await setup(async () => ++approvals !== 3);
  try {
    const command = process.platform === 'win32' ? 'echo The user denied this action. No action was taken. & exit /b 1'
      : "printf 'The user denied this action. No action was taken.'; exit 1";
    const output = await (await post(run.host.url, 'run_command', { command })).json();
    assert.equal(output.isError, true);
    assert.equal(output.errorCode, undefined, 'Untrusted command text must not set the denial identity.');
    const logId = output.content[0].text.match(/Saved command log: ([a-f0-9-]+)/)[1];
    const allowed = await (await post(run.host.url, 'write_file', { path: 'allowed.txt', content: 'approved' })).json();
    assert.equal(allowed.isError, undefined);
    const denied = await (await post(run.host.url, 'run_command', { command: 'exit 0' })).json();
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
    const log = await (await post(run.host.url, 'read_command_output', { id: logId })).json();
    assert.equal(log.isError, undefined);
    assert.match(JSON.parse(log.content[0].text).text, /The user denied this action/);
    const blocked = await (await post(run.host.url, 'write_file', { path: 'blocked.txt', content: 'blocked' })).json();
    assert.equal(blocked.errorCode, 'TURN_DENIED');
    assert.equal(approvals, 3);
    assert.deepEqual(await readdir(run.projectPath), ['allowed.txt']);
    assert.equal(await run.actions.undo(), 1, 'Undo remains available outside the stopped turn.');
  } finally { await run.cleanup(); }
});

test('abort cancels the pending action and queued action without a second approval', { timeout: 5000 }, async () => {
  let approvals = 0;
  let firstPermission!: () => void;
  const firstShown = new Promise<void>((resolve) => { firstPermission = resolve; });
  const run = await setup(() => { approvals++; firstPermission(); return new Promise<boolean>(() => {}); });
  try {
    const first = post(run.host.url, 'write_file', { path: 'first.txt', content: 'first' });
    await firstShown;
    const second = post(run.host.url, 'write_file', { path: 'second.txt', content: 'second' });
    await delay(80);
    run.controller.abort();
    const responses = await Promise.all([first, second]);
    for (const response of responses) assert.equal((await response.json()).isError, true);
    await run.host.drain();
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal((await post(run.host.url, 'write_file', { path: 'late.txt', content: 'late' })).status, 403);
  } finally { await run.cleanup(); }
});

test('malformed and unknown actions return MCP errors without approval', { timeout: 5000 }, async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const unknown = await post(run.host.url, 'delete_file', { path: 'app.txt' });
    assert.equal((await unknown.json()).isError, true);
    const malformed = await fetch(run.host.url, { method: 'POST', body: 'not-json' });
    assert.equal((await malformed.json()).isError, true);
    assert.equal(approvals, 0);
  } finally { await run.cleanup(); }
});

test('drain completes after aborting a request that never finishes its body', { timeout: 5000 }, async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  let outgoing: ReturnType<typeof request> | undefined;
  try {
    const closed = new Promise<void>((resolve) => {
      outgoing = request(run.host.url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      outgoing.on('error', () => resolve());
      outgoing.on('close', () => resolve());
      outgoing.write('{"tool":"write_file",');
    });
    await delay(30);
    run.controller.abort();
    await run.host.drain();
    await closed;
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { outgoing?.destroy(); await run.cleanup(); }
});

const bridgePath = fileURLToPath(new URL('../../../dist/action-bridge.cjs', import.meta.url));
test('packaged MCP stdio bridge routes an edit through the real host and obeys denial', { timeout: 15000, skip: !existsSync(bridgePath) && 'Run npm run build before testing the bundled MCP bridge.' }, async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return false; });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], env: { LOCAL_AGENT_ACTION_URL: run.host.url }, stderr: 'pipe' });
  const client = new Client({ name: 'local-agent-bridge-test', version: '0.1.0' });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['create_files', 'edit_file', 'read_command_output', 'run_command', 'write_file']);
    const result = await client.callTool({ name: 'edit_file', arguments: { path: 'app.txt', old_text: 'before', new_text: 'after' } });
    assert.equal(result.isError, true);
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await client.close(); await transport.close(); await run.cleanup(); }
});

test('bundled MCP bridge creates a complete reviewed scaffold in an empty project and verifies it', { timeout: 15000, skip: !existsSync(bridgePath) && 'Build the bundled MCP bridge first.' }, async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], env: {
    LOCAL_AGENT_ACTION_URL: run.host.url, LOCAL_AGENT_UTILITIES: JSON.stringify({ fileEditing: true, terminal: true }),
  }, stderr: 'pipe' });
  const client = new Client({ name: 'local-agent-scaffold-test', version: '0.3.0' });
  const files = [
    { path: 'wp-content/themes/test-theme/style.css', content: '/* Theme Name: تست محلی 🌍 */\n' },
    { path: 'wp-content/themes/test-theme/index.php', content: '<?php echo "Local scaffold"; ?>\n' },
    { path: 'wp-content/themes/test-theme/functions.php', content: '<?php /* Theme functions */\n' },
  ];
  try {
    await client.connect(transport);
    assert.deepEqual(await readdir(run.projectPath), []);
    const created = await client.callTool({ name: 'create_files', arguments: { files } });
    assert.equal(created.isError, undefined);
    assert.equal(permissions.length, 1);
    for (const file of files) {
      assert.equal(await readFile(path.join(run.projectPath, file.path), 'utf8'), file.content);
      assert.ok(permissions[0].preview!.includes(`+++ ${file.path}`));
    }
    assert.ok(permissions[0].preview!.includes('تست محلی 🌍'));
    const command = process.platform === 'win32' ? 'if exist functions.php (echo SCAFFOLD_OK) else (exit /b 1)' : 'test -f functions.php && test -f style.css && test -f index.php && printf SCAFFOLD_OK';
    const checked = await client.callTool({ name: 'run_command', arguments: { command, cwd: 'wp-content/themes/test-theme' } });
    assert.equal(checked.isError, undefined);
    assert.ok(JSON.stringify(checked.content).includes('SCAFFOLD_OK'));
    assert.equal(permissions.length, 2);
    assert.equal(await run.actions.undo(), 3);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await client.close(); await transport.close(); await run.cleanup(); }
});

test('MCP bridge excludes batch creation when file editing is disabled', { timeout: 15000, skip: !existsSync(bridgePath) && 'Build the bundled MCP bridge first.' }, async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], env: {
    LOCAL_AGENT_ACTION_URL: run.host.url, LOCAL_AGENT_UTILITIES: JSON.stringify({ fileEditing: false, terminal: true }),
  }, stderr: 'pipe' });
  const client = new Client({ name: 'local-agent-disabled-create-test', version: '0.3.0' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['read_command_output', 'run_command']);
    const denied = await client.callTool({ name: 'create_files', arguments: { files: [{ path: 'no.txt', content: 'disabled' }] } });
    assert.equal(denied.isError, true);
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await client.close(); await transport.close(); await run.cleanup(); }
});
