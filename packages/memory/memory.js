const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "一个",
  "这个",
  "以及",
  "需要",
  "可以",
  "应该"
]);

const KEYWORD_TAGS = [
  ["Neura", "neura"],
  ["OpenClaw", "openclaw"],
  ["插件", "plugin"],
  ["输入", "input"],
  ["输出", "output"],
  ["运行时", "runtime"],
  ["智能体", "agent"],
  ["记忆", "memory"],
  ["工具", "tool"],
  ["权限", "policy"],
  ["任务", "task"],
  ["SQLite", "sqlite"],
  ["CLI", "cli"],
  ["Webhook", "webhook"],
  ["截图", "screenshot"],
  ["文件", "file"]
];

export function summarizeContent(content) {
  const text = normalizeToText(content);
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "空输入";
  const sentence = compact.split(/(?<=[。！？.!?])\s*/u)[0] || compact;
  return sentence.length > 96 ? `${sentence.slice(0, 96)}...` : sentence;
}

export function generateTags(content) {
  const text = normalizeToText(content);
  const lower = text.toLowerCase();
  const tags = [];

  for (const [label, needle] of KEYWORD_TAGS) {
    if (text.includes(label) || lower.includes(needle)) tags.push(label);
  }

  for (const word of lower.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(word) && !tags.includes(word) && tags.length < 8) tags.push(word);
  }

  return tags.length > 0 ? tags.slice(0, 8) : ["未分类"];
}

export function shouldRemember(content) {
  const text = normalizeToText(content);
  if (text.length < 8) return false;
  const durableSignals = ["我想", "希望", "决定", "记住", "设计", "Neura", "neura", "应该", "偏好", "原则", "需求"];
  return text.length >= 24 || durableSignals.some((signal) => text.includes(signal));
}

export function scoreImportance(content, tags) {
  const text = normalizeToText(content);
  let score = 3;
  if (text.length > 80) score += 1;
  if (tags.some((tag) => ["Neura", "插件", "运行时", "智能体", "记忆", "权限"].includes(tag))) score += 1;
  if (text.includes("决定") || text.includes("原则") || text.includes("必须")) score += 1;
  return Math.min(score, 5);
}

export function normalizeForSimilarity(value) {
  return normalizeToText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(value) {
  const normalized = normalizeForSimilarity(value);
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) ?? [];
  const cjk = normalized.match(/\p{Script=Han}/gu) ?? [];
  return [...new Set([...latin, ...cjk].filter((token) => !STOP_WORDS.has(token)))];
}

export function similarityScore(a, b) {
  const aText = normalizeForSimilarity(a);
  const bText = normalizeForSimilarity(b);
  if (!aText || !bText) return 0;
  if (aText === bText) return 1;
  if (aText.includes(bText) || bText.includes(aText)) return 0.92;

  const aTokens = new Set(tokenize(aText));
  const bTokens = new Set(tokenize(bText));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

export function normalizeToText(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}
