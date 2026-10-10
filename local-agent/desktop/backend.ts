import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentEvent, Mode, UtilityPreferences } from './renderer/types.ts';

export interface BackendOptions {
  executable: string;
  researchExecutable: string;
  bridgeExecutable: string;
  nodeExecutable: string;
  dataDirectory: string;
  cwd: string;
  mode: Mode;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextTokens: number;
  outputTokens: number;
  utilities: UtilityPreferences;
  grantedRoots: string[];
  grantedFiles: string[];
  actionUrl?: string;
  onEvent: (event: AgentEvent) => void;
}

const platformExtensions = ['analyze', 'todo', 'apps', 'chatrecall', 'extensionmanager',
  'scheduler', 'summon', 'summarize', 'code_execution', 'developer', 'orchestrator', 'tom', 'skills'];

/** No API keys, external Goose settings, proxies, or arbitrary model endpoints are inherited. */
export function backendEnvironment(options: BackendOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(options.baseUrl)) throw new Error('Inference must use the app-owned loopback endpoint.');
  return { ...env, GOOSE_PATH_ROOT: options.dataDirectory, GOOSE_PROVIDER: 'openai',
    GOOSE_MODEL: options.model, GOOSE_MODE: 'auto', GOOSE_TELEMETRY_OFF: '1', GOOSE_DISABLE_KEYRING: '1',
    GOOSE_CONTEXT_LIMIT: String(options.contextTokens), GOOSE_MAX_TURNS: '25',
    OPENAI_BASE_URL: `${options.baseUrl}/v1`, OPENAI_BASE_PATH: 'v1/chat/completions', OPENAI_API_KEY: options.apiKey,
    GOOSE_MAX_TOKENS: String(options.outputTokens),
    LOCAL_AGENT_MODE: options.mode, LOCAL_AGENT_GRANTED_ROOTS: JSON.stringify(options.grantedRoots),
    LOCAL_AGENT_UTILITIES: JSON.stringify(options.utilities),
    LOCAL_AGENT_TOOL_RESULT_CHARS: String(Math.min(4000, Math.floor(options.contextTokens / 2))),
    LOCAL_AGENT_GRANTED_FILES: JSON.stringify(options.grantedFiles),
    LOCAL_AGENT_ACTION_URL: options.actionUrl ?? '', ELECTRON_RUN_AS_NODE: '1',
  };
}

export class GooseBackend {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private gooseSessionId?: string;
  private stderr = '';
  private stopped = false;
  private options: BackendOptions;
  private stopPromise?: Promise<void>;
  private childClosed?: Promise<void>;
  constructor(options: BackendOptions) { this.options = options; }

  async start(): Promise<void> {
    const o = this.options;
    await mkdir(path.join(o.dataDirectory, 'config'), { recursive: true });
    if (this.stopped) throw new Error('Agent startup cancelled.');
    // Each turn has its own isolated configuration, and only our exact MCP servers.
    const config = { GOOSE_PROVIDER: 'openai', GOOSE_MODEL: o.model, GOOSE_MODE: 'auto',
      GOOSE_TELEMETRY_ENABLED: false, GOOSE_CONTEXT_LIMIT: o.contextTokens, CONTEXT_FILE_NAMES: [],
      extensions: Object.fromEntries(platformExtensions.map(name => [name,
        { type: 'platform', name, enabled: false }])) };
    // JSON is a valid YAML document; avoid interpolating YAML values.
    await writeFile(path.join(o.dataDirectory, 'config', 'config.yaml'), JSON.stringify(config), { mode: 0o600 });
    if (this.stopped) throw new Error('Agent startup cancelled.');
    this.child = spawn(o.executable, ['acp'], { cwd: o.cwd, env: backendEnvironment(o),
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32' });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-12_000); });
    this.childClosed = new Promise(resolve => {
      this.child!.once('close', () => resolve()); this.child!.once('error', () => resolve());
    });
    this.connection = new ClientSideConnection(() => ({
      sessionUpdate: async ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          o.onEvent({ type: 'message', text: update.content.text, role: 'assistant' });
        } else if (update.sessionUpdate === 'tool_call') {
          o.onEvent({ type: 'tool', id: update.toolCallId, title: update.title,
            status: update.status ?? 'pending', input: update.rawInput });
        } else if (update.sessionUpdate === 'tool_call_update') {
          o.onEvent({ type: 'tool', id: update.toolCallId, title: update.title ?? 'Tool',
            status: update.status ?? 'in_progress', output: update.rawOutput ?? update.content });
        }
      },
      // Goose has no direct write/terminal capability. Authoritative approvals happen in our MCP host.
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }), ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>));
    await this.withTimeout(this.connection.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'free-local-agent-desktop', version: '0.2.0-alpha.1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), 30_000);
    if (this.stopped) throw new Error('Agent startup cancelled.');
    const extensions: object[] = [{ type: 'mcp', timeout: 180,
      server: { name: 'local_files_and_research', command: o.researchExecutable, args: [], env: [] } }];
    if (o.mode === 'coding' && (o.utilities.fileEditing || o.utilities.terminal)) {
      extensions.push({ type: 'mcp', timeout: 900, server: { name: 'reviewed_actions',
        command: o.nodeExecutable, args: [o.bridgeExecutable], env: [] } });
    }
    const session = await this.withTimeout(this.connection.newSession({ cwd: o.cwd, mcpServers: [],
      _meta: { enabledExtensions: extensions, sessionTitle: 'Free Local Agent', client: 'free-local-agent' } }), 60_000);
    this.gooseSessionId = session.sessionId;
    const results = session._meta?.extensionResults;
    const expected = o.mode === 'coding' && (o.utilities.fileEditing || o.utilities.terminal) ? ['local_files_and_research', 'reviewed_actions'] : ['local_files_and_research'];
    if (!Array.isArray(results) || results.length !== expected.length || results.some(result =>
      !result || typeof result !== 'object' || result.success !== true || !expected.includes(String(result.name)))) {
      await this.stop();
      throw new Error(`Could not start the expected local tools: ${JSON.stringify(results)}`);
    }
    if (this.stopped) throw new Error('Agent startup cancelled.');
  }

  async prompt(text: string): Promise<void> {
    if (!this.connection || !this.gooseSessionId || this.stopped) throw new Error('Agent is not running.');
    await this.connection.prompt({ sessionId: this.gooseSessionId, prompt: [{ type: 'text', text }] });
  }

  async cancel(): Promise<void> {
    if (this.connection && this.gooseSessionId) {
      await Promise.race([this.connection.cancel({ sessionId: this.gooseSessionId }).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    await this.stop();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const child = this.child;
    this.stopPromise = (async () => {
    if (child && child.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
          killer.once('close', () => resolve()); killer.once('error', () => { child.kill(); resolve(); });
        });
      } else {
        let groupAlive = false;
        try { process.kill(-child.pid, 'SIGTERM'); groupAlive = true; } catch { child.kill('SIGTERM'); }
        if (groupAlive) {
          // Give sidecars time to close files, then finish any stubborn descendants before resolving.
          await Promise.race([this.childClosed, new Promise(resolve => setTimeout(resolve, 1500))]);
          try { process.kill(-child.pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      await Promise.race([this.childClosed, new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    })();
    return this.stopPromise;
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Local agent startup timed out. ${this.stderr.slice(-2000)}`)), milliseconds);
      })]);
    } catch (error) {
      await this.stop();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr.slice(-2000)}` : ''}`);
    } finally { clearTimeout(timer); }
  }
}
