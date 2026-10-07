export type Mode = 'coding' | 'research' | 'assistant';

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

export interface ExecutionProfile {
  backend: string;
  contextTokens: number;
  gpuLayers?: number;
  cpuThreads?: number;
  label?: string;
}

export interface LocalModel {
  id: string;
  name: string;
  downloadGB: number;
  description: string;
  installed: boolean;
  blockedReason?: string;
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
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string | number;
  resumable?: boolean;
}

export interface AgentStatus {
  runtime: { ready: boolean; version?: string; error?: string };
  hardware: HardwareSnapshot;
  profile?: ExecutionProfile;
  utilities: UtilityPreferences;
  slowMode: boolean;
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
}

export interface AgentSession {
  id: string;
  messages: ChatMessage[];
  mode: Mode;
  projectPath?: string;
  stage?: StageProgress;
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
}

export type AgentEvent = (
  | { type: 'status' }
  | ({ type: 'download' } & DownloadProgress)
  | ({ type: 'stage' } & StageProgress)
  | { type: 'message'; text: string; role: 'assistant'; thinking?: boolean }
  | ({ type: 'tool' } & ToolActivity)
  | ({ type: 'permission' } & PermissionRequest)
  | { type: 'done' }
  | { type: 'error'; text?: string; error?: string }
) & { sessionId?: string };

export interface LocalAgentBridge {
  status(): Promise<AgentStatus>;
  setup(options: Record<string, never>): Promise<AgentStatus>;
  importModel(): Promise<void>;
  calibrateModel(id: string): Promise<void>;
  setUtilities(preferences: UtilityPreferences): Promise<void>;
  setSlowMode(enabled: boolean): Promise<void>;
  downloadModel(id: string): Promise<void>;
  cancelDownload(): Promise<void>;
  selectModel(id: string): Promise<void>;
  selectProject(): Promise<string | null>;
  selectFiles(): Promise<Attachment[]>;
  createSession(options: { mode: Mode; projectPath?: string }): Promise<{ id: string }>;
  loadSession(id: string): Promise<AgentSession>;
  send(options: { sessionId: string; text: string; files?: Attachment[] }): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  respondPermission(options: { requestId: string; approved: boolean }): Promise<void>;
  undo(): Promise<{ restored: number }>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    localAgent?: LocalAgentBridge;
  }
}
