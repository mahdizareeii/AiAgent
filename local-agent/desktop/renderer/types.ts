export type Mode = 'coding' | 'research' | 'assistant';
export type TaskEffort = 'standard' | 'careful';
export type MemoryMode = 'automatic' | 'low-memory' | 'experimental-disk';
export interface TaskCheck { id: string; title: string; status: 'passed' | 'failed' | 'unverified'; detail: string; toolId?: string;
  evidence?: { operation?: string; path?: string; sha256?: string; changed?: boolean; actionId?: string; complete?: boolean }; }
export interface TaskOutcome {
  status: 'completed' | 'blocked' | 'cancelled' | 'timed-out' | 'incomplete';
  finishReason: string; checks: TaskCheck[];
  model?: { id: string; digest: string; runtime: string; contextTokens: number; backend: string; memoryMode: MemoryMode };
}
export interface ExperimentalTrialView {
  state: string; modelId: string; reason?: string; startedAt?: string; profileSignature?: string;
  mappedBytes?: number; lazyEligibleBytes?: number; rssBytes?: number; peakRssBytes?: number; limitBytes?: number;
  pressure?: 'normal' | 'warning' | 'critical'; availableMemoryBytes?: number;
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
  measuredTokensPerSecond?: number;
  sourceUrl?: string;
  digest?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string | number;
  resumable?: boolean;
}

export interface AgentStatus {
  runtime: {
    ready: boolean;
    state?: 'stopped' | 'starting' | 'ready' | 'loading' | 'stopping' | 'error';
    version?: string;
    error?: string;
    errorCode?: string;
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
  experimentalTrial?: ExperimentalTrialView;
  validationRecords?: ModelValidationRecord[];
  activeSessionId?: string;
  activeTurnId?: string;
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
  setExecutionPreferences(options: { memoryMode?: MemoryMode; taskEffort?: TaskEffort }): Promise<void>;
  tryExperimentalModel(id: string): Promise<void>;
  cancelModelTrial(): Promise<void>;
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
