import { detectReminderPlan } from "./reminder-intent.ts";
import type {
  AnalysisResult,
  DecisionResult,
  MemoryDecision,
  NormalizedInput,
  OutputPolicy,
  SchedulePlan
} from "./types.ts";

export function buildDecision({ normalizedInput, analysis }: { normalizedInput: NormalizedInput; analysis: AnalysisResult }): DecisionResult {
  const taskType = chooseTaskType(normalizedInput, analysis);
  const memoryDecision = applyMemoryPolicy(normalizedInput, taskType, analysis.memoryDecision ?? {
    shouldRemember: Boolean(analysis.remembered),
    memoryType: "上下文总结",
    reason: "legacy_analysis",
    actionHint: analysis.remembered ? "create_or_update" : "skip"
  });
  const schedulePlan = detectReminderPlan(
    { ...normalizedInput, taskType },
    { ...analysis, taskType }
  );

  return {
    taskType,
    actions: buildActions(taskType, memoryDecision, schedulePlan),
    memoryDecision,
    schedulePlan,
    synthesisMode: chooseSynthesisMode(taskType),
    output: chooseOutputPolicy(normalizedInput, analysis, taskType, schedulePlan)
  };
}

function chooseTaskType(normalizedInput: NormalizedInput, analysis: AnalysisResult): string {
  if (normalizedInput.taskType === "summarize_current") return "summarize_current";
  if (normalizedInput.taskType === "reminder") return "reminder";
  if (normalizedInput.taskType === "memory_query") return "memory_query";
  if (normalizedInput.taskType === "memory_capture") return "memory_capture";
  if (analysis.taskType === "reminder" && !normalizedInput.signals.containsReminderIntent) {
    return normalizedInput.taskType;
  }
  return analysis.taskType ?? normalizedInput.taskType;
}

function applyMemoryPolicy(normalizedInput: NormalizedInput, taskType: string, memoryDecision: MemoryDecision): MemoryDecision {
  if (normalizedInput.signals.containsMemoryCommand) {
    return {
      ...memoryDecision,
      shouldRemember: true,
      memoryType: memoryDecision.memoryType ?? "上下文总结",
      reason: "user_explicitly_requested_memory",
      actionHint: memoryDecision.actionHint === "skip" ? "create_or_update" : memoryDecision.actionHint
    };
  }

  if (normalizedInput.taskType === "summarize_current" && normalizedInput.signals.hasLongFormContent) {
    return {
      ...memoryDecision,
      shouldRemember: true,
      memoryType: memoryDecision.memoryType === "上下文总结" ? "知识片段" : memoryDecision.memoryType,
      reason: memoryDecision.reason ?? "long_form_content_has_reference_value",
      actionHint: memoryDecision.actionHint === "skip" ? "create_or_update" : memoryDecision.actionHint
    };
  }

  if (["query", "memory_query"].includes(taskType)) {
    return {
      ...memoryDecision,
      shouldRemember: false,
      reason: "transient_lookup_should_not_pollute_memory",
      actionHint: "skip"
    };
  }

  return memoryDecision;
}

function buildActions(taskType: string, memoryDecision: MemoryDecision, schedulePlan: SchedulePlan | null): string[] {
  const actions: string[] = [];
  if (memoryDecision.shouldRemember) actions.push("remember");
  if (schedulePlan) actions.push("schedule");
  if (taskType === "summarize_current") actions.push("summarize_current");
  if (taskType === "memory_query" || taskType === "query") actions.push("search_memory");
  if (actions.length === 0) actions.push("capture");
  return actions;
}

function chooseSynthesisMode(taskType: string): string {
  if (taskType === "summarize_current") return "current_input";
  if (["query", "memory_query", "action_request"].includes(taskType)) return "memory_answer";
  return "none";
}

function chooseOutputPolicy(
  normalizedInput: NormalizedInput,
  analysis: AnalysisResult,
  taskType: string,
  schedulePlan: SchedulePlan | null
): OutputPolicy {
  if (schedulePlan) {
    return {
      shouldOutput: true,
      type: "reminder_created",
      reason: "reminder_schedule_created",
      priority: "high"
    };
  }

  if (taskType === "summarize_current") {
    return {
      shouldOutput: true,
      type: "current_summary",
      reason: "summarized_current_input",
      priority: "high"
    };
  }

  if (["query", "memory_query", "action_request"].includes(taskType)) {
    return {
      shouldOutput: true,
      type: "answer",
      reason: "synthesized_from_memory",
      priority: "high"
    };
  }

  return {
    ...analysis.outputDecision,
    shouldOutput: Boolean(analysis.outputDecision?.shouldOutput ?? normalizedInput.signals.userRequestedResponse),
    type: analysis.outputDecision?.type ?? "summary",
    reason: analysis.outputDecision?.reason ?? "model_decision",
    priority: analysis.outputDecision?.priority ?? "medium"
  };
}
