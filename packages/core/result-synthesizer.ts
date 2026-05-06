export async function synthesizeResult({
  mode = "review",
  query = "",
  memories = [],
  normalizedInput = null,
  analysis = null,
  modelProvider = null
}) {
  if (!memories.length) {
    return {
      summary: query ? `目前没有找到与“${query}”相关的稳定记录。` : "目前还没有足够的记录可供整理。",
      bullets: [],
      actions: [],
      themes: [],
      sourceMemoryIds: []
    };
  }

  try {
    if (modelProvider?.callModel) {
      const response = await modelProvider.callModel(
        buildSynthesisPrompt({ mode, query, memories, normalizedInput, analysis }),
        "你是 Neura 的整理助手。请用简洁中文直接给出归纳结果，不要复述提示词。"
      );
      const content = String(response?.content ?? "").trim();
      if (content && !content.startsWith("Mock model response:")) {
        return {
          summary: content,
          bullets: [],
          actions: [],
          themes: deriveThemes(memories),
          sourceMemoryIds: memories.map((item) => item.id)
        };
      }
    }
  } catch {
    // Fall back to deterministic synthesis below.
  }

  return deterministicSynthesis({ mode, query, memories, normalizedInput });
}

export async function synthesizeCurrentInput({
  normalizedInput,
  analysis = null,
  modelProvider = null
}) {
  const text = normalizedInput?.normalizedText ?? "";
  if (!text.trim()) {
    return {
      summary: "当前输入没有足够内容可以整理。",
      bullets: [],
      actions: [],
      themes: [],
      sourceMemoryIds: []
    };
  }

  try {
    if (modelProvider?.callModel) {
      const response = await modelProvider.callModel(
        buildCurrentInputPrompt({ normalizedInput, analysis }),
        "你是 Neura 的内容整理助手。请直接给出对用户有用的中文整理结果，不要复述提示词。"
      );
      const content = String(response?.content ?? "").trim();
      if (content && !content.startsWith("Mock model response:")) {
        return {
          summary: content,
          bullets: [],
          actions: deriveActionsFromText(text),
          themes: normalizedInput.keywords ?? [],
          sourceMemoryIds: []
        };
      }
    }
  } catch {
    // Use deterministic local synthesis when the model cannot do secondary drafting.
  }

  return deterministicCurrentInputSynthesis({ normalizedInput, analysis });
}

function buildSynthesisPrompt({ mode, query, memories, normalizedInput, analysis }) {
  const memoryLines = memories.slice(0, 10).map((memory, index) => {
    return [
      `${index + 1}. 摘要: ${memory.summary}`,
      `标签: ${(memory.tags ?? []).join(", ")}`,
      `重要性: ${memory.importance}`,
      `内容: ${truncate(memory.content, 220)}`
    ].join("\n");
  }).join("\n\n");

  return [
    `任务模式: ${mode}`,
    query ? `用户关注主题: ${query}` : null,
    normalizedInput ? `当前输入: ${normalizedInput.normalizedText}` : null,
    analysis ? `当前分析摘要: ${analysis.summary}` : null,
    "请基于下面的记录，直接输出对用户有用的整理结果。",
    "如果是 review，请给出总体结论、关键主题、重要决定和待跟进项。",
    "如果是 answer，请直接回答用户问题，并引用你从记录中归纳出的结论。",
    memoryLines
  ].filter(Boolean).join("\n\n");
}

function buildCurrentInputPrompt({ normalizedInput, analysis }) {
  return [
    `输入标题: ${normalizedInput.title}`,
    `输入场景: ${normalizedInput.scenario}`,
    analysis ? `初步摘要: ${analysis.summary}` : null,
    "请把下面这段当前输入整理成：一句话结论、关键要点、可跟进行动。",
    "如果内容像文章或材料，请保留主要观点、结构和行动建议；如果像想法，请帮用户收敛成可继续推进的表达。",
    normalizedInput.normalizedText
  ].filter(Boolean).join("\n\n");
}

function deterministicSynthesis({ mode, query, memories, normalizedInput }) {
  const themes = deriveThemes(memories);
  const bullets = memories.slice(0, 4).map((memory) => cleanBullet(memory.summary));
  const actions = deriveActions(memories);

  const opener = mode === "answer"
    ? buildAnswerOpener(query, themes, bullets)
    : buildReviewOpener(query, themes, bullets);

  const sections = [opener];
  if (themes.length > 0) {
    sections.push(`重点主题：${themes.slice(0, 4).join("、")}`);
  }
  if (bullets.length > 0) {
    sections.push(`核心结论：${bullets.slice(0, 3).join("；")}`);
  }
  if (actions.length > 0) {
    sections.push(`建议跟进：${actions.slice(0, 3).join("；")}`);
  } else if (normalizedInput?.taskType === "query") {
    sections.push("目前更像是在持续沉淀想法，还没有形成明确待办。");
  }

  return {
    summary: sections.join("\n"),
    bullets,
    actions,
    themes,
    sourceMemoryIds: memories.map((item) => item.id)
  };
}

function deterministicCurrentInputSynthesis({ normalizedInput, analysis }) {
  const text = normalizedInput.normalizedText;
  const points = splitTextIntoPoints(text).slice(0, 6);
  const actions = deriveActionsFromText(text);
  const themes = normalizedInput.keywords?.slice(0, 6) ?? [];
  const opener = analysis?.summary
    ? cleanBullet(analysis.summary)
    : points[0] ?? normalizedInput.title ?? "已整理当前输入。";

  const sections = [`一句话结论：${opener}`];
  if (points.length > 0) {
    sections.push(`关键要点：${points.slice(0, 4).join("；")}`);
  }
  if (actions.length > 0) {
    sections.push(`建议跟进：${actions.slice(0, 3).join("；")}`);
  }

  return {
    summary: sections.join("\n"),
    bullets: points,
    actions,
    themes,
    sourceMemoryIds: []
  };
}

function deriveThemes(memories) {
  const counter = new Map();
  for (const memory of memories) {
    for (const tag of memory.tags ?? []) {
      const normalized = String(tag).trim();
      if (!normalized) continue;
      counter.set(normalized, (counter.get(normalized) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
    .map(([tag]) => tag)
    .slice(0, 6);
}

function deriveActions(memories) {
  const actions = [];
  for (const memory of memories) {
    const text = `${memory.summary}\n${memory.content}`;
    if (/提醒|待办|todo|检查|整理|推进|回看/u.test(text)) {
      actions.push(cleanBullet(memory.summary));
    }
  }
  return [...new Set(actions)];
}

function deriveActionsFromText(value) {
  return splitTextIntoPoints(value)
    .filter((item) => /待办|todo|下一步|跟进|检查|整理|推进|提醒|回看|需要|应该|可以/u.test(item))
    .slice(0, 5);
}

function splitTextIntoPoints(value) {
  return String(value ?? "")
    .split(/[\n。！？!?；;]/u)
    .map(cleanBullet)
    .filter((item) => item.length > 0 && item.length <= 180);
}

function buildAnswerOpener(query, themes, bullets) {
  if (bullets.length === 0) {
    return query ? `关于“${query}”，目前记录还不够多，暂时只能给出很初步的判断。` : "目前记录有限，只能给出初步判断。";
  }
  if (query) {
    return `基于现有记录，关于“${query}”，当前更明确的结论是：${bullets[0]}`;
  }
  return `基于现有记录，当前更明确的结论是：${bullets[0]}`;
}

function buildReviewOpener(query, themes, bullets) {
  if (query) {
    return `围绕“${query}”，最近的记录已经逐渐收敛到这些重点。`;
  }
  if (themes.length > 0) {
    return `最近的记录主要集中在 ${themes.slice(0, 3).join("、")} 这些方向。`;
  }
  return `最近记录里已经出现了一些可以整理的稳定主题。`;
}

function cleanBullet(value) {
  return String(value).replace(/^\[[^\]]+\]\s*/, "").trim();
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
