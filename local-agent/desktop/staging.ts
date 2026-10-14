import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BudgetedInference } from './inference-gateway.ts';
import type { StageProgress, UtilityPreferences, TaskOutcome } from './renderer/types.ts';

interface Source { path: string; sha256: string; size: number; kind: 'text' | 'pdf'; cursor?: string | null; done?: boolean }
/**
 * The host-owned project preflight is part of a read-stage checkpoint.  Keep
 * only its bounded digest/context here: the preflight is rerun on resume and
 * the digest makes a changed manifest or selected skill invalidate summaries.
 */
export interface PreflightCheckpoint { digest: string; context?: string }
export interface Checkpoint { version: 1 | 2; request: string; modelDigest: string; sources: Source[]; summaries: string[]; textOffset: number;
  phase: 'reading' | 'reducing' | 'ready' | 'agent' | 'finished'; context?: string; completed: number; stage: StageProgress;
  preflight?: PreflightCheckpoint;
  outcome?: { status: TaskOutcome['status']; finishReason: string } }

export interface StagedPreflight { digest: string; context?: string }
export class StagedWork {
  private client?: Client; private transport?: StdioClientTransport;
  private cancelRead?: () => void;
  private options: { directory: string; executable: string; roots: string[]; files: string[];
    utilities: UtilityPreferences; inference: BudgetedInference; signal: AbortSignal; onStage: (stage: StageProgress) => void };
  constructor(options: StagedWork['options']) { this.options = options; }
  async readCheckpoint(): Promise<Checkpoint | undefined> {
    try {
      const raw = await readFile(path.join(this.options.directory, 'checkpoint.json'), 'utf8');
      if (raw.length > 25_000_000) throw new Error('The staged task checkpoint is too large.');
      const value = JSON.parse(raw) as Checkpoint;
      if (value.version !== 1 && value.version !== 2 || !Array.isArray(value.sources) || !Array.isArray(value.summaries) || typeof value.request !== 'string' || !Number.isInteger(value.completed)) throw new Error('The task checkpoint is invalid.');
      if (value.preflight !== undefined && (typeof value.preflight !== 'object' || typeof value.preflight.digest !== 'string' || value.preflight.digest.length > 256 || value.preflight.context !== undefined && (typeof value.preflight.context !== 'string' || Buffer.byteLength(value.preflight.context, 'utf8') > 128 * 1024))) throw new Error('The task checkpoint preflight is invalid.');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async save(checkpoint: Checkpoint) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.options.directory, 'checkpoint.json'); const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 }); await rename(temporary, target);
    this.options.onStage(checkpoint.stage);
  }
  async mark(phase: 'agent' | 'finished') {
    const value = await this.readCheckpoint(); if (!value) return;
    value.phase = phase; value.stage = { stage: phase === 'agent' ? 'Agent working' : 'Completed', resumable: false, message: phase === 'agent' ? 'Actions require approval. Interrupted agent actions are never replayed by resume.' : 'Task completed.' };
    await this.save(value);
  }
  async finishOutcome(status: TaskOutcome['status'], finishReason: string) {
    const value = await this.readCheckpoint(); if (!value) return;
    if (['reading', 'reducing', 'ready'].includes(value.phase) && status !== 'completed') {
      value.outcome = { status, finishReason };
      value.stage = { ...value.stage, resumable: true, message: finishReason };
      await this.save(value); return;
    }
    // Only read stages resume automatically. A terminal agent outcome remains closed.
    value.phase = 'finished'; value.outcome = { status, finishReason };
    value.stage = { stage: status === 'completed' ? 'Completed' : 'Task ended', resumable: false, message: finishReason };
    await this.save(value);
  }
  private async connect() {
    this.options.signal.throwIfAborted();
    this.transport = new StdioClientTransport({ command: this.options.executable, args: [], env: {
      PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMPDIR: process.env.TMPDIR ?? '',
      LOCAL_AGENT_MODE: 'assistant', LOCAL_AGENT_GRANTED_ROOTS: JSON.stringify(this.options.roots), LOCAL_AGENT_GRANTED_FILES: JSON.stringify(this.options.files),
      LOCAL_AGENT_UTILITIES: JSON.stringify({ ...this.options.utilities, projectSearch: false, webResearch: false }), LOCAL_AGENT_TOOL_RESULT_CHARS: '3000' } });
    this.client = new Client({ name: 'local-agent-stages', version: '0.5.0-alpha.1' });
    this.cancelRead = () => { void this.client?.close().catch(() => {}); void this.transport?.close().catch(() => {}); };
    this.options.signal.addEventListener('abort', this.cancelRead, { once: true });
    this.options.signal.throwIfAborted();
    await this.client.connect(this.transport);
    this.options.signal.throwIfAborted();
  }
  private async tool(name: string, args: Record<string, unknown>): Promise<any> {
    if (this.options.signal.aborted) throw new Error('Response stopped.');
    const result = await this.client!.callTool({ name, arguments: args }, undefined, { signal: this.options.signal, timeout: 180_000 });
    let value: any = result.structuredContent;
    if (!value) { const text = (result.content as any[]).filter(item => item.type === 'text').map(item => item.text).join('\n'); value = JSON.parse(text); }
    if ((result.isError || value.ok === false) && value.error !== 'scanned_pdf_unsupported') throw new Error(value.message ?? 'A staged file could not be read.');
    return value;
  }
  private async boundSummaries(checkpoint: Checkpoint) {
    if (checkpoint.summaries.length < 8) return;
    const reduced: string[] = [];
    for (let index = 0; index < checkpoint.summaries.length; index += 2) reduced.push(await this.options.inference.summarize(checkpoint.summaries.slice(index, index + 2).join('\n\n'), this.options.signal, checkpoint.request));
    checkpoint.summaries = reduced;
  }
  async run(request: string, modelDigest: string, resume = false, preflight?: StagedPreflight): Promise<string> {
    let checkpoint = resume ? await this.readCheckpoint() : undefined;
    if (resume && (!checkpoint || ['agent', 'finished'].includes(checkpoint.phase))) throw new Error('Only paused read-only stages can resume. Send a new request to continue an interrupted agent turn.');
    if (resume && checkpoint!.request !== request) throw new Error('The resumed request does not match its checkpoint.');
    try {
      if (this.options.utilities.fileReading && this.options.files.length) await this.connect();
      const sources: Source[] = [];
      if (this.client) for (const file of this.options.files) {
        const metadata = await this.tool('inspect_file', { path: file });
        sources.push({ path: file, sha256: metadata.sha256, size: metadata.size, kind: metadata.kind });
      }
      const preflightChanged = checkpoint && ((checkpoint.preflight?.digest ?? undefined) !== (preflight?.digest ?? undefined));
      if (checkpoint && (checkpoint.modelDigest !== modelDigest || sources.length !== checkpoint.sources.length || sources.some((source, index) => source.path !== checkpoint!.sources[index].path || source.sha256 !== checkpoint!.sources[index].sha256) || preflightChanged)) {
        checkpoint = undefined; this.options.onStage({ stage: 'Restarting read stages', message: preflightChanged ? 'The project preflight changed. Previous summaries were invalidated.' : 'The model or source files changed. Previous summaries were invalidated.', resumable: true });
      }
      if (checkpoint?.version === 1) checkpoint.version = 2;
      checkpoint ??= { version: 2, request, modelDigest, sources, summaries: [], textOffset: 0, phase: 'reading', completed: 0, stage: { stage: 'Reading local sources', completed: 0, resumable: true },
        ...(preflight ? { preflight: { digest: preflight.digest, context: preflight.context } } : {}) };
      if (checkpoint.phase === 'ready') return checkpoint.context ?? '';
      await this.save(checkpoint);
      for (const source of checkpoint.sources) {
        while (!source.done) {
          if (this.options.signal.aborted) throw new Error('Response stopped.');
          const result = await this.tool(source.kind === 'pdf' ? 'read_pdf' : 'read_file', { path: source.path, cursor: source.cursor ?? undefined, expected_sha256: source.sha256, max_chars: Math.min(1800, Math.floor(this.options.inference.currentProfile.contextTokens / 5)) });
          const contents = source.kind === 'pdf' ? (result.pages ?? []).map((page: any) => `[${source.path} page ${page.page}, character ${page.start_char ?? 0}]\n${page.text}`).join('\n')
            : `[${source.path} line ${result.start_line ?? 1}, column ${result.start_column ?? 1}]\n${result.text ?? ''}`;
          if (result.ok === false) this.options.onStage({ stage: 'PDF page needs OCR', message: 'An image-only page has no readable text. Continuing with available text pages; OCR is unsupported.', resumable: true });
          checkpoint.summaries.push(await this.options.inference.summarize(result.ok === false ? `${contents}\nNo extractable text in this source page. OCR is unsupported; its contents are unknown.` : contents, this.options.signal, request));
          await this.boundSummaries(checkpoint);
          source.cursor = result.next_cursor ?? null; source.done = result.eof === true || !source.cursor; checkpoint.completed++;
          checkpoint.stage = { stage: 'Reading local sources', completed: checkpoint.completed, message: path.basename(source.path), resumable: true }; await this.save(checkpoint);
        }
      }
      // A large pasted request is also retained in the durable checkpoint and
      // summarized sequentially; short requests stay verbatim in the final prompt.
      if (await this.options.inference.count({ messages: [{ role: 'user', content: request }] }, this.options.signal) > Math.floor(this.options.inference.currentProfile.contextTokens * 0.3)) {
        while (checkpoint.textOffset < request.length) {
          let end = Math.min(request.length, checkpoint.textOffset + 1800);
          while (end > checkpoint.textOffset + 1 && await this.options.inference.count({ messages: [{ role: 'user', content: request.slice(checkpoint.textOffset, end) }] }, this.options.signal) > Math.floor(this.options.inference.currentProfile.contextTokens * 0.4)) end = checkpoint.textOffset + Math.floor((end - checkpoint.textOffset) / 2);
          checkpoint.summaries.push(await this.options.inference.summarize(`[User request characters ${checkpoint.textOffset}–${end}]\n${request.slice(checkpoint.textOffset, end)}`, this.options.signal));
          await this.boundSummaries(checkpoint);
          checkpoint.textOffset = end; checkpoint.completed++;
          checkpoint.stage = { stage: 'Processing long request', completed: end, total: request.length, resumable: true }; await this.save(checkpoint);
        }
      }
      checkpoint.phase = 'reducing';
      let summaries = checkpoint.summaries;
      while (summaries.length > 1 || (summaries.length && await this.options.inference.count({ messages: [{ role: 'user', content: summaries[0] }] }, this.options.signal) > Math.floor(this.options.inference.currentProfile.contextTokens * 0.35))) {
        const reduced: string[] = [];
        for (let index = 0; index < summaries.length; index += 2) {
          reduced.push(await this.options.inference.summarize(summaries.slice(index, index + 2).join('\n\n'), this.options.signal, request));
          checkpoint.stage = { stage: 'Combining source summaries', completed: Math.min(index + 2, summaries.length), total: summaries.length, resumable: true }; this.options.onStage(checkpoint.stage);
        }
        if (reduced.join('\n').length >= summaries.join('\n').length && reduced.length >= summaries.length) throw new Error('The model could not reduce the source summary safely. Choose another local model.');
        summaries = reduced; checkpoint.summaries = summaries; await this.save(checkpoint);
      }
      checkpoint.context = summaries.join('\n'); checkpoint.phase = 'ready';
      checkpoint.stage = { stage: 'Sources ready', completed: checkpoint.completed, resumable: true, message: 'Source summaries are local and may omit details; original files remain available through paged reads.' }; await this.save(checkpoint);
      return checkpoint.context;
    } finally { if (this.cancelRead) this.options.signal.removeEventListener('abort', this.cancelRead); await this.client?.close().catch(() => {}); }
  }
}
