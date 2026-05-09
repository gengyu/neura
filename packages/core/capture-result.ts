import type {
  AnalysisResult,
  DecisionResult,
  MemoryRecord,
  NormalizedInput,
  SchedulePlan,
  SynthesisResult
} from "./types.ts";

export type CaptureResult = {
  title: string;
  summary: string;
  keyPoints: string[];
  actions: string[];
  tags: string[];
  themes: string[];
  category?: string;
  intent?: string;
  taskType: string;
  decision: string[];
  memory: {
    remembered: boolean;
    action: string;
    id: unknown;
    type: string;
    reason: string | null;
  };
  schedule: {
    id: unknown;
    name: string;
    runAt: string | null;
    intervalMs: number | null;
    status?: string;
  } | null;
  confidence: unknown;
};

export function buildCaptureResult({
  normalizedInput,
  analysis,
  decision,
  memoryAction,
  memory,
  schedule = null,
  synthesis = null
}: {
  normalizedInput: NormalizedInput;
  analysis: AnalysisResult;
  decision: DecisionResult;
  memoryAction: string;
  memory?: MemoryRecord | null;
  schedule?: SchedulePlan | null;
  synthesis?: SynthesisResult | null;
}): CaptureResult {
  const keyPoints = buildKeyPoints(analysis);
  const actions = [...new Set([
    ...(synthesis?.actions ?? []),
    ...buildActions(normalizedInput, analysis, decision)
  ])].slice(0, 6);
  const title = buildResultTitle(normalizedInput, analysis);

  return {
    title,
    summary: cleanSummary(synthesis?.summary ?? analysis.summary),
    keyPoints: synthesis?.bullets?.length ? synthesis.bullets : keyPoints,
    actions,
    tags: analysis.tags ?? [],
    themes: synthesis?.themes ?? [],
    category: analysis.category,
    intent: analysis.intent,
    taskType: decision.taskType,
    decision: decision.actions,
    memory: {
      remembered: Boolean(decision.memoryDecision?.shouldRemember ?? analysis.remembered),
      action: memoryAction,
      id: memory?.id ?? null,
      type: decision.memoryDecision?.memoryType ?? analysis.memoryType ?? "上下文总结",
      reason: decision.memoryDecision?.reason ?? null
    },
    schedule: schedule
      ? {
          id: schedule.id,
          name: schedule.name,
          runAt: schedule.runAt,
          intervalMs: schedule.intervalMs,
          status: schedule.status
        }
      : null,
    confidence: analysis.confidence
  };
}

export function formatCaptureResult(captureResult: CaptureResult): string {
  const lines: string[] = [];
  lines.push(captureResult.summary);

  if (captureResult.keyPoints.length > 0) {
    lines.push("");
    lines.push("关键点：");
    for (const point of captureResult.keyPoints.slice(0, 5)) {
      lines.push(`- ${point}`);
    }
  }

  if (captureResult.actions.length > 0) {
    lines.push("");
    lines.push("下一步：");
    for (const action of captureResult.actions.slice(0, 4)) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n").trim();
}

function buildResultTitle(normalizedInput: NormalizedInput, analysis: AnalysisResult): string {
  const category = analysis.category || normalizedInput.scenario || "capture";
  if (normalizedInput.title && normalizedInput.title !== `Untitled ${normalizedInput.inputType}`) {
    return normalizedInput.title.slice(0, 80);
  }
  return category;
}

function buildKeyPoints(analysis: AnalysisResult): string[] {
  const facts = (analysis.extractedFacts ?? [])
    .map(cleanSummary)
    .filter(Boolean);
  if (facts.length > 0) return [...new Set(facts)].slice(0, 6);

  return splitIntoPoints(analysis.summary).slice(0, 4);
}

function buildActions(normalizedInput: NormalizedInput, analysis: AnalysisResult, decision: DecisionResult): string[] {
  const text = `${normalizedInput.normalizedText}\n${analysis.summary}`;
  const actions: string[] = [];

  if (decision?.schedulePlan) {
    actions.push(`已创建提醒：${decision.schedulePlan.name}`);
  } else if (analysis.taskType === "reminder" || normalizedInput.signals.containsReminderIntent) {
    actions.push("这条输入像提醒，但还缺少可解析时间。");
  }
  if (normalizedInput.signals.containsActionRequest) {
    actions.push("按这条输入继续生成可执行方案或整理稿。");
  }
  if (/待办|todo|下一步|跟进|检查|整理|推进/u.test(text)) {
    actions.push(...splitIntoPoints(text).filter((item) => /待办|todo|下一步|跟进|检查|整理|推进/u.test(item)));
  }

  return [...new Set(actions.map(cleanSummary).filter(Boolean))].slice(0, 5);
}

function splitIntoPoints(value: string): string[] {
  return String(value ?? "")
    .split(/[\n。！？!?；;]/u)
    .map(cleanSummary)
    .filter((item) => item.length > 0 && item.length <= 160);
}

function cleanSummary(value: string): string {
  return String(value ?? "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
