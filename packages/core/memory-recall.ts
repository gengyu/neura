import { buildMemoryRecallQuery, searchMemoryRecords } from "../memory/langchain-memory.ts";
import type { MemoryRecord, NormalizedInput } from "./types.ts";

type RecallRepository = {
  listMemories?: (limit: number) => MemoryRecord[];
  searchMemories: (query: string, limit: number) => Promise<MemoryRecord[]>;
};

type RecallInput = {
  repository: RecallRepository;
  normalizedInput: NormalizedInput;
  limit?: number;
  poolLimit?: number;
};

type RecallResult = {
  query: string;
  memories: MemoryRecord[];
};

export async function recallMemories({ repository, normalizedInput, limit = 5, poolLimit = 200 }: RecallInput): Promise<RecallResult> {
  const query = await buildMemoryRecallQuery(normalizedInput);
  const memoryPool = repository.listMemories?.(poolLimit) ?? [];
  if (memoryPool.length === 0) {
    return {
      query,
      memories: await repository.searchMemories(query, limit)
    };
  }

  const memories = await searchMemoryRecords(query, memoryPool, limit);

  return {
    query,
    memories: memories.length > 0 ? memories : await repository.searchMemories(query, limit)
  };
}
