import { INPUT_STATUSES, SOURCE_TYPES, TASK_STATUSES } from "../shared/types.ts";
import { analyzeInputWithGraph } from "./analyze-graph.ts";
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
  ToolExecutor
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
      const modelProvider = this.getModelProvider();

      // === 2. AnalyzeGraph: Normalize -> Plan -> Optional Recall/Tools -> Final Analysis ===
      const { normalizedInput, analysis }: { normalizedInput: NormalizedInput; analysis: AnalysisResult } = await analyzeInputWithGraph({
        inputEvent,
        repository: this.repository,
        modelProvider,
        tools: this.tools,
        logModelRequest: (level: string, message: string, metadata: Record<string, unknown>) => {
          this.repository.log(level, "model", message, metadata);
        }
      });

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
        warnings: [
          ...(effectiveAnalysis.warnings ?? []),
          ...extractIngestWarnings(inputEvent.content)
        ],
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

function extractIngestWarnings(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const warnings = (content as { ingest?: { warnings?: unknown } }).ingest?.warnings;
  return Array.isArray(warnings) ? warnings.map(String) : [];
}
