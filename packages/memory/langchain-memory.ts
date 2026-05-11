import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { PromptTemplate } from "@langchain/core/prompts";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { tokenize } from "./memory.ts";

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

const EMBEDDING_DIMENSIONS = 128;

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
  const vectorStore = await MemoryVectorStore.fromDocuments(
    memories.map(memoryToDocument),
    embeddings
  );
  const matches = await vectorStore.similaritySearchWithScore(query, limit);
  return matches
    .filter(([, score]) => score > 0)
    .map(([document, score]) => ({
      ...document.metadata.memory,
      vectorScore: Number(score.toFixed(6))
    }));
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
