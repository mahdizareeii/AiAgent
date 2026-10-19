import type { Attachment } from './types';

export interface DraftSnapshot { draft: string; files: Attachment[]; revision: number; }
type Save = (value: DraftSnapshot & { sessionId: string }) => Promise<{ saved: boolean; revision: number }>;
interface Entry { value: DraftSnapshot; dirty: boolean; pending?: Promise<void>; timer?: ReturnType<typeof setTimeout>; }
const copy = (value: DraftSnapshot): DraftSnapshot => ({ ...value, files: value.files.map(file => ({ ...file })) });

/** One ordered writer per conversation. Navigation awaits flush before loading another snapshot. */
export class DraftStore {
  private entries = new Map<string, Entry>();
  private save: Save;
  private onError: (id: string, error: unknown) => void;
  private delay: number;
  constructor(save: Save, onError: (id: string, error: unknown) => void = () => {}, delay = 250) {
    this.save = save; this.onError = onError; this.delay = delay;
  }

  restore(id: string, snapshot: DraftSnapshot): DraftSnapshot {
    const entry = this.entries.get(id);
    if (entry?.dirty || entry?.pending) return copy(entry.value);
    const value = copy(snapshot);
    if (entry) value.revision = Math.max(entry.value.revision, value.revision);
    this.entries.set(id, { value, dirty: false });
    return copy(value);
  }

  queue(id: string, draft: string, files: Attachment[]): void {
    const entry = this.entries.get(id) ?? { value: { draft: '', files: [], revision: 0 }, dirty: false };
    entry.value = { draft, files: files.map(file => ({ ...file })), revision: entry.value.revision + 1 };
    entry.dirty = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.flush(id).catch(error => this.onError(id, error)); }, this.delay);
  }

  async flush(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (entry.pending) { await entry.pending; if (entry.dirty) await this.flush(id); return; }
    if (!entry.dirty) return;
    const value = copy(entry.value);
    entry.pending = (async () => {
      const result = await this.save({ sessionId: id, ...value });
      if (!result.saved) {
        // Keep the user's content, then allocate a fresh revision on explicit retry.
        entry.value.revision = Math.max(entry.value.revision, result.revision) + 1;
        throw new Error('This conversation changed while saving its draft. Your text is retained; retry navigation.');
      }
      if (entry.value.revision === value.revision) entry.dirty = false;
    })();
    try { await entry.pending; } finally { entry.pending = undefined; }
    if (entry.dirty) await this.flush(id);
  }

  async flushAll(): Promise<void> { await Promise.all([...this.entries.keys()].map(id => this.flush(id))); }
  dispose(): void { for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer); }
}

/** The host keeps the window open until this acknowledgement follows every queued write. */
export async function flushBeforeClose(store: DraftStore, acknowledge: (error?: string) => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  let failure: string | undefined;
  try { await store.flushAll(); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); onError(error); }
  await acknowledge(failure);
}
