import { z } from 'zod';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appendThinking } from './thinking.ts';
import { restoreToolHistory } from './tool-history.ts';
import { MAX_TASK_BUDGET_MS, MIN_TASK_BUDGET_MS, NORMAL_TASK_BUDGET_MS, type SSDTaskHours } from './execution-policy.ts';
import type { Attachment, ChatMessage, Mode, PluginPreferences, UtilityPreferences, TaskEffort, MemoryMode, ModelValidationRecord, ApprovalPolicy, WorkspaceSummary, NavigationState } from './renderer/types.ts';
import { sanitizeApprovalPolicies } from './approval-policies.ts';
import { taskBriefSchema, type TaskBrief } from './task-verification.ts';
import { validateTranscript, type TranscriptMessage } from './transcript.ts';
export const DEFAULT_UTILITIES: UtilityPreferences = { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false };
export const utilitySchema = z.object({ fileReading: z.boolean(), projectSearch: z.boolean(), fileEditing: z.boolean(), terminal: z.boolean(), webResearch: z.boolean() }).strict();
export const DEFAULT_PLUGINS: PluginPreferences = { taskResearch: false };
export const pluginSchema = z.object({ taskResearch: z.boolean() }).strict();
export const memoryModeSchema = z.enum(['automatic', 'low-memory', 'experimental-disk', 'ssd-experts']);
export const taskEffortSchema = z.enum(['standard', 'careful']);
const checkSchema = z.object({ id: z.string(), title: z.string(), status: z.enum(['passed', 'failed', 'unverified']), detail: z.string(), toolId: z.string().optional(),
  purpose: z.enum(['operation', 'acceptance']).optional(), checkIds: z.array(z.string().max(64)).max(12).optional(),
  evidence: z.object({ operation: z.string().optional(), path: z.string().optional(), sha256: z.string().optional(), changed: z.boolean().optional(), actionId: z.string().optional(), complete: z.boolean().optional(), commandSha256: z.string().optional(), inputDigest: z.string().optional(), dependencyDigests: z.record(z.string(), z.string()).optional() }).optional() });
const outcomeSchema = z.object({ status: z.enum(['completed', 'blocked', 'cancelled', 'timed-out', 'incomplete']), finishReason: z.string(), checks: z.array(checkSchema).max(256),
  verification: z.enum(['passed', 'failed', 'unverified']).optional(), taskBrief: taskBriefSchema.optional(),
  model: z.object({ id: z.string(), digest: z.string(), runtime: z.string(), contextTokens: z.number(), backend: z.string(), memoryMode: memoryModeSchema,
    profileSignature: z.string().max(8192).optional(), nativeMemoryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), portableMemoryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    calibrationMeasurements: z.object({ sampledAt: z.string(), residentBytes: z.number().int().nonnegative(),
      physicalFootprintBytes: z.number().int().nonnegative().nullable().optional(), rssBytes: z.number().int().nonnegative().optional(),
      availableMemoryBytes: z.number().int().nonnegative(), pressure: z.enum(['normal', 'warning', 'critical']),
      privateCommitBytes: z.number().int().nonnegative().optional(), swapBytes: z.number().int().nonnegative().optional(),
      monitor: z.object({ platform: z.enum(['linux', 'win32']), source: z.string(), pressureSource: z.string(),
        pid: z.number().int().positive().nullable(), parentPid: z.number().int().positive().nullable() }).optional() }).optional() }).optional() });
const validationSchema = z.object({ id: z.string().uuid(), modelId: z.string(), digest: z.string(), templateHash: z.string(), runtime: z.string(), profileSignature: z.string(),
  startedAt: z.string(), completedAt: z.string().optional(), elapsedMs: z.number().optional(), status: z.enum(['running', 'passed', 'failed', 'cancelled']), checks: z.array(checkSchema).max(256), sessionId: z.string().uuid().optional() });
/**
 * Draft attachments are kept separately from `files`. `files` is the set of
 * files that became part of a submitted task; draftFiles is the composer
 * selection that should be restored when a user returns to an idle chat.
 * Keeping the two collections separate prevents a draft from becoming a
 * granted file before the user presses Send.
 */
export interface SavedSession {
  id: string; title: string; updatedAt: string; mode: Mode; taskEffort?: TaskEffort;
  executionBudgetMs?: number; validationRecordId?: string; projectPath?: string;
  workspaceId?: string; preferredModel?: string | null;
  messages: ChatMessage[]; files: Attachment[];
  draft?: string; draftFiles?: Attachment[]; draftRevision?: number;
  taskBrief?: TaskBrief;
  canonicalTranscript?: TranscriptMessage[];
  transcriptBinding?: { modelId: string; digest: string; templateHash: string; profileSignature: string };
  transcriptIncomplete?: boolean;
  transcriptHistory?: { binding: NonNullable<SavedSession['transcriptBinding']>; messages: TranscriptMessage[]; throughMessageCount: number }[];
}
export interface SavedState { version: 7; selectedModel: string | null; projectPath?: string; mode: Mode; utilities: UtilityPreferences; plugins: PluginPreferences; approvalPolicies: ApprovalPolicy[]; slowMode: boolean;
  workspaces: WorkspaceSummary[]; defaultWorkspaceId?: string; navigation: NavigationState;
  memoryMode: MemoryMode; ssdTaskHours: SSDTaskHours; defaultTaskEffort: TaskEffort; validationRecords: ModelValidationRecord[]; sessions: SavedSession[] }
export const emptyState = (): SavedState => ({ version: 7, selectedModel: null, mode: 'coding', utilities: { ...DEFAULT_UTILITIES }, plugins: { ...DEFAULT_PLUGINS }, approvalPolicies: [], slowMode: false,
  workspaces: [], navigation: { current: { screen: 'conversation' }, back: [] },
  memoryMode: 'automatic', ssdTaskHours: 4, defaultTaskEffort: 'careful', validationRecords: [], sessions: [] });

/** Model-specific thinking cannot outlive intervening turns on another model. */
export function bindSessionTranscript(session: SavedSession, binding: NonNullable<SavedSession['transcriptBinding']>, preserveThinking: boolean): TranscriptMessage[] | undefined {
  const previous = session.transcriptBinding;
  const same = previous?.modelId === binding.modelId && previous.digest === binding.digest && previous.templateHash === binding.templateHash;
  const seed = preserveThinking && same ? session.canonicalTranscript : undefined;
  if (!seed && session.canonicalTranscript && previous) {
    (session.transcriptHistory ??= []).push({ binding: previous, messages: session.canonicalTranscript, throughMessageCount: session.messages.length });
    delete session.canonicalTranscript;
  }
  if (preserveThinking) session.transcriptBinding = binding;
  else delete session.transcriptBinding;
  return seed;
}
export function migrateState(value: unknown): SavedState {
  const bindingSchema = z.object({ modelId: z.string().max(256), digest: z.string().regex(/^[a-f0-9]{64}$/), templateHash: z.string().regex(/^[a-f0-9]{64}$/), profileSignature: z.string().max(8192) });
  const routeSchema = z.object({ screen: z.enum(['conversation', 'models', 'plugins']), sessionId: z.string().uuid().optional() });
  const schema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]).optional(), selectedModel: z.string().max(256).nullable(),
    workspaces: z.array(z.object({ id: z.string().max(128), path: z.string(), name: z.string(), updatedAt: z.string() })).max(2000).optional(),
    defaultWorkspaceId: z.string().max(128).optional(), navigation: z.object({ current: routeSchema, back: z.array(routeSchema).max(100) }).optional(),
    projectPath: z.string().optional(), mode: z.enum(['coding', 'research', 'assistant']), utilities: utilitySchema.optional(), plugins: pluginSchema.optional(), approvalPolicies: z.array(z.unknown()).max(512).optional(), slowMode: z.boolean().optional(),
    memoryMode: memoryModeSchema.optional(), ssdTaskHours: z.union([z.literal(4), z.literal(8)]).optional(), defaultTaskEffort: taskEffortSchema.optional(), validationRecords: z.array(validationSchema).max(100).optional(),
    sessions: z.array(z.object({ id: z.string().uuid(), title: z.string(), updatedAt: z.string(), mode: z.enum(['coding', 'research', 'assistant']), projectPath: z.string().optional(),
      workspaceId: z.string().max(128).optional(), preferredModel: z.string().max(256).nullable().optional(),
      taskEffort: taskEffortSchema.optional(), executionBudgetMs: z.number().int().min(MIN_TASK_BUDGET_MS).max(MAX_TASK_BUDGET_MS).optional(), validationRecordId: z.string().uuid().optional(),
      draft: z.string().max(1_000_000).optional(), draftFiles: z.array(z.object({ name: z.string(), path: z.string() })).max(20).optional(), draftRevision: z.number().int().nonnegative().optional(),
      taskBrief: taskBriefSchema.optional(),
      canonicalTranscript: z.unknown().transform(validateTranscript).optional(),
      transcriptBinding: bindingSchema.optional(),
      transcriptHistory: z.array(z.object({ binding: bindingSchema, messages: z.unknown().transform(validateTranscript).transform(value => value ?? []), throughMessageCount: z.number().int().nonnegative() })).max(1000).optional(),
      transcriptIncomplete: z.boolean().optional(),
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
  const workspaces = [...(parsed.workspaces ?? [])];
  const workspaceFor = (folder: string, updatedAt: string): WorkspaceSummary => {
    let workspace = workspaces.find(item => item.path === folder);
    if (!workspace) {
      workspace = { id: `workspace-${createHash('sha256').update(folder).digest('hex').slice(0, 32)}`, path: folder, name: path.basename(folder) || folder, updatedAt };
      workspaces.push(workspace);
    }
    return workspace;
  };
  const sessions = parsed.sessions.map(session => ({ ...session,
    ...(session.projectPath ? { workspaceId: workspaceFor(session.projectPath, session.updatedAt).id } : {}),
    ...(session.preferredModel === undefined && parsed.version !== 7 ? { preferredModel: session.transcriptBinding?.modelId ?? [...session.messages].reverse().find(message => message.outcome?.model?.id)?.outcome?.model?.id ?? parsed.selectedModel } : {}),
    ...((parsed.version ?? 0) >= 5 ? {} : { executionBudgetMs: session.executionBudgetMs ?? NORMAL_TASK_BUDGET_MS }) }));
  const defaultWorkspaceId = parsed.projectPath ? workspaceFor(parsed.projectPath, '1970-01-01T00:00:00.000Z').id : parsed.defaultWorkspaceId;
  const routeExists = (route: z.infer<typeof routeSchema>) => !route.sessionId || sessions.some(session => session.id === route.sessionId);
  const navigation = parsed.navigation && routeExists(parsed.navigation.current) ? { current: parsed.navigation.current, back: parsed.navigation.back.filter(routeExists) }
    : { current: { screen: 'conversation' as const }, back: [] };
  return { ...parsed, version: 7, workspaces, ...(defaultWorkspaceId ? { defaultWorkspaceId } : {}), navigation,
    approvalPolicies: sanitizeApprovalPolicies(parsed.approvalPolicies ?? []), utilities: parsed.utilities ?? { ...DEFAULT_UTILITIES },
    plugins: parsed.plugins ?? { taskResearch: (parsed.version === undefined || parsed.version < 3) && parsed.utilities?.webResearch === true }, slowMode: parsed.slowMode ?? false,
    // Historical mmap is not the new expert-streaming worker. Preserve its
    // reports on disk, but never infer consent/readiness for a new engine.
    memoryMode: parsed.memoryMode === 'experimental-disk' ? 'automatic' : parsed.memoryMode ?? 'automatic', ssdTaskHours: parsed.ssdTaskHours ?? 4,
    defaultTaskEffort: parsed.defaultTaskEffort ?? 'careful', validationRecords: parsed.validationRecords ?? [],
    sessions };
}
export function effectiveUtilities(mode: Mode, preferences: UtilityPreferences, plugins: PluginPreferences = DEFAULT_PLUGINS): UtilityPreferences {
  return { fileReading: preferences.fileReading, projectSearch: mode === 'coding' && preferences.projectSearch,
    fileEditing: mode === 'coding' && preferences.fileEditing, terminal: mode === 'coding' && preferences.terminal,
    webResearch: (mode === 'coding' || mode === 'research') && plugins.taskResearch && preferences.webResearch };
}
