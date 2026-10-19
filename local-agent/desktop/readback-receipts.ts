/** Native read origin and actual model delivery are separate evidence gates. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const READBACK_PROTOCOL = 'local-agent-readback-v1';
export const MAX_READBACK_FILE_BYTES = 2048;
export const MAX_READBACK_REPORT_BYTES = 8192;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECORDS = 128;
const TOKEN = /^[a-f0-9]{64}$/;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function utf8(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Invalid readback JSON value.');
  return result;
}
/** Bounded JSON parser with decoded-key duplicate rejection; no prefix/prose parsing. */
export function strictReadbackJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('Oversized readback JSON.');
  let at = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    for (; at < text.length; at++) {
      if (text[at] === '\\') { at++; continue; }
      if (text[at] === '"') { at++; return JSON.parse(text.slice(start, at)); }
    }
    throw new Error('Incomplete JSON string.');
  };
  const value = (depth: number): unknown => {
    if (depth > 32) throw new Error('Readback JSON nesting is too deep.');
    space();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; space(); const result: Record<string, unknown> = Object.create(null), keys = new Set<string>();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') throw new Error('Invalid JSON object key.');
        const key = string(); if (keys.has(key)) throw new Error('Duplicate readback JSON key.'); keys.add(key);
        space(); if (text[at++] !== ':') throw new Error('Invalid JSON object.');
        result[key] = value(depth + 1); space();
        const end = text[at++]; if (end === '}') return result;
        if (end !== ',') throw new Error('Invalid JSON object separator.');
      }
    }
    if (text[at] === '[') {
      at++; space(); const result: unknown[] = [];
      if (text[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space(); const end = text[at++];
        if (end === ']') return result;
        if (end !== ',') throw new Error('Invalid JSON array separator.');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!literal) throw new Error('Invalid JSON literal.');
    at += literal[0].length; const result = JSON.parse(literal[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('Nonfinite readback JSON number.');
    return result;
  };
  const result = value(0); space(); if (at !== text.length) throw new Error('Trailing readback JSON data.');
  return result;
}
export interface ReadbackTarget {
  id: string; path: string; exactCriterionId: string; content: string; report: 'exact_utf8';
}
export interface ReadbackBinding {
  turnId: string; requestHash: string; workspacePath: string; signal: AbortSignal;
}
export interface ReadbackScopeOptions extends ReadbackBinding {
  targets: readonly ReadbackTarget[];
  currentRevision(): number;
  effectInFlight(): boolean;
}
interface Arguments extends Record<string, unknown> {
  path: string; start_line: number; max_lines: number; cursor: string | null;
  expected_sha256: string | null; max_chars: number | null;
}
/** Shared Python/TS closed defaults. These are evidence matching, never path grants. */
export function normalizedReadArguments(raw: unknown): Arguments | undefined {
  if (!object(raw) || Object.keys(raw).some(key => !['path', 'start_line', 'max_lines', 'cursor', 'expected_sha256', 'max_chars'].includes(key))
    || !utf8(raw.path) || !raw.path || raw.path.includes('\0')) return;
  const value = { path: raw.path, start_line: raw.start_line === undefined ? 1 : raw.start_line, max_lines: raw.max_lines === undefined ? 200 : raw.max_lines,
    cursor: raw.cursor ?? null, expected_sha256: raw.expected_sha256 ?? null, max_chars: raw.max_chars ?? null };
  if (!Number.isSafeInteger(value.start_line) || Number(value.start_line) < 1 || Number(value.start_line) > 1_000_000_000
    || !Number.isSafeInteger(value.max_lines) || Number(value.max_lines) < 1 || Number(value.max_lines) > 500
    || value.cursor !== null && typeof value.cursor !== 'string'
    || value.expected_sha256 !== null && (typeof value.expected_sha256 !== 'string' || !TOKEN.test(value.expected_sha256))
    || value.max_chars !== null && (!Number.isSafeInteger(value.max_chars) || Number(value.max_chars) < 500 || Number(value.max_chars) > 16000)) return;
  return value as Arguments;
}
interface Begin {
  argumentsHash: string; target: ReadbackTarget; revision: number; expires: number;
}
interface NativeRecord extends Begin {
  nonce: string; nativeResult: Record<string, unknown>; resultHash: string;
  state: 'available' | 'reserved' | 'failed' | 'delivered'; providerCallId?: string;
}
export interface DeliveredReadback {
  criterionId: string; exactCriterionId: string; path: string; text: string;
  sha256: string; size: number; nonce: string; providerCallId: string; revision: number;
}
type Message = { role: string; content?: unknown; tool_calls?: { id: string; function?: { name?: string; arguments?: unknown } }[]; tool_call_id?: string };
/** Opaque tickets are checked against this instance's WeakMap; raw model JSON cannot mint one. */
export type DeliveryTicket = object;

export class ReadbackReceiptScope {
  readonly binding: Readonly<ReadbackBinding>;
  private options: ReadbackScopeOptions;
  private begins = new Map<string, Begin>();
  private records = new Map<string, NativeRecord>();
  private deliveries = new WeakMap<DeliveryTicket, NativeRecord[]>();
  private delivered = new Map<string, NativeRecord>();
  private server?: Server;
  private closing?: Promise<void>;
  private closed = false;
  private directory?: { dev: number; ino: number };
  private endpoint?: string;
  private constructor(options: ReadbackScopeOptions) {
    this.binding = Object.freeze({ turnId: options.turnId, requestHash: options.requestHash,
      workspacePath: options.workspacePath, signal: options.signal });
    this.options = { ...options, targets: Object.freeze(options.targets.map(target => Object.freeze({ ...target }))) };
  }
  static async create(options: ReadbackScopeOptions): Promise<ReadbackReceiptScope> {
    if (!options.turnId || !TOKEN.test(options.requestHash) || !path.isAbsolute(options.workspacePath)
      || !(options.signal instanceof AbortSignal) || options.signal.aborted || options.targets.length > 12) throw new Error('Invalid current readback scope.');
    const ids = new Set<string>(), files = new Set<string>();
    for (const target of options.targets) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target.id) || ids.has(target.id) || files.has(target.path)
        || !target.exactCriterionId || target.report !== 'exact_utf8' || !utf8(target.content)
        || Buffer.byteLength(target.content, 'utf8') > MAX_READBACK_FILE_BYTES
        || !target.path || target.path.includes('\0') || path.isAbsolute(target.path)
        || target.path.split(/[\\/]/).some(part => part === '..') || target.path === '.') throw new Error('Unsupported bounded exact readback target.');
      ids.add(target.id); files.add(target.path);
    }
    const scope = new ReadbackReceiptScope(options);
    const root = await realpath(options.workspacePath), stat = await lstat(root);
    if (root !== path.resolve(options.workspacePath) || !stat.isDirectory()) throw new Error('The readback workspace changed.');
    scope.directory = { dev: stat.dev, ino: stat.ino };
    // Capacity validation only, never evidence: fail before any project action.
    exactReadbackReport(options.targets.map(target => ({ criterionId: target.id, exactCriterionId: target.exactCriterionId,
      path: path.resolve(options.workspacePath, target.path), text: target.content, sha256: hash(target.content),
      size: Buffer.byteLength(target.content, 'utf8'), nonce: '', providerCallId: '', revision: 0 })));
    return scope;
  }
  private live(revision?: number): boolean {
    return !this.closed && !this.binding.signal.aborted && !this.options.effectInFlight()
      && (revision === undefined || revision === this.options.currentRevision());
  }
  private async currentWorkspace(): Promise<boolean> {
    try {
      const root = await realpath(this.binding.workspacePath), stat = await lstat(this.binding.workspacePath);
      return root === path.resolve(this.binding.workspacePath) && stat.isDirectory() && !stat.isSymbolicLink()
        && stat.dev === this.directory?.dev && stat.ino === this.directory.ino;
    } catch { return false; }
  }
  private target(input: Arguments): ReadbackTarget | undefined {
    const actual = path.resolve(this.binding.workspacePath, input.path);
    return this.options.targets.find(target => path.resolve(this.binding.workspacePath, target.path) === actual);
  }
  private capRecords(): void {
    while (this.begins.size > MAX_RECORDS) this.begins.delete(this.begins.keys().next().value!);
    while (this.records.size > MAX_RECORDS) {
      const key = this.records.keys().next().value!; this.records.get(key)!.state = 'failed'; this.records.delete(key);
    }
  }
  /** Called ONLY by the secret native sidecar channel, before the actual primitive. */
  private begin(raw: unknown): Record<string, unknown> {
    const args = normalizedReadArguments(raw), target = args && this.target(args);
    if (!args || !target || !this.live() || args.cursor !== null || args.start_line !== 1) return { ok: false };
    const token = randomBytes(32).toString('hex');
    this.begins.set(token, { argumentsHash: hash(canonical(args)), target, revision: this.options.currentRevision(), expires: Date.now() + 120000 });
    this.capRecords();
    return { ok: true, schemaVersion: 1, token };
  }
  /** A begin is always spent on finalize, including a failed read or stale revision. */
  private finish(token: unknown, raw: unknown): Record<string, unknown> {
    if (typeof token !== 'string') return { ok: false };
    const begin = this.begins.get(token); this.begins.delete(token);
    if (!begin || begin.expires < Date.now() || !this.live(begin.revision) || !object(raw)) return { ok: false };
    const result = raw;
    const keys = ['ok', 'path', 'sha256', 'size', 'total_lines', 'start_line', 'start_column', 'end_line', 'end_column',
      'start_byte', 'end_byte', 'encoding', 'text', 'eof', 'next_cursor', 'truncated'];
    if (!exactKeys(result, keys) || result.ok !== true || result.path !== path.resolve(this.binding.workspacePath, begin.target.path)
      || result.encoding !== 'utf-8' || result.eof !== true || result.truncated !== false || result.next_cursor !== null
      || result.start_byte !== 0 || !Number.isSafeInteger(result.size) || Number(result.size) < 0 || Number(result.size) > MAX_READBACK_FILE_BYTES
      || result.start_line !== 1 || result.start_column !== 1 || Number(result.end_line) < 1 || Number(result.end_column) < 1
      || result.end_byte !== result.size || !utf8(result.text) || Buffer.byteLength(result.text, 'utf8') !== result.size
      || result.text !== begin.target.content || result.sha256 !== hash(result.text)
      || !['total_lines', 'start_line', 'start_column', 'end_line', 'end_column', 'start_byte', 'end_byte'].every(key => Number.isSafeInteger(result[key]) && Number(result[key]) >= 0)) return { ok: false };
    const nonce = randomBytes(32).toString('hex');
    this.records.set(nonce, { ...begin, nonce, nativeResult: structuredClone(result), resultHash: hash(canonical(result)), state: 'available' });
    this.capRecords();
    return { ok: true, schemaVersion: 1, nonce };
  }
  async start(): Promise<string> {
    if (this.server || !this.live() || !await this.currentWorkspace()) throw new Error('Readback receipts are unavailable.');
    const secret = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/' + secret || request.headers.origin !== undefined || this.closed || this.binding.signal.aborted) {
        response.writeHead(403, { 'Cache-Control': 'no-store' }).end(); return;
      }
      const timer = setTimeout(() => request.destroy(), 2000); timer.unref();
      void (async () => {
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error('Oversized receipt.');
            chunks.push(Buffer.from(chunk));
          }
          const value: unknown = strictReadbackJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          let result: Record<string, unknown> = { ok: false };
          if (object(value) && value.schemaVersion === 1 && await this.currentWorkspace()) {
            if (value.phase === 'begin' && exactKeys(value, ['schemaVersion', 'phase', 'arguments'])) result = this.begin(value.arguments);
            else if (value.phase === 'finish' && exactKeys(value, ['schemaVersion', 'phase', 'token', 'result'])) result = this.finish(value.token, value.result);
          }
          if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
        } catch {
          if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"ok":false}');
        } finally { clearTimeout(timer); }
      })();
    });
    this.server = server;
    server.requestTimeout = 2000; server.headersTimeout = 2000;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
      this.binding.signal.addEventListener('abort', () => { void this.close().catch(() => {}); }, { once: true });
      const address = server.address();
      if (!address || typeof address === 'string' || !this.live()) throw new Error('Readback receipts are unavailable.');
      this.endpoint = 'http://127.0.0.1:' + address.port + '/' + secret;
      return this.endpoint;
    } catch { await this.close(); throw new Error('Readback receipts are unavailable.'); }
  }
  /** Never serialize this endpoint into model-visible options or error text. */
  get url(): string | undefined { return this.endpoint; }
  private toolOutput(value: unknown): Record<string, unknown> | undefined {
    try {
      if (typeof value === 'string') value = strictReadbackJson(value);
      else if (Array.isArray(value)) {
        if (!value.every(part => object(part) && exactKeys(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string')) return;
        value = strictReadbackJson(value.map(part => part.text).join(''));
      }
      return object(value) ? value : undefined;
    } catch { return; }
  }
  /** Inspect the EXACT final model-bound messages, after sizing/compaction/adapter transforms. */
  reserveDelivery(messages: readonly Message[]): DeliveryTicket {
    const ticket = Object.freeze({}); const reserved: NativeRecord[] = [];
    this.deliveries.set(ticket, reserved);
    if (!this.live()) return ticket;
    const calls = new Map<string, { argumentsHash: string; position: number }[]>();
    const allCallCounts = new Map<string, number>();
    const resultCounts = new Map<string, number>();
    messages.forEach((message, position) => {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
        allCallCounts.set(call.id, (allCallCounts.get(call.id) ?? 0) + 1);
        if (call.function?.name !== 'local_files_and_research__read_file' || typeof call.id !== 'string' || !call.id) continue;
        let raw = call.function.arguments;
        if (typeof raw === 'string') { try { raw = strictReadbackJson(raw); } catch { continue; } }
        const args = normalizedReadArguments(raw); if (!args) continue;
        calls.set(call.id, [...(calls.get(call.id) ?? []), { argumentsHash: hash(canonical(args)), position }]);
      }
      if (message.role === 'tool' && typeof message.tool_call_id === 'string') resultCounts.set(message.tool_call_id, (resultCounts.get(message.tool_call_id) ?? 0) + 1);
    });
    const seen = new Set<string>();
    messages.forEach((message, position) => {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') return;
      const output = this.toolOutput(message.content), receipt = output?.readback_receipt;
      if (!output || !object(receipt) || !exactKeys(receipt, ['schemaVersion', 'nonce']) || receipt.schemaVersion !== 1
        || typeof receipt.nonce !== 'string' || !TOKEN.test(receipt.nonce)) return;
      const record = this.records.get(receipt.nonce);
      if (!record || record.state === 'delivered' || record.state === 'failed') return;
      if (seen.has(record.nonce)) { record.state = 'failed'; return; }
      seen.add(record.nonce);
      const selected = calls.get(message.tool_call_id);
      const { readback_receipt: _unused, ...native } = output;
      if (!selected || selected.length !== 1 || allCallCounts.get(message.tool_call_id) !== 1 || resultCounts.get(message.tool_call_id) !== 1 || selected[0].position >= position
        || selected[0].argumentsHash !== record.argumentsHash || hash(canonical(native)) !== record.resultHash || !this.live(record.revision)
        || record.state !== 'available') { record.state = 'failed'; return; }
      record.state = 'reserved'; record.providerCallId = message.tool_call_id; reserved.push(record);
    });
    return ticket;
  }
  settleDelivery(ticket: DeliveryTicket, normalCompletion: boolean): void {
    const records = this.deliveries.get(ticket); this.deliveries.delete(ticket);
    if (!records) return;
    for (const record of records) {
      if (record.state !== 'reserved') continue;
      if (!normalCompletion || !this.live(record.revision)) { record.state = 'failed'; continue; }
      record.state = 'delivered'; this.delivered.set(record.target.id, record);
    }
  }
  deliveredFor(id: string): DeliveredReadback | undefined {
    const record = this.delivered.get(id);
    if (!record || record.state !== 'delivered' || !record.providerCallId || !this.live(record.revision)) return;
    return Object.freeze({ criterionId: id, exactCriterionId: record.target.exactCriterionId,
      path: String(record.nativeResult.path), text: String(record.nativeResult.text),
      sha256: String(record.nativeResult.sha256), size: Number(record.nativeResult.size),
      nonce: record.nonce, providerCallId: record.providerCallId, revision: record.revision });
  }
  invalidate(): void {
    for (const record of this.records.values()) record.state = 'failed';
    this.begins.clear(); this.records.clear(); this.delivered.clear(); this.deliveries = new WeakMap();
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return; this.closed = true; this.endpoint = undefined; this.invalidate();
    const server = this.server; this.server = undefined;
    this.closing = (async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } })();
    return this.closing;
  }
}

export function normalJsonCompletion(value: unknown): boolean {
  if (!object(value) || !Array.isArray(value.choices) || value.choices.length !== 1) return false;
  const choice = value.choices[0];
  return object(choice) && (choice.index === undefined || choice.index === 0)
    && ['stop', 'tool_calls', 'function_call'].includes(String(choice.finish_reason)) && object(choice.message) && !value.error;
}
/** A finite SSE completion witness; incomplete/error/length streams never commit delivery. */
export class ReadbackStreamCompletion {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = ''; private done = false; private validFinish = false; private failed = false;
  push(bytes: Uint8Array): void {
    try {
      this.pending += this.decoder.decode(bytes, { stream: true });
      if (this.pending.length > 64 * 1024) { this.failed = true; return; }
      let end: number;
      while ((end = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, end).replace(/\r$/, ''); this.pending = this.pending.slice(end + 1);
        if (/^event:\s*error\s*$/.test(line)) { this.failed = true; continue; }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { if (this.done) this.failed = true; this.done = true; continue; }
        if (this.done) { this.failed = true; continue; }
        const value = strictReadbackJson(data);
        if (!object(value) || value.error || !Array.isArray(value.choices) || value.choices.length > 1) { this.failed = true; continue; }
        if (this.validFinish && value.choices.length) { this.failed = true; continue; }
        for (const choice of value.choices) {
          if (!object(choice) || choice.index !== undefined && choice.index !== 0) { this.failed = true; continue; }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (['stop', 'tool_calls', 'function_call'].includes(String(choice.finish_reason)) && !this.validFinish) this.validFinish = true;
          else this.failed = true;
          }
        }
      }
    } catch { this.failed = true; }
  }
  finish(): boolean {
    try { this.pending += this.decoder.decode(); } catch { this.failed = true; }
    return this.done && this.validFinish && !this.failed && !this.pending.trim();
  }
}

export function exactReadbackReport(records: readonly DeliveredReadback[]): string {
  if (!records.length) throw new Error('No delivered readback is available to report.');
  const literal = JSON.stringify(records.map(record => ({ path: record.path, encoding: 'utf-8', size: record.size,
    sha256: record.sha256, content: record.text })), null, 2);
  const runs = literal.match(/~+/g) ?? [];
  const fence = '~'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  const report = 'Verified agent file readback. Exact UTF-8 content is escaped in this JSON record:\n\n'
    + fence + 'json\n' + literal + '\n' + fence;
  if (!report || Buffer.byteLength(report, 'utf8') > MAX_READBACK_REPORT_BYTES) throw new Error('The exact readback report exceeds its bound; it was not truncated.');
  return report;
}
