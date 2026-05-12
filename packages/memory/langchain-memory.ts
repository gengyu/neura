import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { PromptTemplate } from "@langchain/core/prompts";
import { similarityScore, tokenize } from "./memory.ts";

type MemoryLike = {
  summary?: string;
  content?: string;
  tags?: string[];
  [key: string]: unknown;
};

type NormalizedInputLike = {
  title: string;
  scenario: string;
  taskType: string;
  keywords: string[];
  normalizedText: string;
  memorySearchQuery: string;
};

const RECALL_QUERY_PROMPT = PromptTemplate.fromTemplate([
  "{title}",
  "{scenario}",
  "{taskType}",
  "{keywords}",
  "{text}"
].join("\n"));

const EMBEDDING_DIMENSIONS = 256;

class LocalTokenEmbeddings implements EmbeddingsInterface {
  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((document) => this.embedText(document));
  }

  async embedQuery(document: string): Promise<number[]> {
    return this.embedText(document);
  }

  private embedText(value: string): number[] {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
    for (const token of tokenize(value)) {
      vector[hashToken(token) % EMBEDDING_DIMENSIONS] += 1;
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((item) => item / magnitude);
  }
}

const embeddings = new LocalTokenEmbeddings();

export async function buildMemoryRecallQuery(normalizedInput: NormalizedInputLike): Promise<string> {
  const query = await RECALL_QUERY_PROMPT.format({
    title: normalizedInput.title,
    scenario: normalizedInput.scenario,
    taskType: normalizedInput.taskType,
    keywords: normalizedInput.keywords.slice(0, 8).join(" "),
    text: normalizedInput.normalizedText.slice(0, 320)
  });
  return query.replace(/\s+/gu, " ").trim().slice(0, 500) || normalizedInput.memorySearchQuery;
}

export async function searchMemoryRecords<T extends MemoryLike>(query: string, memories: T[], limit = 20): Promise<Array<T & { vectorScore: number }>> {
  if (memories.length === 0) return [];
  const queryTokens = tokenize(query);
  const queryVector = await embeddings.embedQuery(query);
  const documentVectors = await embeddings.embedDocuments(memories.map(memoryToDocumentText));
  const totalDocuments = memories.length;
  const documentFrequencies = buildDocumentFrequencies(memories);

  return memories
    .map((memory, index) => {
      const text = memoryToDocumentText(memory);
      const tokenSet = new Set(tokenize(text));
      const vectorScore = cosine(queryVector, documentVectors[index]);
      const keywordScore = scoreKeywordOverlap(queryTokens, tokenSet, documentFrequencies, totalDocuments);
      const phraseScore = scorePhrase(query, text);
      const tagScore = scoreTags(queryTokens, memory.tags ?? []);
      const importanceScore = normalizeNumber(memory.importance, 5);
      const recencyScore = scoreRecency(memory.updatedAt ?? memory.createdAt);
      const textSimilarity = similarityScore(query, text);
      const score =
        vectorScore * 0.32 +
        keywordScore * 0.24 +
        phraseScore * 0.16 +
        tagScore * 0.12 +
        textSimilarity * 0.08 +
        importanceScore * 0.05 +
        recencyScore * 0.03;

      return {
        ...memory,
        score: roundScore(score),
        vectorScore: roundScore(vectorScore),
        keywordScore: roundScore(keywordScore),
        phraseScore: roundScore(phraseScore),
        tagScore: roundScore(tagScore),
        importanceScore: roundScore(importanceScore),
        recencyScore: roundScore(recencyScore),
        matchReasons: buildMatchReasons({
          phraseScore,
          tagScore,
          keywordScore,
          vectorScore,
          importanceScore,
          recencyScore
        })
      };
    })
    .filter((memory) => memory.score > 0.03)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function memoryToDocument(memory: MemoryLike): Document {
  return new Document({
    pageContent: memoryToDocumentText(memory),
    metadata: { memory }
  });
}

export function memoryToDocumentText(memory: MemoryLike): string {
  return [
    memory.summary,
    memory.content,
    Array.isArray(memory.tags) ? memory.tags.join(" ") : ""
  ].filter(Boolean).join("\n");
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildDocumentFrequencies(memories: MemoryLike[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const memory of memories) {
    for (const token of new Set(tokenize(memoryToDocumentText(memory)))) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return frequencies;
}

function scoreKeywordOverlap(queryTokens: string[], documentTokens: Set<string>, documentFrequencies: Map<string, number>, totalDocuments: number): number {
  if (queryTokens.length === 0 || documentTokens.size === 0) return 0;
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const df = documentFrequencies.get(token) ?? 0;
    const idf = Math.log(1 + (totalDocuments + 1) / (df + 1));
    totalWeight += idf;
    if (documentTokens.has(token)) matchedWeight += idf;
  }
  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

function scorePhrase(query: string, text: string): number {
  const normalizedQuery = query.replace(/\s+/gu, " ").trim().toLowerCase();
  const normalizedText = text.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText.includes(normalizedQuery)) return 1;
  const queryPieces = normalizedQuery.split(/\s+/u).filter((piece) => piece.length >= 2);
  if (queryPieces.length === 0) return 0;
  const matched = queryPieces.filter((piece) => normalizedText.includes(piece)).length;
  return matched / queryPieces.length;
}

function scoreTags(queryTokens: string[], tags: string[]): number {
  if (queryTokens.length === 0 || tags.length === 0) return 0;
  const tagText = tags.join(" ");
  const tagTokens = new Set(tokenize(tagText));
  let matched = 0;
  for (const token of queryTokens) {
    if (tagTokens.has(token) || tagText.includes(token)) matched += 1;
  }
  return matched / queryTokens.length;
}

function scoreRecency(value: unknown): number {
  const timestamp = Date.parse(String(value ?? ""));
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function normalizeNumber(value: unknown, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number / max));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] ** 2;
    bMagnitude += b[index] ** 2;
  }
  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function buildMatchReasons(scores: Record<string, number>): string[] {
  const reasons = [];
  if (scores.phraseScore >= 0.7) reasons.push("phrase_match");
  if (scores.tagScore >= 0.4) reasons.push("tag_match");
  if (scores.keywordScore >= 0.35) reasons.push("keyword_overlap");
  if (scores.vectorScore >= 0.35) reasons.push("semantic_similarity");
  if (scores.importanceScore >= 0.8) reasons.push("high_importance");
  if (scores.recencyScore >= 0.75) reasons.push("recent_memory");
  return reasons;
}

function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}
