import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { normalizeInputEvent } from "./input-normalizer.ts";
import { recallMemories } from "../memory/memory-recall.ts";
import type {
  AgentLoopRepository,
  AnalysisResult,
  InputEvent,
  MemoryRecord,
  ModelProvider,
  NormalizedInput,
  ToolExecutor,
  ToolInput
} from "./types.ts";

type AnalyzeGraphInput = {
  inputEvent: InputEvent;
  repository: AgentLoopRepository;
  modelProvider: ModelProvider & {
    asLangChainChatModel?: () => unknown;
  };
  tools?: ToolExecutor;
  logModelRequest?: (level: string, message: string, metadata: Record<string, unknown>) => void;
};

type AnalyzeGraphResult = {
  normalizedInput: NormalizedInput;
  analysis: AnalysisResult;
};

type AnalyzePlan = {
  taskType: string;
  needsMemory: boolean;
  needsTools: boolean;
  toolNames: string[];
  reason: string;
};

type PendingToolCall = {
  id: string;
  name: string;
  args: ToolInput;
};

const PlanSchema = z.object({
  taskType: z.string().default("context_capture"),
  needsMemory: z.boolean().default(false),
  needsTools: z.boolean().default(false),
  toolNames: z.array(z.string()).default([]),
  reason: z.string().default("classified_by_analyze_graph")
});

const AnalysisSchema = z.object({
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(8),
  taskType: z.string().default("context_capture"),
  category: z.string().default("context_summary"),
  intent: z.string().default("capture_context"),
  remembered: z.boolean().default(false),
  memoryType: z.string().default("上下文总结"),
  memoryReason: z.string().default("contains_long_term_value"),
  memoryActionHint: z.enum(["create", "update", "create_or_update", "skip"]).default("create_or_update"),
  importance: z.coerce.number().min(1).max(5).default(3),
  confidence: z.coerce.number().min(0).max(1).default(0.7),
  shouldOutput: z.boolean().default(false),
  outputType: z.string().default("summary"),
  outputReason: z.string().default("model_decision"),
  outputPriority: z.enum(["low", "medium", "high"]).default("medium"),
  extractedFacts: z.array(z.string().min(1)).max(8).default([]),
  warnings: z.array(z.string().min(1)).max(6).default([])
});

const PLAN_TOOL_NAME = "plan_neura_input_processing";
const ANALYSIS_TOOL_NAME = "record_neura_input_analysis";

const PLAN_TOOL = {
  type: "function",
  function: {
    name: PLAN_TOOL_NAME,
    description: "Plan how Neura should process this input before recalling memory or using tools.",
    parameters: z.toJSONSchema(PlanSchema)
  }
};

const ANALYSIS_TOOL = {
  type: "function",
  function: {
    name: ANALYSIS_TOOL_NAME,
    description: "Record the final structured Neura input analysis.",
    parameters: z.toJSONSchema(AnalysisSchema)
  }
};

const AVAILABLE_TOOLS = [
  {
    name: "search_memory",
    description: "搜索 Neura 记忆库，查找与查询相关的历史记忆，用于获取上下文",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词或短语" }
      },
      required: ["query"]
    }
  },
  {
    name: "read_file",
    description: "读取本地文件内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "写入本地文件内容。覆盖已有文件属于高风险动作，可能需要用户确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" },
        content: { type: "string", description: "要写入的内容" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "delete_file",
    description: "删除本地文件。高风险动作，必须由用户确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" }
      },
      required: ["path"]
    }
  },
  {
    name: "execute_command",
    description: "执行本地命令。高风险动作，必须由用户确认。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "命令参数列表"
        },
        cwd: { type: "string", description: "命令执行目录，可选" }
      },
      required: ["command"]
    }
  },
  {
    name: "call_model",
    description: "调用 AI 模型对子任务进行独立推理。当你需要对某段内容做二次总结、翻译、分类或深入分析时使用。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "发送给模型的提示词" },
        systemMessage: { type: "string", description: "系统消息，可选。用于设定模型角色或回复风格" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "http_request",
    description: "发送 HTTP 请求到外部 API。用于获取实时信息、调用外部服务或触发 Webhook。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "请求 URL" },
        method: { type: "string", description: "HTTP 方法，默认 GET" },
        headers: { type: "object", description: "请求头，可选" },
        body: { type: "string", description: "请求体，可选。仅 POST/PUT/PATCH 有效" }
      },
      required: ["url"]
    }
  }
];

const EXTERNAL_TOOL_NAMES = new Set(AVAILABLE_TOOLS.map((tool) => tool.name));

const AnalyzeState = Annotation.Root({
  inputEvent: Annotation<InputEvent>,
  repository: Annotation<AgentLoopRepository>,
  modelProvider: Annotation<AnalyzeGraphInput["modelProvider"]>,
  tools: Annotation<ToolExecutor | undefined>,
  logModelRequest: Annotation<AnalyzeGraphInput["logModelRequest"] | undefined>,
  normalizedInput: Annotation<NormalizedInput | null>({
    default: () => null
  }),
  plan: Annotation<AnalyzePlan | null>({
    default: () => null
  }),
  memories: Annotation<MemoryRecord[]>({
    default: () => []
  }),
  messages: Annotation<unknown[]>({
    default: () => []
  }),
  pendingToolCalls: Annotation<PendingToolCall[]>({
    default: () => []
  }),
  analysis: Annotation<AnalysisResult | null>({
    default: () => null
  })
});

export async function analyzeInputWithGraph(input: AnalyzeGraphInput): Promise<AnalyzeGraphResult> {
  const graph = buildAnalyzeGraph();
  const result = await graph.invoke(input);
  if (!result.normalizedInput || !result.analysis) {
    throw new Error("Analyze graph did not produce a complete analysis");
  }
  return {
    normalizedInput: result.normalizedInput,
    analysis: result.analysis
  };
}

function buildAnalyzeGraph() {
  return new StateGraph(AnalyzeState)
    .addNode("normalize", normalizeNode)
    .addNode("plan_node", planNode)
    .addNode("recall_node", recallNode)
    .addNode("analyze_node", analyzeNode)
    .addNode("tools_node", toolsNode)
    .addEdge(START, "normalize")
    .addEdge("normalize", "plan_node")
    .addConditionalEdges("plan_node", routeAfterPlan)
    .addEdge("recall_node", "analyze_node")
    .addConditionalEdges("analyze_node", routeAfterAnalyze)
    .addEdge("tools_node", "analyze_node")
    .compile();
}

async function normalizeNode(state: typeof AnalyzeState.State) {
  return {
    normalizedInput: normalizeInputEvent(state.inputEvent)
  };
}

async function planNode(state: typeof AnalyzeState.State) {
  const normalizedInput = requireNormalizedInput(state);
  const model = getLangChainModel(state.modelProvider);
  const heuristicPlan = buildHeuristicPlan(normalizedInput);
  if (!model) return { plan: heuristicPlan };

  const messages = [
    new SystemMessage([
      "你是 Neura 的输入处理规划器。只规划，不回答用户。",
      "判断是否需要查历史记忆、是否需要工具、以及推荐 taskType。",
      "普通记录/测试/沉淀型输入不需要工具；历史查询需要 memory；文件、网络、命令、写入等请求才需要工具。"
    ].join("\n")),
    new HumanMessage(buildPlanPrompt(state.inputEvent, normalizedInput))
  ];

  const response = await invokeToolModel({
    model,
    messages,
    tools: [PLAN_TOOL],
    toolChoice: { type: "function", function: { name: PLAN_TOOL_NAME } },
    mode: "langgraph.plan",
    inputEventId: state.inputEvent.id,
    logModelRequest: state.logModelRequest
  });
  const toolCall = response.toolCalls.find((item) => item.name === PLAN_TOOL_NAME);
  const parsed = PlanSchema.parse(toolCall?.args ?? heuristicPlan);
  return {
    plan: {
      ...heuristicPlan,
      ...parsed,
      toolNames: sanitizeToolNames(parsed.toolNames)
    }
  };
}

async function recallNode(state: typeof AnalyzeState.State) {
  const normalizedInput = requireNormalizedInput(state);
  const recall = await recallMemories({ repository: state.repository, normalizedInput, limit: 5 });
  normalizedInput.memorySearchQuery = recall.query;
  return {
    normalizedInput,
    memories: recall.memories
  };
}

async function analyzeNode(state: typeof AnalyzeState.State) {
  const normalizedInput = requireNormalizedInput(state);
  const plan = state.plan ?? buildHeuristicPlan(normalizedInput);
  const model = getLangChainModel(state.modelProvider);

  if (!model) {
    const analysis = await state.modelProvider.analyzeInput(
      state.inputEvent,
    { normalizedInput, relatedMemories: state.memories ?? [] },
      { tools: [], logModelRequest: state.logModelRequest }
    );
    return { analysis };
  }

  const currentMessages = state.messages ?? [];
  const currentMemories = state.memories ?? [];
  const firstTurn = currentMessages.length === 0;
  const messages = firstTurn
    ? buildAnalysisMessages({ inputEvent: state.inputEvent, normalizedInput, memories: currentMemories, plan })
    : currentMessages;
  const tools = [...selectTools(plan), ANALYSIS_TOOL];
  const response = await invokeToolModel({
    model,
    messages,
    tools,
    toolChoice: selectTools(plan).length === 0
      ? { type: "function", function: { name: ANALYSIS_TOOL_NAME } }
      : undefined,
    mode: "langgraph.analyze",
    inputEventId: state.inputEvent.id,
    logModelRequest: state.logModelRequest
  });

  const analysisToolCall = response.toolCalls.find((item) => item.name === ANALYSIS_TOOL_NAME);
  if (analysisToolCall) {
    const analysis = normalizeAnalysis({ provider: state.modelProvider.id, ...analysisToolCall.args }, currentMemories);
    return {
      messages: [...messages, response.message],
      pendingToolCalls: [],
      analysis
    };
  }

  return {
    messages: [...messages, response.message],
    pendingToolCalls: response.toolCalls
      .filter((item) => EXTERNAL_TOOL_NAMES.has(item.name))
      .map((item) => ({ id: item.id, name: item.name, args: item.args as ToolInput }))
  };
}

async function toolsNode(state: typeof AnalyzeState.State) {
  const toolMessages = [];
  const memories = [...(state.memories ?? [])];

  for (const call of state.pendingToolCalls) {
    const result = await executeToolCall(state.tools, call.name, call.args);
    const slimResult = call.name === "search_memory" ? slimMemoryToolResult(result) : result;
    if (call.name === "search_memory" && Array.isArray(slimResult)) {
      memories.push(...(slimResult as MemoryRecord[]));
    }
    toolMessages.push(new ToolMessage({
      tool_call_id: call.id,
      content: JSON.stringify(slimResult),
      status: "success"
    }));
  }

  return {
    memories: dedupeMemories(memories),
    messages: [...(state.messages ?? []), ...toolMessages],
    pendingToolCalls: []
  };
}

function routeAfterPlan(state: typeof AnalyzeState.State) {
  return state.plan?.needsMemory ? "recall_node" : "analyze_node";
}

function routeAfterAnalyze(state: typeof AnalyzeState.State) {
  if (state.analysis) return END;
  return (state.pendingToolCalls ?? []).length > 0 ? "tools_node" : END;
}

function buildPlanPrompt(inputEvent: InputEvent, normalizedInput: NormalizedInput): string {
  return [
    `输入类型: ${inputEvent.type}`,
    `场景: ${normalizedInput.scenario}`,
    `初步 taskType: ${normalizedInput.taskType}`,
    `信号: ${JSON.stringify(normalizedInput.signals)}`,
    `标题: ${normalizedInput.title}`,
    `关键词: ${normalizedInput.keywords.join(", ")}`,
    `内容: ${truncateText(normalizedInput.normalizedText, 700)}`
  ].join("\n");
}

function buildAnalysisMessages({
  inputEvent,
  normalizedInput,
  memories,
  plan
}: {
  inputEvent: InputEvent;
  normalizedInput: NormalizedInput;
  memories: MemoryRecord[];
  plan: AnalyzePlan;
}) {
  return [
    new SystemMessage([
      "你是 Neura 的 Agent Loop 分析器。",
      "请基于规划、输入和已召回记忆提交结构化分析。",
      "如果外部工具足够必要且已提供，才调用工具；否则直接调用 record_neura_input_analysis。",
      "remembered 只在存在长期价值时为 true。普通测试输入、临时查询和纯操作请求通常不要写记忆。",
      "shouldOutput 只有用户主动需要回复、错误、审批、提醒或重要结果时才为 true。"
    ].join("\n")),
    new HumanMessage(buildAnalysisPrompt(inputEvent, normalizedInput, memories, plan))
  ];
}

function buildAnalysisPrompt(inputEvent: InputEvent, normalizedInput: NormalizedInput, memories: MemoryRecord[], plan: AnalyzePlan): string {
  return [
    "稳定规则：",
    "taskType 稳定值：context_capture、memory_capture、summarize_current、memory_query、query、reminder、action_request、event_capture、knowledge_ingest、visual_capture、decision_capture、preference_capture。",
    "总结当前长内容使用 summarize_current；查询历史记录使用 memory_query；明确要求记住/保存时 remembered=true。",
    "",
    "本次规划：",
    JSON.stringify(plan),
    "",
    "本次输入：",
    `输入类型: ${inputEvent.type}`,
    `场景: ${normalizedInput.scenario}`,
    `标题: ${normalizedInput.title}`,
    `标准化画像: ${formatNormalizedInput(normalizedInput)}`,
    `已有记忆: ${formatMemories(memories)}`,
    `输入内容: ${formatContent(inputEvent.content)}`
  ].join("\n");
}

function buildHeuristicPlan(normalizedInput: NormalizedInput): AnalyzePlan {
  const signals = normalizedInput.signals;
  const needsMemory = normalizedInput.taskType === "memory_query" || signals.asksHistoryLookup;
  const needsTools =
    signals.containsActionRequest ||
    normalizedInput.file !== null ||
    normalizedInput.image !== null ||
    ["action_request", "knowledge_ingest", "visual_capture"].includes(normalizedInput.taskType);
  const toolNames = needsTools
    ? ["read_file", "write_file", "delete_file", "execute_command", "call_model", "http_request"]
    : [];
  return {
    taskType: normalizedInput.taskType,
    needsMemory,
    needsTools,
    toolNames,
    reason: "heuristic_plan"
  };
}

async function invokeToolModel({
  model,
  messages,
  tools,
  toolChoice,
  mode,
  inputEventId,
  logModelRequest
}: {
  model: any;
  messages: unknown[];
  tools: unknown[];
  toolChoice?: unknown;
  mode: string;
  inputEventId: unknown;
  logModelRequest?: AnalyzeGraphInput["logModelRequest"];
}) {
  const requestMetadata = buildModelRequestMetadata({ mode, inputEventId, messages, tools });
  emitModelRequestLog(logModelRequest, "info", "Model request started", requestMetadata);
  try {
    const bound = model.bindTools(tools);
    const message = await bound.invoke(messages, toolChoice ? { tool_choice: toolChoice } : {});
    emitModelRequestLog(logModelRequest, "info", "Model request completed", {
      ...requestMetadata,
      responseId: message.id ?? null,
      responseModel: message.response_metadata?.model_name ?? message.response_metadata?.model ?? null,
      finishReason: message.response_metadata?.finish_reason ?? null,
      usage: normalizeLangChainUsage(message)
    });
    return {
      message,
      toolCalls: (message.tool_calls ?? []).map((item: Record<string, unknown>) => ({
        id: String(item.id ?? item.name ?? "tool_call"),
        name: String(item.name),
        args: (item.args ?? {}) as Record<string, unknown>
      }))
    };
  } catch (error) {
    emitModelRequestLog(logModelRequest, "error", "Model request failed", {
      ...requestMetadata,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function getLangChainModel(modelProvider: AnalyzeGraphInput["modelProvider"]) {
  return typeof modelProvider.asLangChainChatModel === "function"
    ? modelProvider.asLangChainChatModel()
    : null;
}

function selectTools(plan: AnalyzePlan) {
  if (!plan.needsTools && !plan.needsMemory) return [];
  const selected = new Set(plan.toolNames.filter((name) => EXTERNAL_TOOL_NAMES.has(name)));
  if (plan.needsMemory) selected.add("search_memory");
  return AVAILABLE_TOOLS
    .filter((tool) => selected.has(tool.name))
    .map(toOpenAITool);
}

function toOpenAITool(tool: (typeof AVAILABLE_TOOLS)[number]) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

async function executeToolCall(tools: ToolExecutor | undefined, name: string, input: ToolInput) {
  if (!tools) throw new Error(`Tool executor not available for ${name}`);
  if (name === "search_memory") return tools.searchMemory(input.query ?? "");
  if (name === "read_file") return tools.readFile(input.path ?? "");
  if (name === "write_file") return tools.writeFile(input.path ?? "", input.content ?? "");
  if (name === "delete_file") return tools.deleteFile(input.path ?? "");
  if (name === "execute_command") return tools.executeCommand(input.command ?? "", input.args, { cwd: input.cwd });
  if (name === "call_model") return tools.callModel(input.prompt ?? "", input.systemMessage);
  if (name === "http_request") return tools.httpRequest(input.url ?? "", input.method, input.headers ?? {}, input.body ?? null);
  throw new Error(`Unknown tool: ${name}`);
}

function normalizeAnalysis(candidate: Record<string, unknown>, memories: MemoryRecord[]): AnalysisResult {
  const parsed = AnalysisSchema.parse(candidate);
  return {
    provider: candidate.provider,
    summary: parsed.summary,
    tags: parsed.tags,
    taskType: parsed.taskType,
    category: parsed.category,
    intent: parsed.intent,
    remembered: parsed.remembered,
    memoryDecision: {
      shouldRemember: parsed.remembered,
      memoryType: parsed.memoryType,
      reason: parsed.memoryReason,
      actionHint: parsed.memoryActionHint
    },
    importance: parsed.importance,
    confidence: parsed.confidence,
    outputDecision: {
      shouldOutput: parsed.shouldOutput,
      type: parsed.outputType ?? "summary",
      reason: parsed.outputReason ?? "model_decision",
      priority: parsed.outputPriority ?? "medium"
    },
    extractedFacts: parsed.extractedFacts ?? [],
    warnings: parsed.warnings ?? [],
    relatedMemories: dedupeMemories(memories)
  };
}

function requireNormalizedInput(state: typeof AnalyzeState.State): NormalizedInput {
  if (!state.normalizedInput) throw new Error("Analyze graph missing normalized input");
  return state.normalizedInput;
}

function sanitizeToolNames(values: string[]): string[] {
  return [...new Set(values)].filter((value) => EXTERNAL_TOOL_NAMES.has(value));
}

function slimMemoryToolResult(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  return result.slice(0, 5).map((memory: Record<string, unknown>) => ({
    id: memory.id,
    summary: truncateText(memory.summary, 220),
    tags: Array.isArray(memory.tags) ? memory.tags.slice(0, 8) : [],
    importance: memory.importance,
    confidence: memory.confidence,
    sourceType: memory.sourceType,
    sourceId: memory.sourceId,
    vectorScore: memory.vectorScore
  }));
}

function dedupeMemories(memories: MemoryRecord[]): MemoryRecord[] {
  const unique = new Map<unknown, MemoryRecord>();
  for (const memory of memories) {
    if (!memory?.id) continue;
    unique.set(memory.id, memory);
  }
  return [...unique.values()];
}

function formatNormalizedInput(normalizedInput: NormalizedInput): string {
  return JSON.stringify({
    sourceKind: normalizedInput.sourceKind,
    scenario: normalizedInput.scenario,
    title: normalizedInput.title,
    keywords: normalizedInput.keywords,
    signals: normalizedInput.signals,
    file: normalizedInput.file,
    image: normalizedInput.image,
    summaryHint: normalizedInput.summaryHint
  });
}

function formatMemories(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "无";
  return memories.slice(0, 5).map((memory, index) => {
    return [
      `${index + 1}. ${memory.id}`,
      `摘要: ${truncateText(memory.summary, 220)}`,
      `标签: ${(memory.tags ?? []).slice(0, 8).join(", ")}`,
      `重要性: ${memory.importance}`
    ].join("\n");
  }).join("\n\n");
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function buildModelRequestMetadata({ mode, inputEventId, messages, tools }: { mode: string; inputEventId: unknown; messages: unknown[]; tools: unknown[] }) {
  const messagesChars = safeJsonLength(messages);
  const toolsChars = safeJsonLength(tools);
  return {
    mode,
    inputEventId,
    messageCount: messages.length,
    toolCount: tools.length,
    toolNames: tools.map((tool: any) => tool.function?.name ?? tool.name).filter(Boolean),
    messagesChars,
    toolsChars,
    approximateRequestChars: messagesChars + toolsChars
  };
}

function normalizeLangChainUsage(message: any) {
  const usage = message.usage_metadata ?? {};
  const tokenUsage = message.response_metadata?.tokenUsage ?? {};
  return {
    promptTokens: usage.input_tokens ?? tokenUsage.promptTokens ?? null,
    completionTokens: usage.output_tokens ?? tokenUsage.completionTokens ?? null,
    totalTokens: usage.total_tokens ?? tokenUsage.totalTokens ?? null,
    cachedTokens: usage.input_token_details?.cache_read ?? usage.input_token_details?.cached_tokens ?? null,
    reasoningTokens: usage.output_token_details?.reasoning ?? null
  };
}

function emitModelRequestLog(logger: AnalyzeGraphInput["logModelRequest"] | undefined, level: string, message: string, metadata: Record<string, unknown>) {
  if (typeof logger !== "function") return;
  try {
    logger(level, message, metadata);
  } catch {
    // Logging should never break model execution.
  }
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}

function truncateText(value: unknown, limit: number): string {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function getImageAttachment(inputEvent: InputEvent) {
  if (inputEvent.type !== "image") return null;
  const content = inputEvent.content as Record<string, unknown> | null | undefined;
  const metadata = inputEvent.metadata as Record<string, unknown> | null | undefined;
  const path = content?.path ?? content?.imagePath ?? metadata?.path;
  if (!path) return null;
  const absolutePath = resolve(String(path));
  const base64 = readFileSync(absolutePath).toString("base64");
  return {
    path: absolutePath,
    mimeType: String(content?.mimeType ?? detectMimeType(absolutePath)),
    base64
  };
}

function detectMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}
