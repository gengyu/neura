import cosineSimilarity from "cosine-similarity";
import natural from "natural";
import { normalizeToText } from "./memory.js";

const tokenizer = new natural.WordTokenizer();
const DIMENSIONS = 384;

export function createMemoryVector(value) {
  const vector = new Array(DIMENSIONS).fill(0);
  const tokens = tokenizeForVector(value);

  for (const token of tokens) {
    const index = hashToken(token) % DIMENSIONS;
    vector[index] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return magnitude > 0 ? vector.map((item) => Number((item / magnitude).toFixed(6))) : vector;
}

export function scoreMemoryVector(queryVector, memoryVector) {
  if (!queryVector?.length || !memoryVector?.length) return 0;
  return cosineSimilarity(queryVector, memoryVector);
}

export function tokenizeForVector(value) {
  const text = normalizeToText(value).toLowerCase();
  const latin = tokenizer
    .tokenize(text)
    .map((token) => natural.PorterStemmer.stem(token))
    .filter((token) => token.length > 1);
  const cjk = Array.from(text.matchAll(/\p{Script=Han}{1,2}/gu)).map((match) => match[0]);
  return [...new Set([...latin, ...cjk])];
}

function hashToken(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
