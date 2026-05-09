export type GenericRecord = Record<string, unknown>;

export type InputEvent = {
  id: unknown;
  type?: string;
  pluginId?: string;
  content: unknown;
  metadata?: GenericRecord;
};

export type NormalizedInputSignals = {
  userRequestedResponse: boolean;
  containsQuestion: boolean;
  containsActionRequest: boolean;
  containsReminderIntent: boolean;
  containsMemoryCommand: boolean;
  asksHistoryLookup: boolean;
  asksCurrentSummary: boolean;
  hasLongFormContent: boolean;
  likelyEphemeral: boolean;
  likelyDecision: boolean;
  likelyPreference: boolean;
};

export type NormalizedInput = {
  sourcePluginId: string;
  inputType: string;
  sourceKind: string;
  scenario: string;
  title: string;
  normalizedText: string;
  summaryHint: string;
  keywords: string[];
  file: {
    path: string;
    extension: string | null;
    kind: string | null;
  } | null;
  image: {
    path: string;
    mimeType: string;
  } | null;
  metadata: GenericRecord;
  signals: NormalizedInputSignals;
  memorySearchQuery: string;
  taskType: string;
};

export type MemoryRecord = {
  id: unknown;
  summary: string;
  content: string;
  tags?: string[];
  importance?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
};

export type MemoryDecision = {
  shouldRemember: boolean;
  memoryType: string | null;
  reason: string | null;
  actionHint: string;
};

export type OutputPolicy = {
  shouldOutput: boolean;
  type: string;
  reason: string;
  priority: string;
  preferredPluginIds?: string[];
};

export type AnalysisResult = {
  provider?: unknown;
  category?: string;
  intent?: string;
  summary: string;
  tags?: string[];
  remembered?: boolean;
  memoryType?: string | null;
  importance?: unknown;
  confidence?: unknown;
  extractedFacts?: string[];
  warnings?: string[];
  relatedMemories?: MemoryRecord[];
  taskType?: string;
  memoryDecision?: MemoryDecision;
  outputDecision?: Partial<OutputPolicy> & { outputType?: string };
  [key: string]: unknown;
};

export type SynthesisResult = {
  summary: string;
  bullets: string[];
  actions: string[];
  themes: string[];
  sourceMemoryIds: unknown[];
};

export type SchedulePlan = {
  id?: unknown;
  name: string;
  mode: string;
  content?: { text?: string };
  runAt: string | null;
  intervalMs: number | null;
  status?: string;
};

export type DecisionResult = {
  taskType: string;
  actions: string[];
  memoryDecision: MemoryDecision;
  schedulePlan: SchedulePlan | null;
  synthesisMode: string;
  output: OutputPolicy;
};

export type OutputEvent = {
  id?: unknown;
  pluginId?: string;
  sourceType?: string;
  sourceId?: unknown;
  type?: string;
  content?: GenericRecord;
  priority?: string;
  preferredPluginIds?: string[];
  [key: string]: unknown;
};

export type OutputPlugin = {
  id: string;
  type: string;
  direction?: string;
  enabled?: boolean;
  _enabled?: boolean;
  send?: (input: {
    event: OutputEvent;
    content: GenericRecord;
    type: string;
    repository: RepositoryLike;
  }) => Promise<void> | void;
  [key: string]: unknown;
};

export type ToolExecutor = {
  searchMemory: (query: string) => unknown;
  readFile: (path: string) => unknown;
  writeFile: (path: string, content: string) => unknown;
  deleteFile: (path: string) => unknown;
  executeCommand: (command: string, args?: string[], options?: { cwd?: string }) => unknown;
  callModel: (prompt: string, systemMessage?: string) => Promise<{ content?: string } | unknown> | unknown;
  httpRequest: (
    url: string,
    method?: string,
    headers?: Record<string, string>,
    body?: string | null
  ) => unknown;
};

export type ModelProvider = {
  analyzeInput: (
    inputEvent: InputEvent,
    context: { normalizedInput: NormalizedInput; relatedMemories: MemoryRecord[] },
    options: { tools: unknown[]; executeTool?: ((name: string, input: ToolInput) => Promise<unknown>) | undefined }
  ) => Promise<AnalysisResult>;
  callModel?: (prompt: string, systemMessage?: string) => Promise<{ content?: string } | unknown>;
};

export type ToolInput = {
  query?: string;
  path?: string;
  content?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  prompt?: string;
  systemMessage?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
};

export type RepositoryLike = {
  createTask: (payload: GenericRecord) => { id: unknown };
  updateInputEventStatus: (id: unknown, status: string) => void;
  log: (level: string, type: string, message: string, payload?: GenericRecord) => void;
  searchMemories: (query: string, limit: number) => MemoryRecord[];
  createSchedule: (schedulePlan: SchedulePlan) => SchedulePlan & { id: unknown };
  finishTask: (id: unknown, status: string, result?: unknown, error?: string) => void;
  findSimilarMemory: (payload: GenericRecord, threshold: number) => { memory: MemoryRecord; score: number } | null;
  updateMemory: (id: unknown, payload: GenericRecord) => MemoryRecord;
  createMemory: (payload: GenericRecord) => MemoryRecord;
  createOutputEvent?: (payload: GenericRecord) => OutputEvent;
  updateOutputEventStatus?: (id: unknown, status: string, content?: GenericRecord) => void;
  listPlugins?: () => OutputPlugin[];
  getDueSchedules?: (nowIso: string) => SchedulePlan[];
  markScheduleRun?: (id: unknown, payload: { nextRunAt: string | null; status: string }) => void;
};

export type RuntimeLike = {
  input: (content: string, options?: GenericRecord) => Promise<unknown>;
};
