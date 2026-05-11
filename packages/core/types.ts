export type GenericRecord = Record<string, unknown>;

export interface InputEvent {
  id: unknown;
  type?: string;
  pluginId?: string;
  content: unknown;
  metadata?: GenericRecord;
}

export interface NormalizedInputSignals {
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
}

export interface NormalizedInputFile {
  path: string;
  extension: string | null;
  kind: string | null;
}

export interface NormalizedInputImage {
  path: string;
  mimeType: string;
}

export interface NormalizedInput {
  sourcePluginId: string;
  inputType: string;
  sourceKind: string;
  scenario: string;
  title: string;
  normalizedText: string;
  summaryHint: string;
  keywords: string[];
  file: NormalizedInputFile | null;
  image: NormalizedInputImage | null;
  metadata: GenericRecord;
  signals: NormalizedInputSignals;
  memorySearchQuery: string;
  taskType: string;
}

export interface MemoryRecord {
  id: unknown;
  summary: string;
  content: string;
  tags?: string[];
  importance?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
}

export interface MemoryDecision {
  shouldRemember: boolean;
  memoryType: string | null;
  reason: string | null;
  actionHint: string;
}

export interface OutputPolicy {
  shouldOutput: boolean;
  type: string;
  reason: string;
  priority: string;
  preferredPluginIds?: string[];
}

export type PartialOutputDecision = Partial<OutputPolicy> & {
  outputType?: string;
};

export interface AnalysisResult {
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
  outputDecision?: PartialOutputDecision;
  [key: string]: unknown;
}

export interface SynthesisResult {
  summary: string;
  bullets: string[];
  actions: string[];
  themes: string[];
  sourceMemoryIds: unknown[];
}

export interface ScheduleContent {
  text?: string;
}

export interface SchedulePlan {
  id?: unknown;
  name: string;
  mode: string;
  content?: ScheduleContent;
  runAt: string | null;
  intervalMs: number | null;
  status?: string;
}

export interface DecisionResult {
  taskType: string;
  actions: string[];
  memoryDecision: MemoryDecision;
  schedulePlan: SchedulePlan | null;
  synthesisMode: string;
  output: OutputPolicy;
}

export interface OutputEvent {
  id?: unknown;
  pluginId?: string;
  sourceType?: string;
  sourceId?: unknown;
  type?: string;
  content?: GenericRecord;
  priority?: string;
  preferredPluginIds?: string[];
  [key: string]: unknown;
}

export interface CreateTaskPayload {
  sourceType?: string;
  sourceId?: unknown;
  inputEventId?: unknown;
  type: string;
}

export interface CreateOutputEventPayload {
  pluginId: string;
  sourceType?: string;
  sourceId?: unknown;
  type: string;
  content: GenericRecord;
  status?: string;
}

export interface OutputPluginSendInput {
  event: OutputEvent;
  content: GenericRecord;
  type: string;
  repository: OutputDispatchRepository;
}

export interface OutputPlugin {
  id: string;
  type: string;
  direction?: string;
  enabled?: boolean;
  _enabled?: boolean;
  send?: (input: OutputPluginSendInput) => Promise<void> | void;
  [key: string]: unknown;
}

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

export interface AnalyzeInputContext {
  normalizedInput: NormalizedInput;
  relatedMemories: MemoryRecord[];
}

export interface AnalyzeInputOptions {
  tools: unknown[];
  executeTool?: (name: string, input: ToolInput) => Promise<unknown>;
}

export interface ModelProvider {
  analyzeInput: (
    inputEvent: InputEvent,
    context: AnalyzeInputContext,
    options: AnalyzeInputOptions
  ) => Promise<AnalysisResult>;
  callModel?: (prompt: string, systemMessage?: string) => Promise<{ content?: string } | unknown>;
}

export interface ToolInput {
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
}

export interface SimilarMemoryMatch {
  memory: MemoryRecord;
  score: number;
}

export interface ScheduleRunPayload {
  nextRunAt: string | null;
  status: string;
}

export interface LoggingRepository {
  log: (level: string, type: string, message: string, payload?: GenericRecord) => void;
}

export interface InputEventRepository {
  updateInputEventStatus: (id: unknown, status: string) => void;
}

export interface TaskRepository {
  createTask: (payload: CreateTaskPayload | unknown, maybeType?: string) => { id: unknown };
  finishTask: (id: unknown, status: string, result?: unknown, error?: string | null) => void;
}

export interface MemorySearchRepository {
  searchMemories: (query: string, limit: number) => MemoryRecord[];
}

export interface MemoryPersistenceRepository extends LoggingRepository {
  findSimilarMemory: (payload: GenericRecord, threshold: number) => SimilarMemoryMatch | null;
  updateMemory: (id: unknown, payload: GenericRecord) => MemoryRecord;
  createMemory: (payload: GenericRecord) => MemoryRecord;
}

export interface ScheduleRepository {
  createSchedule: (schedulePlan: SchedulePlan) => SchedulePlan & { id: unknown };
  getDueSchedules?: (nowIso: string) => SchedulePlan[];
  markScheduleRun?: (id: unknown, payload: ScheduleRunPayload) => void;
}

export interface OutputDispatchRepository extends LoggingRepository {
  createOutputEvent?: (payload: CreateOutputEventPayload) => OutputEvent;
  updateOutputEventStatus?: (id: unknown, status: string, content?: GenericRecord) => void;
}

export interface PluginListRepository {
  listPlugins?: () => OutputPlugin[];
}

export interface PluginAdminRepository extends PluginListRepository {
  upsertPlugin: (plugin: OutputPlugin & { config?: Record<string, unknown> }, status: string) => void;
  pruneMissingPlugins: (ids: string[]) => void;
}

export interface AgentLoopRepository extends TaskRepository, InputEventRepository, LoggingRepository, MemorySearchRepository, MemoryPersistenceRepository, ScheduleRepository {}

export interface ScheduleManagerRepository extends TaskRepository, ScheduleRepository, OutputRoutingRepository {}

export interface OutputRoutingRepository extends PluginListRepository {}

export interface RuntimeBootstrapRepository extends AgentLoopRepository, OutputDispatchRepository, PluginAdminRepository {}

export interface RepositoryLike extends RuntimeBootstrapRepository {}

export interface RuntimeStatusRepository {
  setAgentStatus?: (id: unknown, status: string) => void;
  setRuntimeState?: (key: string, value: GenericRecord) => void;
  listPlugins?: () => OutputPlugin[];
  getRuntimeState?: (key: string) => { value?: GenericRecord } | null;
  getActiveAgentId?: () => unknown;
}

export interface RuntimeLike {
  input: (content: string, options?: GenericRecord) => Promise<unknown>;
}
