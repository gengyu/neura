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

const CJK_TOKEN_MIN_LENGTH = 2;

export const MEMORY_KINDS = new Set([
  "fact",
  "preference",
  "project",
  "person",
  "task",
  "decision",
  "knowledge",
  "note"
]);

export function normalizeForSimilarity(value: unknown): string {
  return normalizeToText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(value: unknown): string[] {
  const normalized = normalizeForSimilarity(value);
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) ?? [];
  const cjkChars = normalized.match(/\p{Script=Han}/gu) ?? [];
  const cjkWords = normalized.match(/\p{Script=Han}{2,}/gu) ?? [];
  const cjkNgrams = cjkWords.flatMap((word) => buildCharacterNgrams(word, CJK_TOKEN_MIN_LENGTH, 4));
  return [...new Set([...latin, ...cjkChars, ...cjkNgrams].filter((token) => !STOP_WORDS.has(token)))];
}

export function similarityScore(a: unknown, b: unknown): number {
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

export function normalizeToText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

export function normalizeMemoryKind(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "note";
  const aliases: Record<string, string> = {
    fact: "fact",
    facts: "fact",
    "事实": "fact",
    preference: "preference",
    preferences: "preference",
    pref: "preference",
    "偏好": "preference",
    project: "project",
    "项目": "project",
    person: "person",
    people: "person",
    user: "person",
    "人物": "person",
    "用户": "person",
    task: "task",
    todo: "task",
    reminder: "task",
    "任务": "task",
    "待办": "task",
    decision: "decision",
    decisions: "decision",
    "决策": "decision",
    "产品决策": "decision",
    "技术决策": "decision",
    knowledge: "knowledge",
    "知识": "knowledge",
    "知识片段": "knowledge",
    note: "note",
    context: "note",
    "上下文": "note",
    "上下文总结": "note",
    "用户想法": "note"
  };
  return aliases[normalized] ?? (MEMORY_KINDS.has(normalized) ? normalized : "note");
}

export function inferMemoryKind({
  memoryType,
  tags = [],
  summary = "",
  content = ""
}: {
  memoryType?: unknown;
  tags?: unknown[];
  summary?: unknown;
  content?: unknown;
} = {}): string {
  const direct = normalizeMemoryKind(memoryType);
  if (direct !== "note") return direct;

  const text = [
    memoryType,
    ...(Array.isArray(tags) ? tags : []),
    summary,
    content
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(偏好|喜欢|倾向|习惯|preference|prefer)/u.test(text)) return "preference";
  if (/(项目|prd|roadmap|架构|project|neura)/u.test(text)) return "project";
  if (/(人物|用户|客户|同事|person|people)/u.test(text)) return "person";
  if (/(任务|待办|提醒|todo|reminder|task)/u.test(text)) return "task";
  if (/(决策|决定|取舍|decision|原则)/u.test(text)) return "decision";
  if (/(知识|资料|文档|reference|knowledge|事实|fact)/u.test(text)) return "knowledge";
  return "note";
}

export function detectMemoryConflict(a: unknown, b: unknown): { conflicting: boolean; score: number; reasons: string[] } {
  const aText = normalizeToText(a);
  const bText = normalizeToText(b);
  const overlap = similarityScore(aText, bText);
  const aPolarity = detectPolarity(aText);
  const bPolarity = detectPolarity(bText);
  const reasons: string[] = [];

  for (const pair of POLARITY_PAIRS) {
    const aPositive = aPolarity.positive.has(pair.key);
    const aNegative = aPolarity.negative.has(pair.key);
    const bPositive = bPolarity.positive.has(pair.key);
    const bNegative = bPolarity.negative.has(pair.key);
    if ((aPositive && bNegative) || (aNegative && bPositive)) {
      reasons.push(`opposite_${pair.key}`);
    }
  }

  const tagOverlap = overlap >= 0.18 ? "semantic_overlap" : null;
  if (tagOverlap) reasons.push(tagOverlap);
  const score = Math.min(1, overlap + Math.min(reasons.length, 3) * 0.18);
  return {
    conflicting: reasons.some((reason) => reason.startsWith("opposite_")) && overlap >= 0.12,
    score,
    reasons: [...new Set(reasons)]
  };
}

const POLARITY_PAIRS = [
  { key: "allow", positive: ["允许", "可以", "支持", "enable", "enabled", "allow"], negative: ["禁止", "不允许", "不能", "不支持", "disable", "disabled", "forbid"] },
  { key: "need", positive: ["需要", "必须", "应该", "need", "must", "should"], negative: ["不需要", "无需", "不用", "不应该", "不要", "avoid"] },
  { key: "use", positive: ["采用", "使用", "保留", "接入", "use", "keep", "adopt"], negative: ["不采用", "不用", "移除", "删除", "不要用", "remove", "drop"] },
  { key: "is", positive: ["是", "属于", "作为", "is"], negative: ["不是", "不属于", "不要作为", "is not"] },
  { key: "priority", positive: ["优先", "先做", "提前", "priority"], negative: ["暂缓", "后置", "不优先", "defer", "later"] }
];

function detectPolarity(value: unknown): { positive: Set<string>; negative: Set<string> } {
  const text = normalizeToText(value).toLowerCase();
  const positive = new Set<string>();
  const negative = new Set<string>();
  for (const pair of POLARITY_PAIRS) {
    if (pair.positive.some((token) => text.includes(token))) positive.add(pair.key);
    if (pair.negative.some((token) => text.includes(token))) negative.add(pair.key);
  }
  return { positive, negative };
}

function buildCharacterNgrams(value: string, minLength: number, maxLength: number): string[] {
  const chars = [...value];
  const tokens: string[] = [];
  for (let size = minLength; size <= Math.min(maxLength, chars.length); size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1) {
      tokens.push(chars.slice(index, index + size).join(""));
    }
  }
  return tokens;
}
