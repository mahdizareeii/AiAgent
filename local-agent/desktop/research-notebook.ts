import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NOTEBOOK_DIR = '.free-local-agent';
const NOTEBOOK_FILE = 'research-notebook.json';
const MAX_NOTES = 1000;
const MAX_BYTES = 8 * 1024 * 1024;

export interface ResearchNote {
  id: string;
  url: string;
  title: string;
  publisher?: string;
  retrievedAt: string;
  quote?: string;
  summary: string;
  taskId?: string;
  fileRefs?: string[];
}

export interface ResearchNotebook { version: 1; updatedAt: string; notes: ResearchNote[] }

export function notebookPath(workspacePath: string): string {
  if (!path.isAbsolute(workspacePath)) throw new Error('Research notebooks require an absolute workspace path.');
  return path.join(path.resolve(workspacePath), NOTEBOOK_DIR, NOTEBOOK_FILE);
}

const validUrl = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && /^(?:https?:\/\/|file:\/\/)/i.test(value);
function normalizeNote(value: unknown): ResearchNote | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !validUrl(item.url) || typeof item.title !== 'string' || typeof item.retrievedAt !== 'string' || typeof item.summary !== 'string') return;
  if (item.title.length > 1000 || item.summary.length > 100_000 || (item.quote !== undefined && typeof item.quote !== 'string')) return;
  return { id: item.id, url: item.url, title: item.title, ...(typeof item.publisher === 'string' ? { publisher: item.publisher.slice(0, 500) } : {}), retrievedAt: item.retrievedAt,
    ...(typeof item.quote === 'string' ? { quote: item.quote.slice(0, 25_000) } : {}), summary: item.summary, ...(typeof item.taskId === 'string' ? { taskId: item.taskId } : {}),
    ...(Array.isArray(item.fileRefs) ? { fileRefs: item.fileRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 100) } : {}) };
}

export async function loadResearchNotebook(workspacePath: string): Promise<ResearchNotebook> {
  const target = notebookPath(workspacePath);
  try {
    const raw = await readFile(target, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('The research notebook exceeds its size limit.');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const notes = Array.isArray(parsed.notes) ? parsed.notes.map(normalizeNote).filter((note): note is ResearchNote => !!note).slice(-MAX_NOTES) : [];
    return { version: 1, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(), notes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, updatedAt: new Date(0).toISOString(), notes: [] };
    throw error;
  }
}

async function saveNotebook(workspacePath: string, notebook: ResearchNotebook): Promise<ResearchNotebook> {
  const target = notebookPath(workspacePath); const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), notes: notebook.notes.slice(-MAX_NOTES) }, null, 2);
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('The research notebook has reached its size limit. Delete older notes before adding more.');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
  return JSON.parse(body) as ResearchNotebook;
}

export async function addResearchNote(workspacePath: string, input: Omit<ResearchNote, 'id'> & { id?: string }): Promise<ResearchNote> {
  const notebook = await loadResearchNotebook(workspacePath);
  const note = normalizeNote({ ...input, id: input.id ?? randomUUID() });
  if (!note) throw new Error('Research notes require a source URL, title, retrieval date, and summary.');
  notebook.notes = [...notebook.notes.filter(item => item.id !== note.id), note];
  await saveNotebook(workspacePath, notebook);
  return note;
}

export async function listResearchNotes(workspacePath: string, query = ''): Promise<ResearchNote[]> {
  const notes = (await loadResearchNotebook(workspacePath)).notes;
  const needle = query.trim().toLocaleLowerCase(); if (!needle) return notes;
  return notes.filter(note => [note.title, note.publisher, note.summary, note.quote, note.url].some(value => value?.toLocaleLowerCase().includes(needle)));
}

export async function deleteResearchNotes(workspacePath: string, ids: string[]): Promise<number> {
  const notebook = await loadResearchNotebook(workspacePath); const remove = new Set(ids); const before = notebook.notes.length;
  notebook.notes = notebook.notes.filter(note => !remove.has(note.id));
  if (notebook.notes.length !== before) await saveNotebook(workspacePath, notebook);
  return before - notebook.notes.length;
}

export async function clearResearchNotebook(workspacePath: string): Promise<number> {
  const notebook = await loadResearchNotebook(workspacePath); const count = notebook.notes.length;
  if (count) await saveNotebook(workspacePath, { ...notebook, notes: [] });
  return count;
}

export async function exportResearchNotebook(workspacePath: string, format: 'json' | 'markdown' = 'markdown'): Promise<string> {
  const notebook = await loadResearchNotebook(workspacePath);
  if (format === 'json') return JSON.stringify(notebook, null, 2);
  return notebook.notes.map(note => `## ${note.title}\n\n- Source: ${note.url}\n- Publisher: ${note.publisher ?? 'Unknown'}\n- Retrieved: ${note.retrievedAt}\n${note.fileRefs?.length ? `- Files: ${note.fileRefs.join(', ')}\n` : ''}\n${note.summary}\n${note.quote ? `\n> ${note.quote.replaceAll('\n', '\n> ')}\n` : ''}`).join('\n');
}

/** Stable digest used when attaching notebook evidence to a task record. */
export function researchNoteDigest(note: ResearchNote): string { return createHash('sha256').update(JSON.stringify(note)).digest('hex'); }

