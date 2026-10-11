import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cancelledActionText, commandTimeoutLimits, commandTimeoutText, interruptedTurnText } from './action-protocol.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CREATE_FILES = 20;
const MAX_CREATE_BYTES = 512 * 1024;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

export interface ActionPermission {
  requestId: string;
  title: string;
  arguments: Record<string, unknown>;
  preview?: string;
  command?: string;
  cwd?: string;
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
  isError?: boolean;
  /** Host-owned error identity; never inferred from model or command text. */
  errorCode?: string;
}

export interface LocalActionsOptions {
  projectPath: string;
  historyDirectory: string;
  onPermission: (permission: ActionPermission, signal?: AbortSignal) => Promise<boolean>;
  onTool?: (event: ActionToolEvent) => void;
  resultChars?: number;
  utilities?: { fileEditing: boolean; terminal: boolean };
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
  constructor(code: string, message: string) { super(message); this.name = 'ActionError'; this.code = code; }
}

const result = (text: string, isError = false): ActionResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const cancelled = () => new ActionError('CANCELLED', cancelledActionText);
const contained = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

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
  { name: 'edit_file', description: 'Propose one exact text replacement in a project file. The user reviews a diff and approves before any file changes.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } },
  { name: 'write_file', description: 'Propose creating or replacing a project text file. The user reviews a diff and approves before any file changes.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'create_files', description: 'Propose 1–20 new project text files in one reviewed batch. Parent folders are created automatically; existing files cannot be replaced. Total content <=512 KiB. One approval shows every file and grouped undo is available.', inputSchema: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }, required: ['files'], additionalProperties: false } },
  { name: 'run_command', description: 'Propose a shell command in the project. The user approves its exact command, working directory and time limit. timeout_ms defaults to 60000; explicitly select up to 600000 for dependency setup. Interrupted commands preserve partial work and are never automatically repeated. This is not an operating-system sandbox; approved commands have the user account’s access.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'integer', ...commandTimeoutLimits, description: 'Approved execution time limit in milliseconds, 100–600000; default 60000. Longer dependency setup requires an explicit value.' } }, required: ['command'], additionalProperties: false } },
] as const;

/**
 * The host owns UI permission responses. Approval is checked in application
 * code for every mutation or command, never inferred from the model's text.
 * Commands run with user-account permissions and are not OS-sandboxed.
 */
export class LocalActions {
  private options: LocalActionsOptions;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: LocalActionsOptions) {
    if (!path.isAbsolute(options.projectPath) || !path.isAbsolute(options.historyDirectory)) throw new ActionError('INVALID_PATH', 'Project and history directories must be absolute paths.');
    this.options = options;
  }

  async execute(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<ActionResult> {
    const id = randomUUID();
    const title = tool === 'run_command' ? 'Run command' : tool === 'read_command_output' ? 'Read command output' : tool === 'create_files' ? 'Create project files' : tool === 'edit_file' ? 'Edit file' : 'Write file';
    this.options.onTool?.({ id, title, status: 'pending', input: args });
    try {
      if (options.signal?.aborted) throw cancelled();
      let output: ActionResult;
      if (tool === 'read_command_output') output = await this.readCommandOutput(args);
      else if (tool === 'run_command') {
        if (this.options.utilities?.terminal === false) throw new ActionError('DISABLED_TOOL', 'Terminal commands are disabled.');
        output = await this.runCommand(id, args, options.signal);
      }
      else if (tool === 'create_files') {
        if (this.options.utilities?.fileEditing === false) throw new ActionError('DISABLED_TOOL', 'File editing is disabled.');
        output = await this.serial(() => this.createFiles(id, args, options.signal));
      }
      else if (tool === 'edit_file' || tool === 'write_file') {
        if (this.options.utilities?.fileEditing === false) throw new ActionError('DISABLED_TOOL', 'File editing is disabled.');
        // Serialize edits and undo, including approval, so approved previews
        // cannot race another app action. External changes are rechecked too.
        output = await this.serial(() => this.writeFile(tool, id, args, options.signal));
      } else throw new ActionError('UNKNOWN_TOOL', `Unknown action tool: ${tool}`);
      this.options.onTool?.({ id, title, status: output.isError ? 'failed' : 'completed', input: args, output });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The action failed.';
      const output = result(message, true);
      if (error instanceof ActionError) output.errorCode = error.code;
      this.options.onTool?.({ id, title, status: 'failed', input: args, output });
      return output;
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.mutationQueue.catch(() => undefined).then(task);
    this.mutationQueue = queued;
    return queued;
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
    let onAbort: (() => void) | undefined;
    const decision = this.options.onPermission(permission, signal);
    try {
      const approved = signal ? await Promise.race([decision, new Promise<never>((_, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); })]) : await decision;
      if (signal?.aborted) throw cancelled();
      if (approved !== true) throw new ActionError('PERMISSION_DENIED', 'The user denied this action. No action was taken.');
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
      arguments: args, preview: planned.map(item => diffPreview(item.target.relative, null, item.content)).join('\n\n') }, signal);
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
      return result(`Created ${planned.length} project files. One undo restores this creation batch.\n${names.slice(0, allowance)}${names.length > allowance ? '\n[File list shortened; every path was included in approval.]' : ''}`);
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

  private async writeFile(tool: string, id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    if (signal?.aborted) throw cancelled();
    const file = textArgument(args, 'path');
    const target = await this.target(file);
    const before = await this.fileVersion(target.absolute);
    let content: string;
    if (tool === 'edit_file') {
      if (before.content === null) throw new ActionError('FILE_NOT_FOUND', 'The file does not exist. Use write_file to propose creating it.');
      const oldText = textArgument(args, 'old_text');
      const newText = textArgument(args, 'new_text', true);
      const first = before.content.indexOf(oldText);
      if (first < 0) throw new ActionError('TEXT_NOT_FOUND', 'old_text does not match the current file. Read the file and propose the edit again.');
      if (before.content.indexOf(oldText, first + 1) >= 0) throw new ActionError('AMBIGUOUS_EDIT', 'old_text matches more than once. Include enough surrounding text to identify one occurrence.');
      content = before.content.slice(0, first) + newText + before.content.slice(first + oldText.length);
    } else content = textArgument(args, 'content', true);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ActionError('FILE_TOO_LARGE', 'File actions support text files up to 2 MB.');
    if (PRIVATE_KEY.test(content)) throw new ActionError('PROTECTED_CONTENT', 'The agent cannot write private keys.');
    if (before.content === content) return result('The file already has the proposed content. No change was needed.');
    await this.permission({ requestId: id, title: `${before.content === null ? 'Create' : 'Change'} ${target.relative}`, arguments: args, preview: diffPreview(target.relative, before.content, content) }, signal);
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
    return result(`${before.content === null ? 'Created' : 'Updated'} ${target.relative}. A snapshot is available for undo.`);
  }

  private async runCommand(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    const command = textArgument(args, 'command');
    if (Buffer.byteLength(command) > 32_768) throw new ActionError('COMMAND_TOO_LARGE', 'The proposed command is too long.');
    const requestedCwd = args.cwd === undefined ? '.' : textArgument(args, 'cwd');
    const target = await this.target(requestedCwd, true);
    const timeout = args.timeout_ms === undefined ? commandTimeoutLimits.default : args.timeout_ms;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < commandTimeoutLimits.minimum || timeout > commandTimeoutLimits.maximum) throw new ActionError('INVALID_TIMEOUT', 'timeout_ms must be an integer between 100 and 600000.');
    await this.permission({ requestId: id, title: 'Run command with your account permissions', arguments: { ...args, timeout_ms: timeout }, command, cwd: target.absolute }, signal);
    const checked = await this.target(requestedCwd, true);
    if (checked.root !== target.root || checked.absolute !== target.absolute) throw new ActionError('STALE_PREVIEW', 'The command working directory changed while approval was pending.');
    if (signal?.aborted) throw cancelled();
    this.options.onTool?.({ id, title: 'Run command', status: 'running', input: args });
    const windows = process.platform === 'win32';
    const logDirectory = path.join(this.options.historyDirectory, 'command-logs');
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const recordPath = path.join(logDirectory, `${id}.json`);
    await writeFile(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout, state: 'started', startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    const log = await open(path.join(logDirectory, `${id}.log`), 'wx', 0o600);
    try {
      if (signal?.aborted) {
        await this.atomicWrite(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout, state: 'interrupted', finishedAt: new Date().toISOString() }), 0o600);
        throw cancelled();
      }
      const child = spawn(windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], { cwd: target.absolute, env: process.env, shell: false, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const outcome = await this.commandResult(child, timeout, signal, async chunk => { await log.writeFile(chunk); });
      await log.sync();
      await this.atomicWrite(recordPath, JSON.stringify({ id, command, cwd: target.absolute, timeoutMs: timeout,
        state: signal?.aborted || ['COMMAND_TIMEOUT', 'COMMAND_INTERRUPTED'].includes(outcome.errorCode ?? '') ? 'interrupted' : outcome.isError ? 'failed' : 'completed',
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), finishedAt: new Date().toISOString() }), 0o600);
      const content = outcome.content.map(item => ({ ...item, text: `${item.text}\n\nSaved command log: ${id}. Use read_command_output with this id and offset 0 to read more. Commands are never replayed by task resume.` }));
      if (outcome.errorCode === 'COMMAND_TIMEOUT') content.push({ type: 'text', text: commandTimeoutText });
      else if (outcome.errorCode === 'COMMAND_INTERRUPTED') content.push({ type: 'text', text: interruptedTurnText });
      return { ...outcome, content };
    } finally { await log.close(); }
  }

  private commandResult(child: ChildProcess, timeoutMs: number, signal?: AbortSignal, saveChunk?: (chunk: Buffer) => Promise<void>): Promise<ActionResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let previewBytes = 0;
      let writes = Promise.resolve();
      const previewLimit = Math.max(256, this.options.resultChars ?? 2000);
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
      const finish = async (message: string, failed: boolean) => {
        if (finished) return; finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const output = Buffer.concat(chunks).toString('utf8');
        await writes;
        await terminationCleanup;
        if (killTimer) clearTimeout(killTimer);
        resolve({ ...result(`${message}${output ? `\n\n${output}` : ''}${outputBytes > previewBytes ? '\n[Excerpt only; the full output is in the saved command log.]' : ''}`, failed),
          ...(stoppedCode ? { errorCode: stoppedCode } : {}) });
      };
      child.once('error', (error) => finish(`The command could not start: ${error.message}`, true));
      child.once('close', (code, exitSignal) => finish(stopped ?? `Command exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code ?? 'unknown'}`}.`, Boolean(stopped) || code !== 0));
    });
  }

  private async readCommandOutput(args: Record<string, unknown>): Promise<ActionResult> {
    if (this.options.utilities?.terminal === false) throw new ActionError('DISABLED_TOOL', 'Command logs are disabled with terminal utilities.');
    const id = textArgument(args, 'id');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new ActionError('INVALID_ARGUMENT', 'Use the exact saved command log UUID returned by run_command. Do not invent an id; use read_file to verify edited files.');
    const offset = args.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new ActionError('INVALID_ARGUMENT', 'offset must be a non-negative byte position.');
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path.join(this.options.historyDirectory, 'command-logs', `${id}.log`), 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('COMMAND_LOG_NOT_FOUND', 'No saved command log exists for this id. Do not retry the same id. Use only a log id returned by run_command; use read_file to verify edited files.');
      throw error;
    }
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(4000, this.options.resultChars ?? 2000));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let end = bytesRead;
      if (offset + end < size) {
        while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end--;
        if (end > 0 && buffer[end - 1] >= 0xc0) end--;
      }
      return result(JSON.stringify({ id, offset, text: buffer.subarray(0, end).toString('utf8'), next_offset: offset + end < size ? offset + end : null, size }));
    } finally { await file.close(); }
  }

  /** Undo the most recent matching edit; unrelated user edits are never overwritten. */
  undo(): Promise<number> {
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
    });
  }
}

export { LocalActions as ActionService };
