import { createHash } from 'node:crypto';

export type TranscriptValue = null | boolean | number | string | TranscriptValue[] | { [key: string]: TranscriptValue };
export interface TranscriptToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string | { [key: string]: TranscriptValue } };
}
export interface TranscriptMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: TranscriptValue;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: TranscriptToolCall[];
  tool_call_id?: string;
  name?: string;
}
const MAX_MESSAGES = 512;
const MAX_BYTES = 8 * 1024 * 1024;
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const FIELDS = new Set(['role', 'content', 'reasoning_content', 'reasoning', 'tool_calls', 'tool_call_id', 'name']);
const clone = <T>(value: T): T => structuredClone(value);
function jsonValue(value: unknown, depth = 0): value is TranscriptValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && jsonValue(item, depth + 1));
}

function toolArguments(value: unknown): boolean {
  if (typeof value === 'string') {
    // The provider treats an empty argument string as an argumentless call.
    try { return toolArguments(JSON.parse(value || '{}')); } catch { return false; }
  }
  return !!value && typeof value === 'object' && !Array.isArray(value) && jsonValue(value);
}

/** Disk history is data only. Reject a whole malformed envelope rather than lose call/result pairs. */
export function validateTranscript(value: unknown): TranscriptMessage[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) return; } catch { return; }
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (!ROLES.has(String(message.role)) || Object.keys(message).some(key => !FIELDS.has(key))) return;
    if (Object.hasOwn(message, 'content') && !jsonValue(message.content)) return;
    for (const key of ['reasoning_content', 'reasoning', 'tool_call_id', 'name']) {
      if (Object.hasOwn(message, key) && typeof message[key] !== 'string') return;
    }
    if (message.role === 'tool' && (!message.tool_call_id || typeof message.tool_call_id !== 'string')) return;
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return;
      const ids = new Set<string>();
      for (const rawCall of message.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) return;
        const call = rawCall as Record<string, unknown>, fn = call.function as Record<string, unknown> | undefined;
        if (Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) || typeof call.id !== 'string' || !call.id ||
          call.type !== undefined && call.type !== 'function' || !fn || typeof fn !== 'object' || Array.isArray(fn) ||
          Object.keys(fn).some(key => !['name', 'arguments'].includes(key)) || typeof fn.name !== 'string' || !fn.name ||
          !toolArguments(fn.arguments) || ids.has(call.id)) return;
        ids.add(call.id);
      }
    }
  }
  return clone(value as TranscriptMessage[]);
}

function messageKey(message: TranscriptMessage): string {
  const { reasoning_content: _reasoningContent, reasoning: _reasoning, ...envelope } = message;
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}
function responseMessage(value: unknown): TranscriptMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  const candidate = Object.fromEntries(Object.entries(raw).filter(([key]) => FIELDS.has(key)));
  candidate.role = 'assistant';
  return validateTranscript([candidate])?.[0];
}
function systems(message: TranscriptMessage): boolean { return message.role === 'system' || message.role === 'developer'; }

/** The gateway observes provider envelopes; UI prose and thought display never enter this history. */
export class CanonicalTranscript {
  private seed: TranscriptMessage[];
  private captured = new Map<number, TranscriptMessage>();
  private localLength = 0;
  private latest: TranscriptMessage[];
  private interruptedHistory = false;
  private requestObserved = false;
  constructor(seed: readonly TranscriptMessage[] = []) {
    const validated = validateTranscript(seed);
    if (!validated) throw new Error('The saved local model transcript is invalid or exceeds its retention limit.');
    this.seed = this.completedPrefix(validated).filter(message => !systems(message));
    this.latest = validated;
  }
  observeRequest(raw: unknown): TranscriptMessage[] {
    const validated = validateTranscript(raw);
    if (!validated) throw new Error('The local provider transcript is invalid or exceeds its retention limit.');
    const envelope = validated.filter(systems);
    let local = validated.filter(message => !systems(message));
    const containsSeed = this.seed.length > 0 && local.length >= this.seed.length &&
      this.seed.every((message, index) => messageKey(message) === messageKey(local[index]));
    if (containsSeed) local = local.slice(this.seed.length);
    local = local.map((message, index) => {
      const captured = this.captured.get(index);
      if (!captured || message.role !== 'assistant') return message;
      // Goose may deserialize arguments and omit null content. Call IDs identify the exact exchange.
      const sameCalls = captured.tool_calls?.length && message.tool_calls?.length &&
        captured.tool_calls.length === message.tool_calls.length && captured.tool_calls.every((call, position) => call.id === message.tool_calls![position].id);
      return sameCalls || messageKey(captured) === messageKey(message) ? clone(captured) : message;
    });
    this.localLength = local.length;
    this.latest = [...envelope, ...clone(this.seed), ...local];
    this.requestObserved = true;
    return clone(this.latest);
  }
  recordCompletion(request: readonly TranscriptMessage[], value: unknown, finishReason?: unknown): void {
    const message = responseMessage(value);
    if (!message) throw new Error('The local model returned an invalid completed response envelope.');
    if (message.tool_calls?.length && finishReason !== undefined && finishReason !== 'tool_calls' && finishReason !== 'stop') {
      throw new Error('The local model did not complete its tool calls. No call from this response can run.');
    }
    this.captured.set(this.localLength, message);
    const validated = validateTranscript([...request, message]);
    if (!validated) throw new Error('The local model transcript exceeded its retention limit.');
    this.latest = validated;
  }
  recordClosing(value: unknown, unstartedRequest?: string): void {
    const message = responseMessage(value);
    if (!message || message.tool_calls?.length) throw new Error('The reserved final response returned an invalid answer or a tool call.');
    const prefix = clone(this.completedPrefix(this.latest));
    this.interruptedHistory ||= prefix.length !== this.latest.length;
    if (!this.requestObserved && unstartedRequest !== undefined) prefix.push({ role: 'user', content: unstartedRequest });
    const validated = validateTranscript([...prefix, message]);
    if (!validated) throw new Error('The local model transcript exceeded its retention limit.');
    this.latest = validated;
  }
  get snapshot(): TranscriptMessage[] { return clone(this.completedPrefix(this.latest)); }
  get incomplete(): boolean { return this.interruptedHistory || this.completedPrefix(this.latest).length !== this.latest.length; }
  private completedPrefix(messages: TranscriptMessage[]): TranscriptMessage[] {
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === 'tool') return messages.slice(0, index);
      const calls = messages[index].tool_calls;
      if (!calls?.length) continue;
      const expected = new Set(calls.map(call => call.id));
      let end = index + 1;
      while (messages[end]?.role === 'tool') {
        const id = messages[end].tool_call_id;
        if (!id || !expected.delete(id)) return messages.slice(0, index);
        end++;
      }
      if (expected.size) return messages.slice(0, index);
      index = end - 1;
    }
    return messages;
  }
}

/** Assemble split UTF-8/SSE/tool argument fragments without storing an unfinished generation. */
export class StreamCompletionCapture {
  private decoder = new TextDecoder();
  private pending = '';
  private content = '';
  private reasoning = '';
  private reasoningContent = '';
  private calls = new Map<number, TranscriptToolCall>();
  private completed = false;
  private recorded = false;
  private finishReason?: string;
  private onComplete: (message: TranscriptMessage) => void;
  constructor(onComplete: (message: TranscriptMessage) => void) { this.onComplete = onComplete; }
  push(bytes: Uint8Array): void { this.pending += this.decoder.decode(bytes, { stream: true }); this.parse(); }
  finish(): void {
    this.pending += this.decoder.decode(); this.parse(true); this.record();
    if (!this.completed) throw new Error('The local model stream ended before its response completed.');
  }
  private parse(flush = false): void {
    this.pending = this.pending.replace(/\r\n/g, '\n');
    for (;;) {
      const boundary = this.pending.indexOf('\n\n');
      if (boundary < 0 && !flush) break;
      const frame = boundary < 0 ? this.pending : this.pending.slice(0, boundary);
      this.pending = boundary < 0 ? '' : this.pending.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { this.completed = true; this.record(); }
      else if (data) {
        const value = JSON.parse(data) as { choices?: { index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }[] };
        const choice = value.choices?.find(item => (item.index ?? 0) === 0);
        if (choice) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string') this.content += delta.content;
          if (typeof delta.reasoning === 'string') this.reasoning += delta.reasoning;
          if (typeof delta.reasoning_content === 'string') this.reasoningContent += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
            const fragment = raw as { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };
            const index = fragment.index ?? 0;
            const call = this.calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
            if (fragment.id) call.id += fragment.id;
            if (fragment.function?.name) call.function.name += fragment.function.name;
            if (fragment.function?.arguments) call.function.arguments = String(call.function.arguments) + fragment.function.arguments;
            this.calls.set(index, call);
          }
          if (choice.finish_reason) {
            this.finishReason = choice.finish_reason;
            this.completed = true; this.record();
          }
        }
      }
      if (boundary < 0) break;
    }
  }
  private record(): void {
    if (!this.completed || this.recorded || !this.content && !this.reasoning && !this.reasoningContent && !this.calls.size) return;
    const message: TranscriptMessage = { role: 'assistant', content: this.content || null,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}), ...(this.reasoningContent ? { reasoning_content: this.reasoningContent } : {}),
      ...(this.calls.size ? { tool_calls: [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) };
    const validated = validateTranscript([message]);
    if (!validated) throw new Error('The local model returned an invalid completed tool envelope.');
    if (message.tool_calls?.length && this.finishReason !== 'tool_calls' && this.finishReason !== 'stop') {
      throw new Error('The local model did not complete its tool calls. No call from this response can run.');
    }
    this.recorded = true; this.onComplete(validated[0]);
  }
}
