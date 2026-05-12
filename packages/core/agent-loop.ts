import { INPUT_STATUSES, SOURCE_TYPES, TASK_STATUSES } from "../shared/types.ts";
import { normalizeInputEvent } from "./input-normalizer.ts";
import { synthesizeCurrentInput, synthesizeResult } from "./result-synthesizer.ts";
import { buildDecision } from "./decision-engine.ts";
import { buildCaptureResult } from "./capture-result.ts";
import { recallMemories } from "../memory/memory-recall.ts";
import { writeMemoryForDecision } from "../memory/memory-writer.ts";
import type {
  AgentLoopRepository,
  AnalysisResult,
  DecisionResult,
  InputEvent,
  ModelProvider,
  NormalizedInput,
  SynthesisResult,
  ToolExecutor,
  ToolInput
} from "./types.ts";

type AgentLoopSynthesis = SynthesisResult;

type AgentLoopScheduleResult = {
  created: boolean;
  id: unknown;
  name: string;
  mode: string;
  runAt: unknown;
  intervalMs: unknown;
};

type AgentLoopResult = {
  status: string;
  provider: unknown;
  taskType: string;
  scenario: string;
  category: unknown;
  intent: unknown;
  decision: string[];
  summary: string;
  tags: string[];
  remembered: boolean;
  memoryType: string | null;
  memoryReason: string | null;
  memoryAction: string;
  memoryId: string | number | null;
  outputHint: {
    shouldOutput: boolean;
    type: string;
    reason: string;
    priority: string;
  };
  shouldOutput: boolean;
  outputType: string;
  outputReason: string;
  importance: unknown;
  confidence: unknown;
  extractedFacts: string[];
  warnings: string[];
  normalizedInput: {
    title: string;
    inputType: string;
    sourceKind: string;
    keywords: string[];
  };
  relatedMemoryIds: unknown[];
  answer: string | null;
  themes: AgentLoopSynthesis["themes"];
  actions: AgentLoopSynthesis["actions"];
  schedule: AgentLoopScheduleResult | null;
  capture: ReturnType<typeof buildCaptureResult> | null;
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

const MINIMAL_TOOL_NAMES = new Set(["search_memory"]);
const ACTION_TOOL_NAMES = new Set(["search_memory", "read_file", "write_file", "delete_file", "execute_command", "call_model", "http_request"]);

export class AgentLoop {
  repository: AgentLoopRepository;
  policy: unknown;
  getModelProvider: () => ModelProvider;
  tools?: ToolExecutor;

  constructor(
      repository: AgentLoopRepository,
      policy: unknown,
      getModelProvider: () => ModelProvider,
      tools?: ToolExecutor
  ) {
    this.repository = repository;
    this.policy = policy;
    this.getModelProvider = getModelProvider;
    this.tools = tools;
  }

  async process(inputEvent: InputEvent): Promise<AgentLoopResult> {
    // === 1. TaskSetup: 创建任务记录并更新状态 ===
    const task = this.repository.createTask({
      sourceType: SOURCE_TYPES.INPUT_EVENT,
      sourceId: inputEvent.id,
      type: "agent_loop"
    });
    this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.PROCESSING);
    this.repository.log("info", "input", "Input event accepted", { inputEventId: inputEvent.id, type: inputEvent.type });

    try {
      // === 2. Analyze: 标准化输入、召回上下文、调用模型并生成结果 ===
      // === Normalize: 标准化输入，统一格式并提取关键信息 ===
      const normalizedInput: NormalizedInput = normalizeInputEvent(inputEvent);
      const modelProvider = this.getModelProvider();
      
      // === Recall: 记忆召回，搜索相关历史记忆提供上下文 ===
      const recall = await recallMemories({ repository: this.repository, normalizedInput, limit: 5 });
      normalizedInput.memorySearchQuery = recall.query;
      const contextMemories = recall.memories;
      const availableTools = this.tools ? selectToolsForInput(normalizedInput, contextMemories) : [];
      const toolset = this.tools;
      const executeTool = toolset
        ? async (name: string, input: ToolInput) => {
            // ToolStep: 工具执行阶段的实际调用逻辑
            if (name === "search_memory") return slimMemoryToolResult(await toolset.searchMemory(input.query ?? ""));
            if (name === "read_file") return toolset.readFile(input.path ?? "");
            if (name === "write_file") return toolset.writeFile(input.path ?? "", input.content ?? "");
            if (name === "delete_file") return toolset.deleteFile(input.path ?? "");
            if (name === "execute_command") return toolset.executeCommand(input.command ?? "", input.args, { cwd: input.cwd });
            if (name === "call_model") return toolset.callModel(input.prompt ?? "", input.systemMessage);
            if (name === "http_request") return toolset.httpRequest(input.url ?? "", input.method, input.headers ?? {}, input.body ?? null);
            throw new Error(`Unknown tool: ${name}`);
          }
        : undefined;

      // === ToolStep: 调用模型分析输入，可能触发工具执行或 ApprovalPause（等待确认）===
      const analysis: AnalysisResult = await modelProvider.analyzeInput(
        inputEvent,
        { normalizedInput, relatedMemories: contextMemories },
        {
          tools: availableTools,
          executeTool,
          logModelRequest: (level: string, message: string, metadata: Record<string, unknown>) => {
            this.repository.log(level, "model", message, metadata);
          }
        }
      );

      // === MemoryDecision: 基于分析结果决定记忆策略（新增/更新/跳过）===
      const decision: DecisionResult = buildDecision({ normalizedInput, analysis });
      const effectiveAnalysis = { ...analysis, taskType: decision.taskType };
      const { summary, tags } = effectiveAnalysis;
      const relatedMemories = analysis.relatedMemories ?? [];
      const memoryDecision = decision.memoryDecision;
      const remembered = Boolean(memoryDecision.shouldRemember);

      const result: AgentLoopResult = {
        status: TASK_STATUSES.COMPLETED,
        provider: effectiveAnalysis.provider,
        taskType: decision.taskType,
        scenario: normalizedInput.scenario,
        category: effectiveAnalysis.category,
        intent: effectiveAnalysis.intent,
        decision: decision.actions,
        summary,
        tags: tags ?? [],
        remembered,
        memoryType: memoryDecision.memoryType,
        memoryReason: memoryDecision.reason,
        memoryAction: "skipped",
        memoryId: null,
        outputHint: {
          shouldOutput: decision.output.shouldOutput,
          type: decision.output.type,
          reason: decision.output.reason,
          priority: decision.output.priority
        },
        shouldOutput: false,
        outputType: "none",
        outputReason: "agent_loop_does_not_dispatch_output",
        importance: effectiveAnalysis.importance,
        confidence: effectiveAnalysis.confidence,
        extractedFacts: effectiveAnalysis.extractedFacts ?? [],
        warnings: effectiveAnalysis.warnings ?? [],
        normalizedInput: {
          title: normalizedInput.title,
          inputType: normalizedInput.inputType,
          sourceKind: normalizedInput.sourceKind,
          keywords: normalizedInput.keywords
        },
        relatedMemoryIds: [...new Set(relatedMemories.map((item: { id: unknown }) => item.id))],
        answer: null,
        themes: [],
        actions: [],
        schedule: null,
        capture: null
      };

      let synthesis: AgentLoopSynthesis | null = null;
      // === MemorySynthesis: 根据决策模式合成记忆内容 ===
      if (decision.synthesisMode === "current_input") {
        // 对当前输入进行摘要和结构化
        const currentInputSynthesis: AgentLoopSynthesis = await synthesizeCurrentInput({
          normalizedInput,
          analysis: effectiveAnalysis,
          modelProvider
        });
        synthesis = currentInputSynthesis;
        result.summary = currentInputSynthesis.summary;
        result.answer = currentInputSynthesis.summary;
        result.themes = currentInputSynthesis.themes;
        result.actions = currentInputSynthesis.actions;
      } else if (decision.synthesisMode === "memory_answer") {
        // 基于历史记忆回答问题
        const memoryAnswerSynthesis: AgentLoopSynthesis = await synthesizeResult({
          mode: "answer",
          query: normalizedInput.normalizedText,
          memories: relatedMemories.length > 0 ? relatedMemories : (await recallMemories({ repository: this.repository, normalizedInput, limit: 8 })).memories,
          normalizedInput,
          analysis: effectiveAnalysis,
          modelProvider
        });
        synthesis = memoryAnswerSynthesis;
        result.summary = memoryAnswerSynthesis.summary;
        result.answer = memoryAnswerSynthesis.summary;
        result.themes = memoryAnswerSynthesis.themes;
        result.actions = memoryAnswerSynthesis.actions;
        result.relatedMemoryIds = memoryAnswerSynthesis.sourceMemoryIds ?? result.relatedMemoryIds;
      }

      let schedule = null;
      // 如果决策包含调度计划，创建定时任务
      if (decision.schedulePlan) {
        const createdSchedule = this.repository.createSchedule(decision.schedulePlan);
        schedule = createdSchedule;
        result.schedule = {
          created: true,
          id: createdSchedule.id,
          name: createdSchedule.name,
          mode: createdSchedule.mode,
          runAt: createdSchedule.runAt,
          intervalMs: createdSchedule.intervalMs
        };
        result.taskType = "reminder";
      }

      // === 3. Persist: 写入记忆、构建捕获结果并完成任务 ===
      // === MemoryWrite: 根据决策写入记忆（新增/更新/跳过）===
      const { memory, memoryAction } = await writeMemoryForDecision({
        repository: this.repository,
        inputEvent,
        normalizedInput,
        analysis: effectiveAnalysis,
        decision,
        synthesis
      });
      result.memoryAction = memoryAction;
      result.memoryId = (memory?.id as string | number | null | undefined) ?? null;

      // 构建捕获结果，整合所有处理产物
      result.capture = buildCaptureResult({
        normalizedInput,
        analysis: effectiveAnalysis,
        decision,
        memoryAction,
        memory,
        schedule,
        synthesis
      });

      // === TaskFinalize: 完成任务，更新状态 ===
      this.repository.finishTask(task.id, TASK_STATUSES.COMPLETED, result);
      this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.COMPLETED);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.finishTask(task.id, TASK_STATUSES.FAILED, null, message);
      this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.FAILED);
      this.repository.log("error", "task", "Agent loop failed", { inputEventId: inputEvent.id, error: message });
      throw error;
    }
  }
}

function selectToolsForInput(normalizedInput: NormalizedInput, contextMemories: unknown[]): typeof AVAILABLE_TOOLS {
  const signals = normalizedInput.signals;
  const needsExternalAction =
    signals.containsActionRequest ||
    normalizedInput.file !== null ||
    normalizedInput.image !== null ||
    ["action_request", "knowledge_ingest", "visual_capture"].includes(normalizedInput.taskType);

  const toolNames = needsExternalAction ? ACTION_TOOL_NAMES : MINIMAL_TOOL_NAMES;
  const shouldSearchMemory =
    normalizedInput.taskType === "memory_query" ||
    (contextMemories.length === 0 && (signals.containsQuestion || signals.asksHistoryLookup));

  return AVAILABLE_TOOLS.filter((tool) => {
    if (tool.name === "search_memory") return shouldSearchMemory;
    return toolNames.has(tool.name);
  });
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

function truncateText(value: unknown, limit: number): string {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
