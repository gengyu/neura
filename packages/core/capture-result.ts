export function buildCaptureResult({ normalizedInput, analysis, memoryAction, memory }) {
  const keyPoints = buildKeyPoints(analysis);
  const actions = buildActions(normalizedInput, analysis);
  const title = buildResultTitle(normalizedInput, analysis);

  return {
    title,
    summary: cleanSummary(analysis.summary),
    keyPoints,
    actions,
    tags: analysis.tags ?? [],
    category: analysis.category,
    intent: analysis.intent,
    memory: {
      remembered: Boolean(analysis.memoryDecision?.shouldRemember ?? analysis.remembered),
      action: memoryAction,
      id: memory?.id ?? null,
      type: analysis.memoryDecision?.memoryType ?? analysis.memoryType ?? "上下文总结"
    },
    confidence: analysis.confidence
  };
}

export function formatCaptureResult(captureResult) {
  const lines = [];
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

function buildResultTitle(normalizedInput, analysis) {
  const category = analysis.category || normalizedInput.scenario || "capture";
  if (normalizedInput.title && normalizedInput.title !== `Untitled ${normalizedInput.inputType}`) {
    return normalizedInput.title.slice(0, 80);
  }
  return category;
}

function buildKeyPoints(analysis) {
  const facts = (analysis.extractedFacts ?? [])
    .map(cleanSummary)
    .filter(Boolean);
  if (facts.length > 0) return [...new Set(facts)].slice(0, 6);

  return splitIntoPoints(analysis.summary).slice(0, 4);
}

function buildActions(normalizedInput, analysis) {
  const text = `${normalizedInput.normalizedText}\n${analysis.summary}`;
  const actions = [];

  if (analysis.taskType === "reminder" || normalizedInput.signals.containsReminderIntent) {
    actions.push("把这条记录作为提醒线索继续跟进。");
  }
  if (normalizedInput.signals.containsActionRequest) {
    actions.push("按这条输入继续生成可执行方案或整理稿。");
  }
  if (/待办|todo|下一步|跟进|检查|整理|推进/u.test(text)) {
    actions.push(...splitIntoPoints(text).filter((item) => /待办|todo|下一步|跟进|检查|整理|推进/u.test(item)));
  }

  return [...new Set(actions.map(cleanSummary).filter(Boolean))].slice(0, 5);
}

function splitIntoPoints(value) {
  return String(value ?? "")
    .split(/[\n。！？!?；;]/u)
    .map(cleanSummary)
    .filter((item) => item.length > 0 && item.length <= 160);
}

function cleanSummary(value) {
  return String(value ?? "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
