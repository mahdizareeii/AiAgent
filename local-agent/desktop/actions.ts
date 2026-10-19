import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { cancelledActionText, commandTimeoutLimits, commandTimeoutText, interruptedTurnText } from './action-protocol.ts';
import type { ApprovalUtility } from './renderer/types.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CREATE_FILES = 20;
const MAX_CREATE_BYTES = 512 * 1024;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const COMMAND_LOG_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMMAND_LOG_HANDLE = /^log-([a-f0-9]{8})$/;
export const repeatedEditFailureText = 'Two identical edits failed against unchanged file content. This turn stopped before any further mutation. Report the blocker using saved readback evidence; completed actions must not be repeated.';
export const repeatedCommandReadFailureText = 'Two identical command-log reads failed without any change in available logs. This turn stopped to prevent a read loop. Completed actions are preserved; no commands or file edits will be automatically repeated. Use saved file readback or the exact log id from run_command in a new task.';

export interface ActionPermission {
  requestId: string;
  title: string;
  arguments: Record<string, unknown>;
  preview?: string;
  command?: string;
  cwd?: string;
  /** Workspace identity used by the host's persisted approval policy. */
  workspacePath?: string;
  utility?: ApprovalUtility;
  alwaysApproveAllowed?: boolean;
}

export interface ActionToolEvent {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
}

export interface ActionResult {
  content: Array<{ type: 'text'; text: string }>;
  /** Host-verified file mutation evidence, also included in the model text. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Host-owned error identity; never inferred from model or command text. */
  errorCode?: string;
}

interface CommandOutcome extends ActionResult { outputBytes: number; previewBytes: number; exitCode: number | null; exitSignal: NodeJS.Signals | null; }

export interface LocalActionsOptions {
  projectPath: string;
  historyDirectory: string;
  onPermission: (permission: ActionPermission, signal?: AbortSignal) => Promise<boolean>;
  onTool?: (event: ActionToolEvent) => void;
  /** Host-only freshness boundary, before any potential effect/approval and finally on settlement. */
  onReadbackEffect?: (event: { id: string; operation: string; phase: 'begin' | 'settled' }) => void;
  resultChars?: number;
  utilities?: { fileEditing: boolean; terminal: boolean };
  verificationCheckIds?: readonly string[];
  /** Exact command criteria from the current frozen host brief; never model arguments. */
  frozenVerification?: { turnId: string; requestHash: string; workspacePath: string; signal: AbortSignal;
    commands: readonly { id: string; kind: 'command'; command: string; cwd: string }[] };
  onBeforeVerificationCommand?: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
  /** App-owned policy, never a model argument or an approval grant. */
  networkAccess?: 'local-only';
}

interface FileVersion { content: string | null; hash: string | null; device: number | null; inode: number | null; mode: number; }
interface Target { root: string; absolute: string; relative: string; }
interface Snapshot {
  version: 1;
  id: string;
  createdAt: string;
  projectPath: string;
  relativePath: string;
  before: string | null;
  beforeHash: string | null;
  afterHash: string;
  mode: number;
  applied: boolean;
  undone: boolean;
  groupId?: string;
  createdDirectories?: string[];
}

class ActionError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) { super(message); this.name = 'ActionError'; this.code = code; this.details = details; }
}

const result = (text: string, isError = false): ActionResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
const mutationResult = (text: string, evidence: Record<string, unknown>): ActionResult => ({
  content: [{ type: 'text', text: `${JSON.stringify(evidence)}\n${text}` }], structuredContent: evidence,
});
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const cancelled = () => new ActionError('CANCELLED', cancelledActionText);
const contained = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

export const LOCAL_ONLY_COMMAND_PROFILE = '(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))';
const proxyEnvironmentNames = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'node_use_env_proxy']);
/** Prevent inherited forwarding settings from routing an approved local-only command through a proxy. */
export function localOnlyCommandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !proxyEnvironmentNames.has(name.toLowerCase())));
}
export async function localOnlyCommandLaunch(command: string, platform: NodeJS.Platform = process.platform): Promise<{ executable: string; args: string[] }> {
  if (platform !== 'darwin') throw new ActionError('LOCAL_NETWORK_POLICY_UNAVAILABLE', 'Local-only commands require the supported macOS network policy. No command was run; there is no unrestricted fallback.');
  const executable = '/usr/bin/sandbox-exec';
  try {
    const info = await lstat(executable);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || await realpath(executable) !== executable) throw new Error('The system policy executable is not trusted.');
    await access(executable, constants.X_OK);
  } catch (error) { throw new ActionError('LOCAL_NETWORK_POLICY_UNAVAILABLE', 'The trusted macOS network policy executable is unavailable. No command was run; there is no unrestricted fallback.', { cause: error instanceof Error ? error.message : String(error) }); }
  return { executable, args: ['-p', LOCAL_ONLY_COMMAND_PROFILE, '/bin/sh', '-c', command] };
}

function assertSafeName(relative: string): void {
  for (const component of relative.split(/[\\/]/)) {
    if (/^(?:\.git|\.ssh|\.aws|\.gnupg)$/i.test(component) || /^\.env(?:\.|$)/i.test(component) || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(component) || /\.(?:pem|key|p12|pfx)$/i.test(component) || /(?:^|[._-])(?:secrets?|tokens?|credentials|passwords?)(?:[._-]|$)/i.test(component)) {
      throw new ActionError('PROTECTED_PATH', 'The agent cannot modify Git internals, environment files, credentials, tokens, or private key files.');
    }
  }
}

function textArgument(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new ActionError('INVALID_ARGUMENT', `${key} must be ${allowEmpty ? 'a' : 'a non-empty'} string.`);
  if (value.includes('\0')) throw new ActionError('INVALID_ARGUMENT', `${key} must not contain NUL bytes.`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ActionError('INVALID_ARGUMENT', `${key} must contain valid Unicode that can be encoded exactly as UTF-8.`);
  return value;
}

/** A precise changed-region diff; unchanged prefix/suffix lines are omitted. */
function diffPreview(relative: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  return [`--- ${before === null ? '/dev/null' : relative}`, `+++ ${relative}`, `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join('\n');
}

export const ACTION_TOOL_SCHEMAS = [
  { name: 'edit_file', description: 'Propose one exact text replacement in a project file. Copy old_text from read_file.text exactly, preserving whitespace, BOM and line endings; locations are separate metadata. Never add/remove line-number prefixes. Two identical failed edits against unchanged content stop mutations for this turn. The user reviews a diff and approves before any file changes. Result reports changed/unchanged and the verified SHA-256.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } },
  { name: 'write_file', description: 'Propose creating or replacing a project text file. The user reviews a diff and approves before any file changes.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'create_files', description: 'Propose 1–20 new project text files in one reviewed batch. Parent folders are created automatically; existing files cannot be replaced. Total content <=512 KiB. One approval shows every file and grouped undo is available.', inputSchema: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }, required: ['files'], additionalProperties: false } },
  { name: 'run_verification', description: 'For frozen acceptance commands, use run_verification with exactly one command criterion check_id from the current frozen task brief. The host supplies its exact command and cwd; do not retype paths or shell quoting. The normal command approval, timeout, local network policy and verification ledger still apply; the ID grants no permission. Unknown, manual and file/preservation IDs cannot execute. Commands are never automatically replayed after denial, interruption or task resume.', inputSchema: { type: 'object', properties: { check_id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' }, timeout_ms: { type: 'integer', ...commandTimeoutLimits } }, required: ['check_id'], additionalProperties: false } },
  { name: 'run_command', description: 'Propose an implementation or debugging shell command in the project. For frozen acceptance, use run_verification with one command check_id; implementation receipts do not satisfy acceptance. Legacy exact verification command/cwd/purpose/checkIds remain supported. The user approves its exact command, working directory and time limit; verification metadata grants no permission. timeout_ms defaults to 60000; explicitly select up to 600000 for dependency setup. Result metadata gives log_id, output_complete and next_offset; when output_complete is true, use the shown output without another log read. Interrupted commands preserve partial work and are never automatically repeated. This is not an operating-system sandbox; approved commands have the user account’s access.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, purpose: { type: 'string', enum: ['implementation', 'verification'] }, checkIds: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' } }, timeout_ms: { type: 'integer', ...commandTimeoutLimits, description: 'Approved execution time limit in milliseconds, 100–600000; default 60000. Longer dependency setup requires an explicit value.' } }, required: ['command'], additionalProperties: false } },
] as const;

/**
 * The host owns UI permission responses. Approval is checked in application
 * code for every mutation or command, never inferred from the model's text.
 * Commands run with user-account permissions and are not OS-sandboxed.
 */
export class LocalActions {
  private options: LocalActionsOptions;
  private verificationScope?: { turnId: string; requestHash: string; workspacePath: string; signal: AbortSignal };
  private verificationCommands = new Map<string, Readonly<{ id: string; kind: 'command'; command: string; cwd: string }>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private failingEdits = new Map<string, number>();
  private editLoopStopped = false;
  private failingCommandReads = new Map<string, { reference: string; availability: string; attempts: number }>();
  private commandReadLoopStopped = false;

  constructor(options: LocalActionsOptions) {
    if (!path.isAbsolute(options.projectPath) || !path.isAbsolute(options.historyDirectory)) throw new ActionError('INVALID_PATH', 'Project and history directories must be absolute paths.');
    this.options = { ...options, verificationCheckIds: options.verificationCheckIds ? Object.freeze([...options.verificationCheckIds]) : undefined };
    const frozen = options.frozenVerification;
    if (frozen) {
      if (typeof frozen.turnId !== 'string' || !frozen.turnId.trim() || frozen.turnId.length > 256 || frozen.turnId.includes('\0')
        || !/^[a-f0-9]{64}$/.test(frozen.requestHash) || frozen.workspacePath !== options.projectPath || !path.isAbsolute(frozen.workspacePath)
        || !(frozen.signal instanceof AbortSignal) || !Array.isArray(frozen.commands) || frozen.commands.length > 12)
        throw new ActionError('INVALID_ARGUMENT', 'Frozen verification requires the exact selected workspace, current task identity and bound turn signal.');
      for (const row of frozen.commands) {
        if (!row || row.kind !== 'command' || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(row.id) || this.verificationCommands.has(row.id)
          || typeof row.command !== 'string' || !row.command.trim() || row.command.length > 8192 || row.command.includes('\0')
          || Buffer.from(row.command,'utf8').toString('utf8') !== row.command || typeof row.cwd !== 'string' || !row.cwd.trim() || row.cwd.length > 1024
          || row.cwd.includes('\0') || path.isAbsolute(row.cwd) || row.cwd.split(/[\\/]/).includes('..'))
          throw new ActionError('INVALID_ARGUMENT', 'Frozen verification accepts only unique current command criteria and their exact bounded command/cwd.');
        this.verificationCommands.set(row.id,Object.freeze({ id:row.id,kind:'command',command:row.command,cwd:row.cwd }));
      }
      if (JSON.stringify([...this.verificationCommands.keys()]) !== JSON.stringify(this.options.verificationCheckIds ?? []))
        throw new ActionError('INVALID_ARGUMENT', 'Frozen command IDs must exactly match the current command verification ledger.');
      this.verificationScope=Object.freeze({turnId:frozen.turnId,requestHash:frozen.requestHash,workspacePath:frozen.workspacePath,signal:frozen.signal});
    }
    // Retain only the private immutable projection, never the caller's mutable map.
    delete this.options.frozenVerification;
  }

  private verificationArguments(args:Record<string,unknown>):Record<string,unknown>{
    const allowed=[...this.verificationCommands.keys()], guidance=`Allowed current frozen command check_ids: ${JSON.stringify(allowed)}. Use run_verification with exactly one check_id; manual/file/preservation criteria cannot execute.`;
    if(!this.verificationScope)throw new ActionError('INVALID_ARGUMENT',`No current frozen command map is bound. ${guidance}`);
    if(Object.keys(args).some(key=>!['check_id','timeout_ms'].includes(key)))throw new ActionError('INVALID_ARGUMENT',`Only check_id and optional timeout_ms are accepted; command/cwd/purpose/checkIds overrides are forbidden. ${guidance}`);
    if(typeof args.check_id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.check_id))throw new ActionError('INVALID_ARGUMENT',`check_id must be one exact frozen command ID. ${guidance}`);
    const checkId=args.check_id;const criterion=this.verificationCommands.get(checkId);
    if(!criterion)throw new ActionError('INVALID_ARGUMENT',`Unknown or non-command check_id. ${guidance}`);
    const original=Object.freeze({check_id:checkId,...(args.timeout_ms!==undefined?{timeout_ms:args.timeout_ms}:{})});
    return {command:criterion.command,cwd:criterion.cwd,purpose:'verification',checkIds:[checkId],...(args.timeout_ms!==undefined?{timeout_ms:args.timeout_ms}:{}),
      verification_intent:Object.freeze({tool:'run_verification',arguments:original,turnId:this.verificationScope.turnId,requestHash:this.verificationScope.requestHash,workspacePath:this.verificationScope.workspacePath})};
  }
  /** Guidance only: never infers a criterion or changes command/receipt metadata. */
  private verificationRecoveryGuidance():string{
    const legacy='Legacy verification requires purpose:"verification", nonempty matching checkIds and the exact frozen command/cwd. Implementation command receipts do not satisfy acceptance.';
    if(!this.verificationScope)return `No command ran. ${legacy} No current frozen ID map is bound.`;
    if(this.verificationScope.signal.aborted)return 'This frozen task is closed. No command ran; start a new task rather than replaying old actions.';
    const ids=[...this.verificationCommands.keys()];
    if(!ids.length)return `No executable frozen command criteria are available in this task. No command ran. Implementation command receipts do not satisfy acceptance; file/manual/preservation IDs cannot run commands.`;
    return `For frozen acceptance, call run_verification(${JSON.stringify({check_id:ids[0]})}) (example using one current command ID; choose the criterion being verified). Allowed current command check_ids: ${JSON.stringify(ids)}. The host supplies exact command/cwd and requests approval. No command ran for this rejected request. ${legacy}`;
  }

  /** Reject a single implementation spelling mistake; never repair or execute it. */
  private rejectQuoteStrippedFrozenCommand(command:string,cwd:string):void{
    if(process.platform==='win32'||!this.verificationScope||this.verificationScope.signal.aborted)return;
    const rows=[...this.verificationCommands.values()].filter(row=>row.cwd===cwd);
    if(rows.some(row=>row.command===command))return;
    const matches=rows.filter(row=>{
      const frozen=row.command,quote=frozen[0];if(quote!=="'"&&quote!=='"')return false;
      const close=frozen.indexOf(quote,1);if(close<0)return false;
      const executable=frozen.slice(1,close),suffix=frozen.slice(close+1);
      if(!path.isAbsolute(executable)||!executable.includes(' ')||executable.trim()!==executable||
        [...executable].some(char=>!/[\p{L}\p{N}]/u.test(char)&&!'/ ._:-'.includes(char)))return false;
      // Deliberately narrow POSIX words: unknown quoting, escapes, expansions,
      // shell operators, cwd aliases and near matches keep their normal path.
      if(![' ','\t'].includes(suffix[0])||!suffix.trim()||
        [...suffix].some(char=>!/[A-Za-z0-9]/.test(char)&&!' \t_./:@%+=,-'.includes(char)))return false;
      return command===executable+suffix;
    });
    if(matches.length!==1)return;
    const checkId=matches[0].id;
    throw new ActionError('INVALID_ARGUMENT',`This looks like frozen command ${JSON.stringify(checkId)} with the executable's quotes removed. No command ran. For that frozen command, call run_verification(${JSON.stringify({check_id:checkId})}). This also works when the first check is expected to fail. The host supplies the exact command/cwd and requests normal approval. Allowed current command check_ids: ${JSON.stringify([...this.verificationCommands.keys()])}.`);
  }

  async execute(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<ActionResult> {
    const id = randomUUID();
    const title = tool === 'run_command' || tool === 'run_verification' ? 'Run command' : tool === 'read_command_output' ? 'Read command output' : tool === 'create_files' ? 'Create project files' : tool === 'edit_file' ? 'Edit file' : 'Write file';
    const signal=this.verificationScope?AbortSignal.any([this.verificationScope.signal,...(options.signal?[options.signal]:[])]):options.signal;
    const effect = tool !== 'read_command_output';
    let effectStarted = false;
    try {
      if (effect) { effectStarted = true; this.options.onReadbackEffect?.({ id, operation: tool, phase: 'begin' }); }
      if(tool==='run_verification')args=this.verificationArguments(args);
      else if(args.verification_intent!==undefined)throw new ActionError('INVALID_ARGUMENT','verification_intent is reserved for a host-expanded frozen ID action.');
      this.options.onTool?.({ id, title, status: 'pending', input: args });
      if (signal?.aborted) throw cancelled();
      if (this.commandReadLoopStopped) throw new ActionError('LOG_READ_LOOP_STOPPED', repeatedCommandReadFailureText);
      if (this.editLoopStopped && tool !== 'read_command_output') throw new ActionError('EDIT_LOOP_STOPPED', 'This turn stopped after two identical failed edits. No further file changes or commands may run. Report the observed blocker and use a new task for an explicitly revised action.');
      let output: ActionResult;
      if (tool === 'read_command_output') output = await this.readCommandOutput(args);
      else if (tool === 'run_command' || tool === 'run_verification') {
        if (this.options.utilities?.terminal === false) throw new ActionError('DISABLED_TOOL', 'Terminal commands are disabled.');
        output = await this.runCommand(id, args, signal);
      }
      else if (tool === 'create_files') {
        if (this.options.utilities?.fileEditing === false) throw new ActionError('DISABLED_TOOL', 'File editing is disabled.');
        output = await this.serial(() => this.createFiles(id, args, signal), true);
      }
      else if (tool === 'edit_file' || tool === 'write_file') {
        if (this.options.utilities?.fileEditing === false) throw new ActionError('DISABLED_TOOL', 'File editing is disabled.');
        // Serialize edits and undo, including approval, so approved previews
        // cannot race another app action. External changes are rechecked too.
        output = await this.serial(() => this.writeFile(tool, id, args, signal), true);
      } else throw new ActionError('UNKNOWN_TOOL', `Unknown action tool: ${tool}`);
      this.options.onTool?.({ id, title, status: output.isError ? 'failed' : 'completed', input: args, output });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The action failed.';
      const output = result(message, true);
      if (error instanceof ActionError) {
        output.errorCode = error.code;
        if (error.details) {
          output.structuredContent = { ok: false, error: error.code, ...error.details };
          output.content.push({ type: 'text', text: JSON.stringify(output.structuredContent) });
        }
      }
      this.options.onTool?.({ id, title, status: 'failed', input: args, output });
      return output;
    } finally {
      if (effectStarted) this.options.onReadbackEffect?.({ id, operation: tool, phase: 'settled' });
    }
  }

  private serial<T>(task: () => Promise<T>, agentMutation = false): Promise<T> {
    const queued = this.mutationQueue.catch(() => undefined).then(() => {
      if (agentMutation) this.assertAgentMutationAllowed();
      return task();
    });
    this.mutationQueue = queued;
    return queued;
  }

  private assertAgentMutationAllowed(): void {
    if (this.commandReadLoopStopped) throw new ActionError('LOG_READ_LOOP_STOPPED', repeatedCommandReadFailureText);
    if (this.editLoopStopped) throw new ActionError('EDIT_LOOP_STOPPED', 'This turn stopped after two identical failed edits. No action was taken.');
  }

  private async target(file: string, directory = false): Promise<Target> {
    const root = await realpath(this.options.projectPath);
    if (root !== path.resolve(this.options.projectPath)) throw new ActionError('INVALID_PROJECT', 'The selected project folder changed. Choose its actual folder again.');
    if (!(await lstat(root)).isDirectory()) throw new ActionError('INVALID_PROJECT', 'The selected project is not a directory.');
    const absolute = path.resolve(root, file);
    if (!contained(root, absolute) || (!directory && absolute === root)) throw new ActionError('OUTSIDE_PROJECT', 'This action must stay inside the selected project folder.');
    const relative = path.relative(root, absolute);
    assertSafeName(relative);
    // Refuse symlink components even when currently pointing inward. This
    // gives predictable atomic-rename semantics and catches swapped parents.
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new ActionError('SYMLINK_PATH', 'File actions cannot follow symlinks. Select the actual project file instead.');
        const canonical = await realpath(current);
        if (!contained(root, canonical)) throw new ActionError('OUTSIDE_PROJECT', 'The path resolves outside the selected project.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (directory && !(await lstat(absolute)).isDirectory()) throw new ActionError('INVALID_DIRECTORY', 'The command working directory must be an existing project directory.');
    return { root, absolute, relative };
  }

  private async fileVersion(absolute: string): Promise<FileVersion> {
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw new ActionError('INVALID_FILE', 'Select a regular text file.');
      if (info.size > MAX_FILE_BYTES) throw new ActionError('FILE_TOO_LARGE', 'File actions support text files up to 2 MB.');
      const bytes = await readFile(absolute);
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new ActionError('INVALID_FILE', 'File actions support regular text files up to 2 MB.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ActionError('INVALID_FILE', 'File actions require valid UTF-8 text.'); }
      if (PRIVATE_KEY.test(content)) throw new ActionError('PROTECTED_CONTENT', 'The agent cannot modify a file containing a private key.');
      return { content, hash: hash(content), device: info.dev, inode: info.ino, mode: info.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, hash: null, device: null, inode: null, mode: 0o600 };
      throw error;
    }
  }

  private async permission(permission: ActionPermission, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelled();
    this.assertAgentMutationAllowed();
    let onAbort: (() => void) | undefined;
    const decision = this.options.onPermission(permission, signal);
    try {
      const approved = signal ? await Promise.race([decision, new Promise<never>((_, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); })]) : await decision;
      if (signal?.aborted) throw cancelled();
      if (approved !== true) throw new ActionError('PERMISSION_DENIED', 'The user denied this action. No action was taken.');
      this.assertAgentMutationAllowed();
    } finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }

  private async atomicWrite(absolute: string, content: string, mode: number, signal?: AbortSignal): Promise<void> {
    const temporary = path.join(path.dirname(absolute), `.local-agent-${randomUUID()}.tmp`);
    try {
      if (signal?.aborted) throw cancelled();
      await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
      if (signal?.aborted) throw cancelled();
      await rename(temporary, absolute);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  /** Publish a complete new file without overwriting a target created in a race. */
  private async atomicCreate(absolute: string, content: string, signal?: AbortSignal): Promise<void> {
    const temporary = path.join(path.dirname(absolute), `.local-agent-${randomUUID()}.tmp`);
    try {
      if (signal?.aborted) throw cancelled();
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (signal?.aborted) throw cancelled();
      try { await link(temporary, absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ActionError('STALE_PREVIEW', 'A file appeared before the approved creation. No existing file was overwritten.');
        throw error;
      }
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async createParents(target: Target, created: string[], signal?: AbortSignal): Promise<void> {
    let current = target.root;
    for (const component of path.relative(target.root, path.dirname(target.absolute)).split(path.sep).filter(Boolean)) {
      if (signal?.aborted) throw cancelled();
      current = path.join(current, component);
      await this.target(target.relative);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ActionError('INVALID_DIRECTORY', 'A project file parent is not a regular directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(current, { mode: 0o755 }); created.push(path.relative(target.root, current)); }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      }
      await this.target(target.relative);
    }
  }

  private async removeEmptyDirectories(directories: string[]): Promise<void> {
    for (const directory of [...new Set(directories)].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
      if (!directory || directory === '.' || path.isAbsolute(directory)) continue;
      try {
        const target = await this.target(directory, true);
        if (target.relative) await rmdir(target.absolute);
      } catch { /* Preserve non-empty, changed, protected, or externally removed directories. */ }
    }
  }

  private async createFiles(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > MAX_CREATE_FILES) throw new ActionError('INVALID_ARGUMENT', 'files must contain between 1 and 20 {path, content} entries.');
    const planned: { target: Target; content: string; snapshot: Snapshot }[] = [];
    let totalBytes = 0;
    for (const row of args.files) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['path', 'content'].includes(key))) throw new ActionError('INVALID_ARGUMENT', 'Each file must contain only path and content.');
      const file = textArgument(row, 'path');
      if (file.length > 1024) throw new ActionError('INVALID_ARGUMENT', 'Project file paths must be at most 1024 characters.');
      const content = textArgument(row, 'content', true);
      totalBytes += Buffer.byteLength(content, 'utf8');
      if (totalBytes > MAX_CREATE_BYTES) throw new ActionError('FILES_TOO_LARGE', 'A creation batch supports at most 512 KiB of text. Split larger scaffolds into reviewed batches.');
      if (PRIVATE_KEY.test(content)) throw new ActionError('PROTECTED_CONTENT', 'The agent cannot write private keys.');
      const target = await this.target(file);
      const normalized = (name: string) => ['win32', 'darwin'].includes(process.platform) ? name.toLowerCase() : name;
      const key = normalized(target.absolute);
      if (planned.some(item => contained(normalized(item.target.absolute), key) || contained(key, normalized(item.target.absolute)))) throw new ActionError('CONFLICTING_PATHS', 'File paths must be distinct and cannot also be another file’s parent directory.');
      if ((await this.fileVersion(target.absolute)).content !== null) throw new ActionError('FILE_EXISTS', `${target.relative} already exists. Use write_file or edit_file to review a replacement.`);
      planned.push({ target, content, snapshot: { version: 1, id: randomUUID(), groupId: id, createdAt: new Date().toISOString(), projectPath: target.root,
        relativePath: target.relative, before: null, beforeHash: null, afterHash: hash(content), mode: 0o600, applied: false, undone: false } });
    }
    await this.permission({ requestId: id, title: `Create ${planned.length} project ${planned.length === 1 ? 'file' : 'files'}`,
      arguments: { ...args, files: planned.map(item => ({ path: item.target.relative, content: item.content })) }, preview: planned.map(item => diffPreview(item.target.relative, null, item.content)).join('\n\n'), workspacePath: planned[0].target.root,
      utility: 'fileEditing', alwaysApproveAllowed: true }, signal);
    for (const item of planned) {
      const checked = await this.target(item.target.relative);
      if (checked.root !== item.target.root || (await this.fileVersion(checked.absolute)).content !== null) throw new ActionError('STALE_PREVIEW', 'A project file appeared while approval was pending. Review a fresh creation batch.');
    }
    const createdDirectories: string[] = [];
    const applied: typeof planned = [];
    try {
      if (signal?.aborted) throw cancelled();
      await mkdir(this.options.historyDirectory, { recursive: true, mode: 0o700 });
      for (const item of planned) {
        if (signal?.aborted) throw cancelled();
        const snapshotFile = path.join(this.options.historyDirectory, `${item.snapshot.id}.json`);
        await this.atomicWrite(snapshotFile, JSON.stringify(item.snapshot), 0o600);
        await this.createParents(item.target, createdDirectories, signal);
        await this.target(item.target.relative);
        this.options.onTool?.({ id, title: `Create ${item.target.relative}`, status: 'running', input: { path: item.target.relative } });
        await this.atomicCreate(item.target.absolute, item.content, signal);
        item.snapshot.applied = true; applied.push(item);
        await this.atomicWrite(snapshotFile, JSON.stringify(item.snapshot), 0o600);
      }
      if (signal?.aborted) throw cancelled();
      for (const item of applied) {
        item.snapshot.createdDirectories = [...createdDirectories];
        await this.atomicWrite(path.join(this.options.historyDirectory, `${item.snapshot.id}.json`), JSON.stringify(item.snapshot), 0o600);
      }
      if (signal?.aborted) throw cancelled();
      const names = planned.map(item => item.target.relative).join('\n');
      const allowance = Math.max(256, this.options.resultChars ?? 2000);
      const files = [];
      for (const item of planned) {
        const verified = await this.fileVersion(item.target.absolute);
        if (verified.hash !== item.snapshot.afterHash) throw new ActionError('VERIFICATION_FAILED', `${item.target.relative} changed before its write could be verified. Inspect the actual file; do not repeat this creation batch.`);
        files.push({ path: item.target.relative, changed: true, sha256: verified.hash, bytes: Buffer.byteLength(verified.content!, 'utf8') });
      }
      return mutationResult(`Created ${planned.length} project files. One undo restores this creation batch. If file reading is enabled, verify the files with read_file using their saved paths. File edits do not create command logs.\n${names.slice(0, allowance)}${names.length > allowance ? '\n[File list shortened; every path was included in approval.]' : ''}`, {
        ok: true, operation: 'create_files', status: 'changed', changed: true, action_id: id, files,
      });
    } catch (error) {
      for (const item of [...applied].reverse()) {
        try {
          const checked = await this.target(item.target.relative);
          if ((await this.fileVersion(checked.absolute)).hash !== item.snapshot.afterHash) continue;
          await unlink(checked.absolute); item.snapshot.undone = true;
          await this.atomicWrite(path.join(this.options.historyDirectory, `${item.snapshot.id}.json`), JSON.stringify(item.snapshot), 0o600);
        } catch { /* An externally changed file remains available for reviewed undo. */ }
      }
      await this.removeEmptyDirectories(createdDirectories);
      throw error;
    }
  }

  private failedEdit(target: Target, before: FileVersion, oldText: string, newText: string, code: string, message: string): never {
    const key = hash(JSON.stringify([target.absolute, before.hash, oldText, newText]));
    const attempts = (this.failingEdits.get(key) ?? 0) + 1;
    if (this.failingEdits.size >= 128 && !this.failingEdits.has(key)) this.failingEdits.delete(this.failingEdits.keys().next().value!);
    this.failingEdits.set(key, attempts);
    if (attempts >= 2) this.editLoopStopped = true;
    const spellingHint = code === 'TEXT_NOT_FOUND' && /\\(?:[nrtbfv0]|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/.test(oldText)
      ? ' old_text contains literal backslash escape spellings such as \\n, \\r or \\t. Those characters stay literal. Copy the actual read_file.text string value or choose a unique exact short substring already present in the file. The app never decodes these spellings automatically; no change was made.' : '';
    throw new ActionError(attempts >= 2 ? 'REPEATED_EDIT_FAILED' : code,
      attempts >= 2 ? repeatedEditFailureText
        : `${message} Copy exact read_file.text, including whitespace and line endings. Location metadata is not part of the file.${spellingHint}`,
      { path: target.relative, input_sha256: before.hash, attempts, changed: false });
  }

  private async writeFile(tool: string, id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    if (signal?.aborted) throw cancelled();
    const file = textArgument(args, 'path');
    const target = await this.target(file);
    const before = await this.fileVersion(target.absolute);
    let content: string;
    if (tool === 'edit_file') {
      if (before.content === null) throw new ActionError('FILE_NOT_FOUND', 'The file does not exist. Use write_file to propose creating it.');
      const oldText = textArgument(args, 'old_text', true);
      if (oldText.length === 0) throw new ActionError('INVALID_ARGUMENT', 'old_text must not be empty. Whitespace and line endings are allowed when they match exactly once.');
      const newText = textArgument(args, 'new_text', true);
      const first = before.content.indexOf(oldText);
      if (first < 0) this.failedEdit(target, before, oldText, newText, 'TEXT_NOT_FOUND', 'old_text does not match the current file. Read the file and propose a corrected edit.');
      if (before.content.indexOf(oldText, first + 1) >= 0) this.failedEdit(target, before, oldText, newText, 'AMBIGUOUS_EDIT', 'old_text matches more than once. Include enough surrounding text to identify one occurrence.');
      content = before.content.slice(0, first) + newText + before.content.slice(first + oldText.length);
    } else content = textArgument(args, 'content', true);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ActionError('FILE_TOO_LARGE', 'File actions support text files up to 2 MB.');
    if (PRIVATE_KEY.test(content)) throw new ActionError('PROTECTED_CONTENT', 'The agent cannot write private keys.');
    if (before.content === content) return mutationResult('The file already has the proposed content. No change was needed. Verify with read_file; do not rewrite it.', {
      ok: true, operation: tool, path: target.relative, status: 'unchanged', changed: false, sha256: before.hash, bytes: Buffer.byteLength(content, 'utf8'),
    });
    // Approvals identify the checked project target, regardless of whether a
    // model copied an absolute path from read_file or supplied a relative path.
    // Keep raw tool input as intent metadata; it cannot expand this permission.
    await this.permission({ requestId: id, title: `${before.content === null ? 'Create' : 'Change'} ${target.relative}`, arguments: { ...args, path: target.relative }, preview: diffPreview(target.relative, before.content, content), workspacePath: target.root,
      utility: 'fileEditing', alwaysApproveAllowed: true }, signal);
    const checked = await this.target(file);
    const current = await this.fileVersion(checked.absolute);
    if (checked.root !== target.root || checked.absolute !== target.absolute || current.hash !== before.hash || current.device !== before.device || current.inode !== before.inode || current.mode !== before.mode) throw new ActionError('STALE_PREVIEW', 'The file changed while approval was pending. Read it and propose a fresh change.');
    if (signal?.aborted) throw cancelled();
    await mkdir(this.options.historyDirectory, { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, id, createdAt: new Date().toISOString(), projectPath: target.root, relativePath: target.relative, before: before.content, beforeHash: before.hash, afterHash: hash(content), mode: before.mode, applied: false, undone: false };
    // A durable snapshot must exist before the project file is changed.
    await this.atomicWrite(path.join(this.options.historyDirectory, `${id}.json`), JSON.stringify(snapshot), 0o600);
    if (signal?.aborted) throw cancelled();
    await mkdir(path.dirname(target.absolute), { recursive: true });
    // Revalidate after creating missing parent directories too.
    await this.target(file);
    const final = await this.fileVersion(target.absolute);
    if (final.hash !== before.hash || final.device !== before.device || final.inode !== before.inode || final.mode !== before.mode) throw new ActionError('STALE_PREVIEW', 'The file changed before the write could be applied. Propose the change again.');
    this.options.onTool?.({ id, title: 'Write file', status: 'running', input: args });
    await this.atomicWrite(target.absolute, content, before.mode, signal);
    snapshot.applied = true;
    await this.atomicWrite(path.join(this.options.historyDirectory, `${id}.json`), JSON.stringify(snapshot), 0o600);
    const verified = await this.fileVersion(target.absolute);
    if (verified.hash !== snapshot.afterHash) throw new ActionError('VERIFICATION_FAILED', 'The file changed before its write could be verified. Read the actual content; do not repeat the completed edit.');
    return mutationResult(`${before.content === null ? 'Created' : 'Updated'} ${target.relative}. A snapshot is available for undo. If file reading is enabled, verify with read_file using path ${JSON.stringify(target.relative)}. This file edit does not create a command log.`, {
      ok: true, operation: tool, path: target.relative, status: 'changed', changed: true, action_id: id, sha256: verified.hash, bytes: Buffer.byteLength(verified.content!, 'utf8'),
    });
  }

  private async runCommand(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    const command = textArgument(args, 'command');
    if (Buffer.byteLength(command) > 32_768) throw new ActionError('COMMAND_TOO_LARGE', 'The proposed command is too long.');
    const requestedCwd = args.cwd === undefined ? '.' : textArgument(args, 'cwd');
    const target = await this.target(requestedCwd, true);
    const timeout = args.timeout_ms === undefined ? commandTimeoutLimits.default : args.timeout_ms;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < commandTimeoutLimits.minimum || timeout > commandTimeoutLimits.maximum) throw new ActionError('INVALID_TIMEOUT', 'timeout_ms must be an integer between 100 and 600000.');
    const purpose = args.purpose ?? 'implementation';
    if (!['implementation', 'verification'].includes(String(purpose))) throw new ActionError('INVALID_ARGUMENT', `${this.verificationRecoveryGuidance()} purpose must be "implementation" or "verification".`);
    const checkIds = args.checkIds ?? [];
    if (!Array.isArray(checkIds) || checkIds.length > 12 || new Set(checkIds).size !== checkIds.length || checkIds.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))) throw new ActionError('INVALID_ARGUMENT', `${this.verificationRecoveryGuidance()} checkIds must be an array of at most 12 unique IDs, each 1–64 letters, digits, underscores or hyphens and starting with a letter or digit.`);
    if (purpose === 'verification' ? !checkIds.length || checkIds.some(value => !this.options.verificationCheckIds?.includes(value)) : checkIds.length > 0) throw new ActionError('INVALID_ARGUMENT', purpose === 'verification'
      ? `${this.verificationRecoveryGuidance()} Verification requires nonempty known frozen command criterion checkIds and the exact frozen command/cwd.`
      : `${this.verificationRecoveryGuidance()} Implementation/debugging commands require purpose:"implementation" with checkIds:[].`);
    if(purpose==='implementation')this.rejectQuoteStrippedFrozenCommand(command,requestedCwd);
    const windows = process.platform === 'win32';
    const launch = this.options.networkAccess === 'local-only' ? await localOnlyCommandLaunch(command)
      : { executable: windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh', args: windows ? ['/d', '/s', '/c', command] : ['-c', command] };
    await this.permission({ requestId: id, title: 'Run command with your account permissions', arguments: { ...args, timeout_ms: timeout }, command, cwd: target.absolute }, signal);
    const checked = await this.target(requestedCwd, true);
    if (checked.root !== target.root || checked.absolute !== target.absolute) throw new ActionError('STALE_PREVIEW', 'The command working directory changed while approval was pending.');
    if (signal?.aborted) throw cancelled();
    if (purpose === 'verification') {
      await this.options.onBeforeVerificationCommand?.(id, args, signal);
      const ready = await this.target(requestedCwd, true);
      if (ready.root !== target.root || ready.absolute !== target.absolute) throw new ActionError('STALE_PREVIEW', 'The command working directory changed before verification could start.');
    }
    if (signal?.aborted) throw cancelled();
    this.options.onTool?.({ id, title: 'Run command', status: 'running', input: args });
    const logDirectory = path.join(this.options.historyDirectory, 'command-logs');
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const recordPath = path.join(logDirectory, `${id}.json`);
    const verificationIntent=args.verification_intent;
    await writeFile(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout, purpose, checkIds,
      ...(verificationIntent?{verificationIntent}:{}),
      ...(this.options.networkAccess ? { networkAccess: this.options.networkAccess } : {}), state: 'started', startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    const log = await open(path.join(logDirectory, `${id}.log`), 'wx', 0o600);
    try {
      if (signal?.aborted) {
        await this.atomicWrite(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout, state: 'interrupted', finishedAt: new Date().toISOString() }), 0o600);
        throw cancelled();
      }
      const child = spawn(launch.executable, launch.args, { cwd: target.absolute, env: this.options.networkAccess === 'local-only' ? localOnlyCommandEnvironment(process.env) : process.env, shell: false, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const outcome = await this.commandResult(child, timeout, signal, async chunk => { await log.writeFile(chunk); });
      await log.sync();
      await this.atomicWrite(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout,
        purpose, checkIds,
        ...(verificationIntent?{verificationIntent}:{}),
        ...(this.options.networkAccess ? { networkAccess: this.options.networkAccess } : {}),
        state: signal?.aborted || ['COMMAND_TIMEOUT', 'COMMAND_INTERRUPTED'].includes(outcome.errorCode ?? '') ? 'interrupted' : outcome.isError ? 'failed' : 'completed',
        exitCode: outcome.exitCode, exitSignal: outcome.exitSignal,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), finishedAt: new Date().toISOString() }), 0o600);
      const { outputBytes, previewBytes, exitCode, exitSignal, ...actionOutcome } = outcome;
      const handle = `log-${id.slice(0, 8)}`;
      let logId = id;
      // A short handle is a locator, never a fuzzy match. A rare prefix
      // collision falls back to the durable UUID rather than selecting a log.
      try {
        const matches = await this.matchingCommandLogs(id.slice(0, 8));
        if (matches.length === 1 && matches[0] === id) logId = handle;
      } catch { /* The durable identity remains valid. */ }
      const outputComplete = outputBytes === previewBytes;
      const nextOffset = outputComplete ? null : previewBytes;
      const evidence = { ok: !outcome.isError, operation: 'run_command', ...(args.purpose !== undefined ? { action_id: id, command_sha256: hash(command), purpose, check_ids: checkIds } : {}),
        ...(verificationIntent?{verification_intent:verificationIntent,command_cwd:target.absolute}:{}),
        ...(this.options.networkAccess ? { network_access: this.options.networkAccess } : {}), log_id: logId, durable_id: id, output_complete: outputComplete, next_offset: nextOffset, exit_code: exitCode, exit_signal: exitSignal, ...(outcome.errorCode ? { error: outcome.errorCode } : {}) };
      const metadata = JSON.stringify(evidence);
      const guidance = outputComplete ? 'All saved output is shown above; no log read is needed.'
        : `Read remaining output with read_command_output using id ${JSON.stringify(logId)} and offset ${nextOffset}.`;
      const content = outcome.content.map(item => ({ ...item, text: `${metadata}\n${item.text}\n\nSaved command log: ${id}. ${guidance} Commands are never replayed by task resume.` }));
      if (outcome.errorCode === 'COMMAND_TIMEOUT') content.push({ type: 'text', text: commandTimeoutText });
      else if (outcome.errorCode === 'COMMAND_INTERRUPTED') content.push({ type: 'text', text: interruptedTurnText });
      return { ...actionOutcome, content, structuredContent: evidence };
    } finally { await log.close(); }
  }

  private commandResult(child: ChildProcess, timeoutMs: number, signal?: AbortSignal, saveChunk?: (chunk: Buffer) => Promise<void>): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let previewBytes = 0;
      let writes = Promise.resolve();
      // Leave room for machine-readable exit evidence and saved-log guidance.
      const previewLimit = Math.max(256, (this.options.resultChars ?? 2000) - 256);
      let stopped: string | null = null;
      let stoppedCode: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationCleanup: Promise<void> | undefined;
      const terminate = (reason: string, errorCode = 'COMMAND_INTERRUPTED') => {
        if (stopped) return;
        stopped = reason; stoppedCode = errorCode;
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error', () => child.kill());
          killer.once('exit', (code) => { if (code !== 0) child.kill(); });
        } else {
          try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          // The shell can exit while a descendant ignores SIGTERM and has
          // redirected its stdio. Keep cleanup alive after that shell closes.
          terminationCleanup = new Promise<void>(resolve => {
            killTimer = setTimeout(() => {
              try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
              resolve();
            }, 1000);
          });
        }
      };
      const collect = (chunk: Buffer) => {
        const available = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
        if (available > 0) {
          const part = chunk.subarray(0, available); outputBytes += part.length;
          if (previewBytes < previewLimit) { const head = part.subarray(0, previewLimit - previewBytes); chunks.push(head); previewBytes += head.length; }
          if (saveChunk) {
            child.stdout?.pause(); child.stderr?.pause();
            writes = writes.then(() => saveChunk(part)).then(() => { child.stdout?.resume(); child.stderr?.resume(); }, () => { terminate('The command log could not be saved; execution was stopped.'); });
          }
        }
        if (chunk.length > available) terminate('The command exceeded the 64 MB saved-log limit and was stopped.');
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timeout = setTimeout(() => terminate(`The command exceeded its ${timeoutMs} ms time limit and was stopped.`, 'COMMAND_TIMEOUT'), timeoutMs);
      const onAbort = () => terminate('The command was cancelled.');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      let finished = false;
      const finish = async (message: string, failed: boolean, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null) => {
        if (finished) return; finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const preview = Buffer.concat(chunks);
        let end = preview.length;
        if (outputBytes > end) {
          while (end > 0 && (preview[end - 1] & 0xc0) === 0x80) end--;
          if (end > 0 && preview[end - 1] >= 0xc0) end--;
        }
        const output = preview.subarray(0, end).toString('utf8');
        await writes;
        await terminationCleanup;
        if (killTimer) clearTimeout(killTimer);
        resolve({ ...result(`${message}${output ? `\n\n${output}` : ''}${outputBytes > previewBytes ? '\n[Excerpt only; the full output is in the saved command log.]' : ''}`, failed),
          ...(stoppedCode ? { errorCode: stoppedCode } : {}), outputBytes, previewBytes: end, exitCode, exitSignal });
      };
      child.once('error', (error) => finish(`The command could not start: ${error.message}`, true));
      child.once('close', (code, exitSignal) => finish(stopped ?? `Command exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code ?? 'unknown'}`}.`, Boolean(stopped) || code !== 0, code, exitSignal));
    });
  }

  private async matchingCommandLogs(prefix: string): Promise<string[]> {
    const entries = await readdir(path.join(this.options.historyDirectory, 'command-logs'), { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.log') && entry.name.startsWith(`${prefix}-`)
      && COMMAND_LOG_UUID.test(entry.name.slice(0, -4))).map(entry => entry.name.slice(0, -4));
  }

  private failedCommandRead(reference: string, offset: number, code: string, message: string, matchingIds: string[] = []): never {
    const canonical = reference.toLowerCase();
    const key = hash(JSON.stringify([canonical, offset]));
    const availability = hash(JSON.stringify([code, [...matchingIds].sort()]));
    const previous = this.failingCommandReads.get(key);
    const attempts = previous?.availability === availability ? previous.attempts + 1 : 1;
    if (this.failingCommandReads.size >= 128 && !this.failingCommandReads.has(key)) this.failingCommandReads.delete(this.failingCommandReads.keys().next().value!);
    this.failingCommandReads.set(key, { reference: canonical, availability, attempts });
    if (attempts >= 2) this.commandReadLoopStopped = true;
    throw new ActionError(attempts >= 2 ? 'REPEATED_LOG_READ_FAILED' : code,
      attempts >= 2 ? repeatedCommandReadFailureText : message,
      { id: reference, offset, attempts, availability_sha256: availability });
  }

  private async readCommandOutput(args: Record<string, unknown>): Promise<ActionResult> {
    if (this.options.utilities?.terminal === false) throw new ActionError('DISABLED_TOOL', 'Command logs are disabled with terminal utilities.');
    const reference = textArgument(args, 'id');
    const handle = COMMAND_LOG_HANDLE.exec(reference);
    if (!handle && !COMMAND_LOG_UUID.test(reference)) throw new ActionError('INVALID_ARGUMENT', 'Use the exact saved command log UUID returned by run_command, or its returned log-xxxxxxxx handle. Do not invent an id; use read_file to verify edited files.');
    // Validate unrelated arguments before observing availability; malformed
    // offsets must not contribute to a missing-log loop counter.
    const offset = args.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new ActionError('INVALID_ARGUMENT', 'offset must be a non-negative byte position.');
    let id = reference.toLowerCase();
    const missing = (): never => this.failedCommandRead(reference, offset, 'COMMAND_LOG_NOT_FOUND', 'No saved command log exists for this id. Do not retry the same id. Use only a log id returned by run_command; use read_file to verify edited files.');
    if (handle) {
      let matches: string[];
      try { matches = await this.matchingCommandLogs(handle[1]); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing(); throw error; }
      if (!matches.length) missing();
      if (matches.length !== 1) this.failedCommandRead(reference, offset, 'COMMAND_LOG_AMBIGUOUS', 'This short log handle matches more than one saved command log. Use the exact durable UUID returned with the command; no output was read.', matches);
      id = matches[0];
    }
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path.join(this.options.historyDirectory, 'command-logs', `${id}.log`), 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing();
      throw error;
    }
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(4000, this.options.resultChars ?? 2000));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      for (const [key, failure] of this.failingCommandReads) {
        if (failure.reference === reference.toLowerCase()) this.failingCommandReads.delete(key);
      }
      let end = bytesRead;
      if (offset + end < size) {
        while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end--;
        if (end > 0 && buffer[end - 1] >= 0xc0) end--;
      }
      return result(JSON.stringify({ id: reference, durable_id: id, offset, text: buffer.subarray(0, end).toString('utf8'), next_offset: offset + end < size ? offset + end : null, size }));
    } finally { await file.close(); }
  }

  /** Undo the most recent matching edit; unrelated user edits are never overwritten. */
  undo(): Promise<number> {
    const id = randomUUID();
    this.options.onReadbackEffect?.({ id, operation: 'undo', phase: 'begin' });
    return this.serial(async () => {
      const root = await realpath(this.options.projectPath);
      let names: string[];
      try { names = (await readdir(this.options.historyDirectory)).filter((name) => /^[a-f0-9-]+\.json$/i.test(name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      const snapshots: Snapshot[] = [];
      for (const name of names) {
        try {
          const raw = await readFile(path.join(this.options.historyDirectory, name), 'utf8');
          if (raw.length > MAX_FILE_BYTES * 2 + 4096) continue;
          const value = JSON.parse(raw) as Snapshot;
          if (value.version === 1 && value.id === name.slice(0, -5) && value.projectPath === root && value.applied === true && value.undone === false && typeof value.createdAt === 'string' && typeof value.relativePath === 'string' && /^[a-f0-9]{64}$/.test(value.afterHash) && (typeof value.before === 'string' || value.before === null) && (value.groupId === undefined || /^[a-f0-9-]{36}$/i.test(value.groupId))) snapshots.push(value);
        } catch { /* A malformed snapshot must not trigger a project mutation. */ }
      }
      snapshots.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
      for (const snapshot of snapshots) {
        let current: FileVersion;
        try { current = await this.fileVersion((await this.target(snapshot.relativePath)).absolute); }
        catch { continue; } // A replaced link or protected user content is never restored.
        if (current.hash !== snapshot.afterHash) continue;
        if (snapshot.before !== null && hash(snapshot.before) !== snapshot.beforeHash) continue;
        const group = snapshot.groupId ? snapshots.filter(item => item.groupId === snapshot.groupId) : [snapshot];
        let restored = 0;
        const directories: string[] = [];
        for (const item of group) {
          let checked: Target, observed: FileVersion;
          try { checked = await this.target(item.relativePath); observed = await this.fileVersion(checked.absolute); }
          catch { continue; }
          if (observed.hash !== item.afterHash) continue;
          if (item.before !== null && hash(item.before) !== item.beforeHash) continue;
          if (item.before === null) await unlink(checked.absolute);
          else await this.atomicWrite(checked.absolute, item.before, item.mode);
          item.undone = true;
          await this.atomicWrite(path.join(this.options.historyDirectory, `${item.id}.json`), JSON.stringify(item), 0o600);
          if (Array.isArray(item.createdDirectories)) directories.push(...item.createdDirectories.filter(directory => typeof directory === 'string'));
          restored++;
        }
        await this.removeEmptyDirectories(directories);
        return restored;
      }
      return 0;
    }).finally(() => this.options.onReadbackEffect?.({ id, operation: 'undo', phase: 'settled' }));
  }
}

export { LocalActions as ActionService };
