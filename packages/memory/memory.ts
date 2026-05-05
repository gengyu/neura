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
