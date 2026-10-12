import { z } from 'zod';
import { appendThinking } from './thinking.ts';
import { restoreToolHistory } from './tool-history.ts';
import type { Attachment, ChatMessage, Mode, PluginPreferences, UtilityPreferences, TaskEffort, MemoryMode, ModelValidationRecord } from './renderer/types.ts';
export const DEFAULT_UTILITIES: UtilityPreferences = { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false };
export const utilitySchema = z.object({ fileReading: z.boolean(), projectSearch: z.boolean(), fileEditing: z.boolean(), terminal: z.boolean(), webResearch: z.boolean() }).strict();
export const DEFAULT_PLUGINS: PluginPreferences = { taskResearch: false };
export const pluginSchema = z.object({ taskResearch: z.boolean() }).strict();
export const memoryModeSchema = z.enum(['automatic', 'low-memory', 'experimental-disk']);
export const taskEffortSchema = z.enum(['standard', 'careful']);
const checkSchema = z.object({ id: z.string(), title: z.string(), status: z.enum(['passed', 'failed', 'unverified']), detail: z.string(), toolId: z.string().optional(),
  evidence: z.object({ operation: z.string().optional(), path: z.string().optional(), sha256: z.string().optional(), changed: z.boolean().optional(), actionId: z.string().optional(), complete: z.boolean().optional() }).optional() });
const outcomeSchema = z.object({ status: z.enum(['completed', 'blocked', 'cancelled', 'timed-out', 'incomplete']), finishReason: z.string(), checks: z.array(checkSchema).max(256),
  model: z.object({ id: z.string(), digest: z.string(), runtime: z.string(), contextTokens: z.number(), backend: z.string(), memoryMode: memoryModeSchema }).optional() });
const validationSchema = z.object({ id: z.string().uuid(), modelId: z.string(), digest: z.string(), templateHash: z.string(), runtime: z.string(), profileSignature: z.string(),
  startedAt: z.string(), completedAt: z.string().optional(), elapsedMs: z.number().optional(), status: z.enum(['running', 'passed', 'failed', 'cancelled']), checks: z.array(checkSchema).max(256), sessionId: z.string().uuid().optional() });
export interface SavedSession { id: string; title: string; updatedAt: string; mode: Mode; taskEffort?: TaskEffort; validationRecordId?: string; projectPath?: string; messages: ChatMessage[]; files: Attachment[] }
export interface SavedState { version: 4; selectedModel: string | null; projectPath?: string; mode: Mode; utilities: UtilityPreferences; plugins: PluginPreferences; slowMode: boolean;
  memoryMode: MemoryMode; defaultTaskEffort: TaskEffort; validationRecords: ModelValidationRecord[]; sessions: SavedSession[] }
export const emptyState = (): SavedState => ({ version: 4, selectedModel: null, mode: 'coding', utilities: { ...DEFAULT_UTILITIES }, plugins: { ...DEFAULT_PLUGINS }, slowMode: false,
  memoryMode: 'automatic', defaultTaskEffort: 'careful', validationRecords: [], sessions: [] });
export function migrateState(value: unknown): SavedState {
  const schema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(), selectedModel: z.string().max(256).nullable(),
    projectPath: z.string().optional(), mode: z.enum(['coding', 'research', 'assistant']), utilities: utilitySchema.optional(), plugins: pluginSchema.optional(), slowMode: z.boolean().optional(),
    memoryMode: memoryModeSchema.optional(), defaultTaskEffort: taskEffortSchema.optional(), validationRecords: z.array(validationSchema).max(100).optional(),
    sessions: z.array(z.object({ id: z.string().uuid(), title: z.string(), updatedAt: z.string(), mode: z.enum(['coding', 'research', 'assistant']), projectPath: z.string().optional(),
      taskEffort: taskEffortSchema.optional(), validationRecordId: z.string().uuid().optional(),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(),
        thinking: z.string().transform(text => appendThinking('', text)).optional(),
        tools: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), input: z.unknown().optional(), output: z.unknown().optional() })).optional(),
        toolsTruncated: z.boolean().optional(), outcome: outcomeSchema.optional() }).transform(message => {
        if (message.role !== 'assistant') return { role: message.role, content: message.content };
        if (!message.tools) return message;
        const history = restoreToolHistory(message.tools, message.toolsTruncated);
        return { ...message, tools: history.tools, ...(history.truncated ? { toolsTruncated: true } : {}) };
      })), files: z.array(z.object({ name: z.string(), path: z.string() })) })).max(1000) });
  const parsed = schema.parse(value);
  // Legacy catalog identifiers deliberately stay stable. External executable
  // paths are omitted, and the old model store is never touched by migration.
  // Preserve a pre-plugin store's explicit web opt-in during migration.
  // A saved plugin toggle is authoritative, including an explicit disable.
  return { ...parsed, version: 4, utilities: parsed.utilities ?? { ...DEFAULT_UTILITIES },
    plugins: parsed.plugins ?? { taskResearch: (parsed.version === undefined || parsed.version < 3) && parsed.utilities?.webResearch === true }, slowMode: parsed.slowMode ?? false,
    memoryMode: parsed.memoryMode ?? 'automatic', defaultTaskEffort: parsed.defaultTaskEffort ?? 'careful', validationRecords: parsed.validationRecords ?? [] };
}
export function effectiveUtilities(mode: Mode, preferences: UtilityPreferences, plugins: PluginPreferences = DEFAULT_PLUGINS): UtilityPreferences {
  return { fileReading: preferences.fileReading, projectSearch: mode === 'coding' && preferences.projectSearch,
    fileEditing: mode === 'coding' && preferences.fileEditing, terminal: mode === 'coding' && preferences.terminal,
    webResearch: (mode === 'coding' || mode === 'research') && plugins.taskResearch && preferences.webResearch };
}
