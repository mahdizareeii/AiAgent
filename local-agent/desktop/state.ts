import { z } from 'zod';
import type { Attachment, ChatMessage, Mode, UtilityPreferences } from './renderer/types.ts';
export const DEFAULT_UTILITIES: UtilityPreferences = { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false };
export const utilitySchema = z.object({ fileReading: z.boolean(), projectSearch: z.boolean(), fileEditing: z.boolean(), terminal: z.boolean(), webResearch: z.boolean() }).strict();
export interface SavedSession { id: string; title: string; updatedAt: string; mode: Mode; projectPath?: string; messages: ChatMessage[]; files: Attachment[] }
export interface SavedState { version: 2; selectedModel: string | null; projectPath?: string; mode: Mode; utilities: UtilityPreferences; slowMode: boolean; sessions: SavedSession[] }
export const emptyState = (): SavedState => ({ version: 2, selectedModel: null, mode: 'assistant', utilities: { ...DEFAULT_UTILITIES }, slowMode: false, sessions: [] });
export function migrateState(value: unknown): SavedState {
  const schema = z.object({ version: z.union([z.literal(1), z.literal(2)]).optional(), selectedModel: z.string().max(256).nullable(),
    projectPath: z.string().optional(), mode: z.enum(['coding', 'research', 'assistant']), utilities: utilitySchema.optional(), slowMode: z.boolean().optional(),
    sessions: z.array(z.object({ id: z.string().uuid(), title: z.string(), updatedAt: z.string(), mode: z.enum(['coding', 'research', 'assistant']), projectPath: z.string().optional(),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })), files: z.array(z.object({ name: z.string(), path: z.string() })) })).max(1000) });
  const parsed = schema.parse(value);
  // Legacy catalog identifiers deliberately stay stable. External executable
  // paths are omitted, and the old model store is never touched by migration.
  return { ...parsed, version: 2, utilities: parsed.utilities ?? { ...DEFAULT_UTILITIES }, slowMode: parsed.slowMode ?? false };
}
export function effectiveUtilities(mode: Mode, preferences: UtilityPreferences): UtilityPreferences {
  return { fileReading: preferences.fileReading, projectSearch: mode === 'coding' && preferences.projectSearch,
    fileEditing: mode === 'coding' && preferences.fileEditing, terminal: mode === 'coding' && preferences.terminal,
    webResearch: mode === 'research' && preferences.webResearch };
}
