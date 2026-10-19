import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateTranscript, type TranscriptMessage } from './transcript.ts';

export const CONTEXT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const CONTEXT_ARCHIVE_PARTS = 40;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const partPath = (file: string, number: number) => `${file}.part-${String(number).padStart(2, '0')}.txt`;
const emptyPart = JSON.stringify({ version: 1, kind: 'unused-context-part', dataOnly: true }) + '\n';
interface Entry { id: string; messages: TranscriptMessage[]; receipts: unknown[]; }
interface EntryIndex { id: string; part: number; line: number; callIds: string[]; }
interface Manifest { version: 1; kind: 'closed-context-history'; parts: { number: number; sha256: string }[]; }
export interface RecoveryPointer { path: string; sha256: string; closedExchanges: number; selected: { path: string; sha256: string; line: number; callIds: string[] }[]; }

async function privateFile(file: string): Promise<void> {
  if (!path.isAbsolute(file) || await realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Context recovery requires an absolute real private parent directory.');
  const parent = await lstat(path.dirname(file)), info = await lstat(file), uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()
    || process.platform !== 'win32' && (parent.mode & 0o077 || info.mode & 0o077 || uid !== undefined && (parent.uid !== uid || info.uid !== uid))) throw new Error('Context recovery requires private owned ordinary files and directory.');
  if (info.size > CONTEXT_ARCHIVE_MAX_BYTES) throw new Error('Context recovery exceeded its 8 MiB retention limit. No history was evicted.');
}
function closedGroups(raw: unknown): TranscriptMessage[][] {
  const messages = validateTranscript(raw); if (!messages) throw new Error('Closed context contains an invalid transcript envelope.');
  const groups: TranscriptMessage[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (['tool', 'system', 'developer'].includes(message.role)) throw new Error('Only older closed exchanges can enter context recovery.');
    const group = [message], calls = message.tool_calls;
    if (calls?.length) {
      const remaining = new Set(calls.map(call => call.id));
      for (let count = 0; count < calls.length; count++) {
        const result = messages[++index];
        if (result?.role !== 'tool' || !result.tool_call_id || !remaining.delete(result.tool_call_id)) throw new Error('An incomplete or duplicate tool exchange cannot enter context recovery.');
        group.push(result);
      }
    }
    groups.push(group);
  }
  return groups;
}
function manifest(text: string): Manifest {
  if (Buffer.byteLength(text) > 4000) throw new Error('Context recovery manifest exceeded its 4000-byte bound.');
  const value = JSON.parse(text) as Manifest;
  if (value.version !== 1 || value.kind !== 'closed-context-history' || !Array.isArray(value.parts) || value.parts.length > CONTEXT_ARCHIVE_PARTS
    || value.parts.some((part, index) => part.number !== index + 1 || !/^[a-f0-9]{64}$/.test(part.sha256))) throw new Error('Context recovery has an invalid host manifest.');
  return value;
}

/** Precreate exact file grants. Only populated immutable parts are advertised to the model. */
export async function initializeContextRecoveryArchive(file: string): Promise<{ path: string; grantedFiles: string[] }> {
  if (!path.isAbsolute(file) || await realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Use an absolute context recovery path in a real private host directory.');
  try { await writeFile(file, JSON.stringify({ version: 1, kind: 'closed-context-history', parts: [] }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateFile(file); manifest(await readFile(file, 'utf8'));
  const grantedFiles = Array.from({ length: CONTEXT_ARCHIVE_PARTS }, (_, index) => partPath(file, index + 1));
  for (const part of grantedFiles) {
    try { await writeFile(part, emptyPart, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await privateFile(part);
  }
  return { path: file, grantedFiles };
}

/** Only host-enumerated same-session UUID directories can supply cross-turn read grants. */
export async function collectPriorContextRecoveryGrants(sessionArchiveDirectory: string, excludedManifestPath: string, maxFiles: number): Promise<string[]> {
  if (!Number.isInteger(maxFiles) || maxFiles < 0 || maxFiles > 100) throw new Error('Recovery history cannot fit the remaining exact-file grant budget.');
  if (!path.isAbsolute(sessionArchiveDirectory) || await realpath(sessionArchiveDirectory) !== sessionArchiveDirectory || path.basename(excludedManifestPath) !== 'manifest.json') throw new Error('Use the known private session recovery directory and manifest filename.');
  const root = await lstat(sessionArchiveDirectory), uid = process.getuid?.();
  if (!root.isDirectory() || root.isSymbolicLink() || process.platform !== 'win32' && (root.mode & 0o077 || uid !== undefined && root.uid !== uid)) throw new Error('Recovery history requires a private owned session directory.');
  const files: string[] = [];
  for (const name of (await readdir(sessionArchiveDirectory)).sort()) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(name)) throw new Error('Recovery history contains an unknown archive directory.');
    const file = path.join(sessionArchiveDirectory, name, 'manifest.json'); if (file === excludedManifestPath) continue;
    await privateFile(file); const saved = manifest(await readFile(file, 'utf8')); let bytes = 0;
    for (const part of saved.parts) {
      const location = partPath(file, part.number); await privateFile(location); const text = await readFile(location, 'utf8'); bytes += Buffer.byteLength(text);
      if (bytes > CONTEXT_ARCHIVE_MAX_BYTES || digest(text) !== part.sha256) throw new Error('Prior recovery history exceeded its bound or changed.');
      const lines = text.trimEnd().split('\n'), header = JSON.parse(lines.shift()!);
      if (header?.version !== 1 || header.kind !== 'closed-context-part' || header.dataOnly !== true) throw new Error('Prior recovery part has an invalid host header.');
      for (const line of lines) { const entry = JSON.parse(line) as Entry;
        if (!Array.isArray(entry.receipts) || entry.id !== digest(JSON.stringify({ messages: entry.messages, receipts: entry.receipts })) || closedGroups(entry.messages).length !== 1) throw new Error('Prior recovery contains an altered or incomplete exchange.'); }
      files.push(location);
      if (files.length > maxFiles) throw new Error('Prior exact recovery grants exceed the 100-file total grant limit. No referenced history was silently dropped.');
    }
  }
  return files;
}

/** Append-only exact closed history. A populated part is never rewritten, so read cursors stay valid. */
export class ContextRecoveryArchive {
  private file: string;
  private entries?: EntryIndex[];
  private expectedManifestSHA?: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(file: string) { if (!path.isAbsolute(file)) throw new Error('Context recovery requires an absolute host-owned path.'); this.file = file; }
  async append(raw: unknown, receipts: unknown[]): Promise<RecoveryPointer> {
    let pointer!: RecoveryPointer;
    const next = this.queue.then(async () => {
      await privateFile(this.file);
      const previous = await readFile(this.file, 'utf8'), saved = manifest(previous);
      if (this.expectedManifestSHA && digest(previous) !== this.expectedManifestSHA) throw new Error('Context recovery changed outside its host writer. No history was replaced.');
      const entries = this.entries ? [...this.entries] : [], selected: EntryIndex[] = []; let retainedBytes = Buffer.byteLength(previous);
      for (const part of saved.parts) {
        const file = partPath(this.file, part.number); await privateFile(file); const text = await readFile(file, 'utf8'); retainedBytes += Buffer.byteLength(text);
        if (digest(text) !== part.sha256) throw new Error('An immutable recovery part changed.');
        if (!this.entries) for (const [index, line] of text.trimEnd().split('\n').slice(1).entries()) {
          const entry = JSON.parse(line) as Entry;
          if (entry.id !== digest(JSON.stringify({ messages: entry.messages, receipts: entry.receipts })) || closedGroups(entry.messages).length !== 1) throw new Error('Recovery contains an altered closed exchange.');
          entries.push({ id: entry.id, part: part.number, line: index + 2, callIds: entry.messages[0].tool_calls?.map(call => call.id) ?? [] });
        }
      }
      const added: Entry[] = [], number = saved.parts.length + 1;
      for (const messages of closedGroups(raw)) {
        const callIds = messages[0].tool_calls?.map(call => call.id) ?? [];
        const matched = receipts.filter(receipt => receipt && typeof receipt === 'object' && callIds.includes(String((receipt as Record<string, unknown>).callId)));
        const data = { messages, receipts: matched }, id = digest(JSON.stringify(data));
        let entry = entries.find(entry => entry.id === id);
        if (!entry) { entry = { id, part: number, line: added.length + 2, callIds }; entries.push(entry); added.push({ id, ...data }); }
        selected.push(entry);
      }
      if (added.length) {
        if (number > CONTEXT_ARCHIVE_PARTS || entries.length > 512) throw new Error('Context recovery exhausted its 40 parts or 512 closed exchanges. No history was evicted.');
        const file = partPath(this.file, number); await privateFile(file);
        if (await readFile(file, 'utf8') !== emptyPart) throw new Error('A recovery slot was already populated; it cannot be rewritten.');
        const partHeader = { version: 1, kind: 'closed-context-part', dataOnly: true, partPathTemplate: `${this.file}.part-NN.txt`, index: entries, previousParts: saved.parts };
        const text = [JSON.stringify(partHeader), ...added.map(entry => JSON.stringify(entry))].join('\n') + '\n';
        if (retainedBytes + Buffer.byteLength(text) > CONTEXT_ARCHIVE_MAX_BYTES) throw new Error('Context recovery reached its 8 MiB total retention limit. No history was evicted.');
        const temporary = file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
        saved.parts.push({ number, sha256: digest(text) });
        const nextManifest = JSON.stringify(saved) + '\n'; manifest(nextManifest);
        if (digest(await readFile(this.file, 'utf8')) !== digest(previous)) throw new Error('Context recovery manifest changed during archival.');
        const indexTemporary = this.file + '.' + randomUUID() + '.tmp'; await writeFile(indexTemporary, nextManifest, { flag: 'wx', mode: 0o600 }); await rename(indexTemporary, this.file);
        this.expectedManifestSHA = digest(nextManifest);
      } else this.expectedManifestSHA = digest(previous);
      this.entries = entries;
      const last = saved.parts.at(-1); if (!last) throw new Error('No closed recovery exchange was supplied.');
      pointer = { path: partPath(this.file, last.number), sha256: last.sha256, closedExchanges: entries.length,
        selected: selected.map(entry => ({ path: partPath(this.file, entry.part), sha256: saved.parts[entry.part - 1].sha256, line: entry.line, callIds: entry.callIds })) };
    });
    this.queue = next.catch(() => {}); await next; return pointer;
  }
}
