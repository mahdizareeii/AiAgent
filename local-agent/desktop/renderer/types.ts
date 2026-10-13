export type Mode = 'coding' | 'research' | 'assistant';
export type TaskEffort = 'standard' | 'careful';
export type MemoryMode = 'automatic' | 'low-memory' | 'experimental-disk' | 'ssd-experts';
export interface TaskCheck { id: string; title: string; status: 'passed' | 'failed' | 'unverified'; detail: string; toolId?: string;
  evidence?: { operation?: string; path?: string; sha256?: string; changed?: boolean; actionId?: string; complete?: boolean }; }
export interface TaskOutcome {
  status: 'completed' | 'blocked' | 'cancelled' | 'timed-out' | 'incomplete';
  finishReason: string; checks: TaskCheck[];
  model?: { id: string; digest: string; runtime: string; contextTokens: number; backend: string; memoryMode: MemoryMode };
}
export interface ExperimentalTrialView {
  probes?: { chat?: FixedProbeDiagnostic; tools?: FixedProbeDiagnostic };
  id?: string; state: string; modelId: string; reason?: string; startedAt?: string; finishedAt?: string; profileSignature?: string;
  error?: { code: string; message: string } | null; errorCode?: string;
  progress?: { stage: 'verifying' | 'planning' | 'loading' | 'probing'; message?: string; completedBytes?: number; totalBytes?: number };
  mode?: MemoryMode; digest?: string; artifactSetDigest?: string; templateDigest?: string; engineDigest?: string;
  backendValidation?: 'cpu-baseline' | 'validated' | 'qa-unvalidated';
  parityReportDigest?: string;
  probePassed?: boolean; toolProbePassed?: boolean;
  mappedBytes?: number; lazyEligibleBytes?: number; rssBytes?: number; peakRssBytes?: number; limitBytes?: number;
  physicalFootprintBytes?: number; peakPhysicalFootprintBytes?: number;
  cacheBytes?: number; cacheHits?: number; cacheMisses?: number; bytesRead?: number;
  streaming?: { cacheBytes?: number; cacheHits?: number; cacheMisses?: number; bytesRead?: number; residentBytes?: number; expertGroups?: number; expectedExpertGroups?: number; slotsPerLayer?: number; ioMode?: string;
    cpuKernel?: 'unknown' | 'standard' | 'default'; useExtraBufts?: boolean | null; cpuRepackTensorCount?: number | null; decodeThreads?: number | null; batchThreads?: number | null };
  pressure?: 'normal' | 'warning' | 'critical'; availableMemoryBytes?: number;
}
/** Bounded responses from the runtime's fixed local checks, never user tasks. */
export interface FixedProbeDiagnostic {
  kind: 'chat' | 'tools'; passed: boolean; requestedOutputTokens: number; thinkingDisabled: true;
  finishReason: string | null; content: string | null; reasoning: string | null;
  outputTokens: number | null; reasoningTokens: number | null;
  toolCalls: { name: string | null; arguments: string | null }[]; toolCallCount: number; truncated: boolean;
  binding: { model: string; digest?: string; templateHash?: string; runtime?: string; profileSignature?: string; trialId?: string };
}
/** Durable diagnostics only; these records never confer model readiness. */
export interface SSDTrialHistoryEntry {
  id: string; mode: 'ssd-experts'; model: string;
  state: 'loading' | 'calibrating' | 'passed' | 'failed' | 'cancelled' | 'stopped' | 'incomplete';
  startedAt: string; finishedAt?: string; profileSignature: string;
  artifactSetDigest?: string; templateDigest?: string; engineDigest?: string; patchDigest?: string;
  backendValidation?: ExperimentalTrialView['backendValidation']; parityReportDigest?: string;
  checks: { chat: 'passed' | 'failed' | 'unverified'; tools: 'passed' | 'failed' | 'unverified' };
  error: { code: string; message: string } | null;
  progress?: ExperimentalTrialView['progress']; probes?: ExperimentalTrialView['probes'];
  resources?: {
    residentBudgetBytes: number | null; allocationBudgetBytes?: number;
    measurements?: { sampledAt: string; residentBytes: number; physicalFootprintBytes?: number | null; rssBytes?: number; availableMemoryBytes: number; pressure: 'normal' | 'warning' | 'critical' } | null;
    streaming?: { expectedGroups: number; streamedGroups: number; cacheSlotsPerLayer: number; expertCacheBytes: number; bytesRead?: number; cacheMisses?: number; waves?: number;
      cpuKernel?: 'unknown' | 'standard' | 'default'; useExtraBufts?: boolean | null; cpuRepackTensorCount?: number | null; decodeThreads?: number | null; batchThreads?: number | null };
  };
}
export interface ModelValidationRecord {
  id: string; modelId: string; digest: string; templateHash: string; runtime: string; profileSignature: string;
  startedAt: string; completedAt?: string; elapsedMs?: number;
  status: 'running' | 'passed' | 'failed' | 'cancelled'; checks: TaskCheck[]; sessionId?: string;
}

export interface HardwareSnapshot {
  platform: string;
  architecture: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  freeDiskBytes: number;
  gpus: { name: string; backend: string; totalMemoryBytes: number; freeMemoryBytes: number; unifiedMemory: boolean }[];
}

export interface UtilityPreferences {
  fileReading: boolean;
  projectSearch: boolean;
  fileEditing: boolean;
  terminal: boolean;
  webResearch: boolean;
}

export interface PluginPreferences {
  taskResearch: boolean;
}

export interface ExecutionProfile {
  backend: string;
  contextTokens: number;
  gpuLayers?: number;
  cpuThreads?: number;
  label?: string;
  batchTokens?: number; microBatchTokens?: number; memoryMode?: MemoryMode; profileSignature?: string;
}

export interface LocalModel {
  id: string;
  name: string;
  downloadGB: number;
  description: string;
  installed: boolean;
  blockedReason?: string;
  verificationError?: string;
  fit: 'recommended' | 'slow' | 'insufficient';
  fitReason: string;
  license: string;
  quantization: string;
  workingMemoryGB: number;
  memoryEstimate?: {
    weightsBytes: number;
    contextBytes: number;
    scratchBytes: number;
    osReserveBytes: number;
    systemBudgetBytes: number;
    gpuBudgetBytes: number;
  };
  toolCapable: boolean;
  toolValidationEligible?: boolean;
  historicalBindingVerified?: boolean;
  needsPreparation?: boolean;
  measuredTokensPerSecond?: number;
  sourceUrl?: string;
  digest?: string;
  templateHash?: string;
  integrity?: 'unverified' | 'verified' | 'failed';
  artifacts?: { filename: string; sizeBytes?: number; estimatedDownloadBytes?: number; sha256: string }[];
  acquisitionBlocker?: { code: string; message: string } | null;
  useBlocker?: { code: string; message: string } | null;
  trialBlocker?: { code: string; message: string } | null;
  ssdEligibility?: { supported: boolean; reason: string; minimumSlotsPerLayer: number | null; engineReady: boolean };
  taskGuidance?: { id: 'coding' | 'websites' | 'automation' | 'documents' | 'research'; label: string; icon: string; description: string; examples: string[] }[];
  chatProbe?: ModelProbe;
  toolProbe?: ModelProbe;
  emitsThinking?: boolean;
}

export interface ModelProbe { status: 'passed' | 'failed' | 'unverified'; detail?: string; digest?: string; templateHash?: string; runtime?: string; profileSignature?: string; }

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string | number;
  resumable?: boolean;
  mode?: Mode;
  taskEffort?: TaskEffort;
}

export interface AgentStatus {
  runtime: {
    ready: boolean;
    state?: 'stopped' | 'starting' | 'ready' | 'loading' | 'stopping' | 'error';
    version?: string;
    error?: string;
    errorCode?: string;
    engineIdentity?: string;
  };
  modelsError?: string;
  storage?: { profile: 'regular' | 'isolated'; path: string; modelCachePath: string };
  hardware: HardwareSnapshot;
  profile?: ExecutionProfile;
  utilities: UtilityPreferences;
  plugins: PluginPreferences;
  slowMode: boolean;
  memoryMode?: MemoryMode;
  defaultTaskEffort?: TaskEffort;
  ssdTaskHours?: 4 | 8;
  experimentalTrial?: ExperimentalTrialView;
  trialHistory?: SSDTrialHistoryEntry[];
  trialHistoryError?: { code: string; message: string } | null;
  validationRecords?: ModelValidationRecord[];
  activeSessionId?: string;
  activeTurnId?: string;
  downloadingModel?: string | null;
  downloadProgress?: DownloadProgress | null;
  models: LocalModel[];
  recommendation: string | null;
  selectedModel: string | null;
  mode: Mode;
  projectPath?: string;
  stage?: StageProgress;
  sessions: SessionSummary[];
}

export interface Attachment {
  name: string;
  path: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: ToolActivity[];
  toolsTruncated?: boolean;
  outcome?: TaskOutcome;
}

export interface AgentSession {
  id: string;
  messages: ChatMessage[];
  mode: Mode;
  projectPath?: string;
  stage?: StageProgress;
  taskEffort?: TaskEffort;
}

export interface DownloadProgress {
  modelId: string;
  progress: { status: string; completed?: number; total?: number };
}

export interface StageProgress {
  stage: string;
  completed?: number;
  total?: number;
  message?: string;
  resumable?: boolean;
}

export interface ToolActivity {
  id: string;
  title: string;
  status: string;
  input?: unknown;
  output?: unknown;
}

export interface PermissionRequest {
  requestId: string;
  title: string;
  arguments: unknown;
  preview?: unknown;
  command?: string;
  cwd?: string;
  turnId?: string;
  revision?: number;
}
export interface PermissionSnapshot { revision: number; sessionId: string; turnId: string | null; pending: PermissionRequest[]; }

export type AgentEvent = (
  | { type: 'status' }
  | ({ type: 'download' } & DownloadProgress)
  | ({ type: 'stage' } & StageProgress)
  | { type: 'message'; text: string; role: 'assistant'; thinking?: boolean }
  | ({ type: 'tool' } & ToolActivity)
  | ({ type: 'permission' } & PermissionRequest)
  | { type: 'permission_cancelled'; requestId: string }
  | { type: 'permission_resolved'; requestId: string; revision: number; turnId: string; resolution: 'approved' | 'denied' | 'cancelled' | 'expired' }
  | { type: 'done' }
  | { type: 'error'; text?: string; error?: string }
) & { sessionId?: string; turnId?: string };

export interface LocalAgentBridge {
  status(): Promise<AgentStatus>;
  setup(options: Record<string, never>): Promise<AgentStatus>;
  importModel(): Promise<void>;
  calibrateModel(id: string): Promise<void>;
  setUtilities(preferences: UtilityPreferences): Promise<void>;
  setPlugins(preferences: PluginPreferences): Promise<void>;
  setSlowMode(enabled: boolean): Promise<void>;
  setExecutionPreferences(options: { memoryMode?: MemoryMode; taskEffort?: TaskEffort; ssdTaskHours?: 4 | 8 }): Promise<void>;
  startModelTrial?(id: string, route: 'ssd-experts'): Promise<void>;
  tryExperimentalModel(id: string): Promise<void>;
  cancelModelTrial(trialId: string): Promise<void>;
  createModelValidationTask(id: string): Promise<{ sessionId: string; prompt: string }>;
  downloadModel(id: string): Promise<void>;
  cancelDownload(): Promise<void>;
  selectModel(id: string): Promise<void>;
  selectProject(): Promise<string | null>;
  createProject(options: { name: string }): Promise<string | null>;
  selectFiles(): Promise<Attachment[]>;
  createSession(options: { mode: Mode; projectPath?: string; taskEffort?: TaskEffort }): Promise<{ id: string }>;
  loadSession(id: string): Promise<AgentSession>;
  send(options: { sessionId: string; text: string; files?: Attachment[] }): Promise<void>;
  cancel(sessionId?: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  approvals(sessionId: string): Promise<PermissionSnapshot>;
  respondPermission(options: { requestId: string; approved: boolean; sessionId?: string; turnId?: string }): Promise<{ status: 'settled' | 'expired'; revision: number }>;
  undo(): Promise<{ restored: number }>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    localAgent?: LocalAgentBridge;
  }
}
