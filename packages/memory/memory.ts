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
