import { inferMemoryKind, normalizeToText } from "./memory.ts";
import { SOURCE_TYPES } from "../shared/types.ts";
import type {
  AnalysisResult,
  DecisionResult,
  InputEvent,
  MemoryDecision,
  MemoryRecord,
  MemoryPersistenceRepository,
  NormalizedInput,
  SynthesisResult
} from "../core/types.ts";

export async function writeMemoryForDecision({
  repository,
  inputEvent,
  normalizedInput,
  analysis,
  decision,
  synthesis = null
}: {
  repository: MemoryPersistenceRepository;
  inputEvent: InputEvent;
  normalizedInput: NormalizedInput;
  analysis: AnalysisResult;
  decision: DecisionResult;
  synthesis?: SynthesisResult | null;
}): Promise<{ memory: MemoryRecord | null; memoryAction: string }> {
  const memoryDecision = decision.memoryDecision;
  if (!memoryDecision.shouldRemember) {
    return { memory: null, memoryAction: "skipped" };
  }

  const memoryPayload = buildMemoryPayload({
    inputEvent,
    normalizedInput,
    analysis,
    memoryDecision,
    synthesis
  });
  const similar = await repository.findSimilarMemory(
    memoryPayload,
    shouldUseStrictSimilarity(memoryDecision) ? 0.86 : 0.78
  );
  const conflicts = repository.findMemoryConflicts?.(memoryPayload, {
    excludeIds: similar?.memory?.id ? [similar.memory.id] : [],
    limit: 5
  }) ?? [];
  const finalMemoryPayload = applyConflictMetadata(memoryPayload, conflicts);

  if (similar && memoryDecision.actionHint !== "create") {
    const memory = repository.updateMemory(similar.memory.id, finalMemoryPayload);
    repository.log("info", "memory", "Memory updated", {
      memoryId: memory.id,
      inputEventId: inputEvent.id,
      similarity: similar.score,
      tags: finalMemoryPayload.tags,
      memoryType: memoryDecision.memoryType,
      conflictStatus: finalMemoryPayload.conflictStatus,
      conflictMemoryIds: finalMemoryPayload.conflictMemoryIds
    });
    return { memory, memoryAction: "updated" };
  }

  if (memoryDecision.actionHint === "skip") {
    return { memory: null, memoryAction: "skipped" };
  }

  const memory = repository.createMemory(finalMemoryPayload);
  repository.log("info", "memory", "Memory created", {
    memoryId: memory.id,
    inputEventId: inputEvent.id,
    tags: finalMemoryPayload.tags,
    memoryType: memoryDecision.memoryType,
    conflictStatus: finalMemoryPayload.conflictStatus,
    conflictMemoryIds: finalMemoryPayload.conflictMemoryIds
  });
  return { memory, memoryAction: "created" };
}

function buildMemoryPayload({
  inputEvent,
  normalizedInput,
  analysis,
  memoryDecision,
  synthesis
}: {
  inputEvent: InputEvent;
  normalizedInput: NormalizedInput;
  analysis: AnalysisResult;
  memoryDecision: MemoryDecision;
  synthesis?: SynthesisResult | null;
}): Record<string, unknown> {
  const summary = synthesis?.summary ?? analysis.summary;
  const facts = [
    ...(analysis.extractedFacts ?? []),
    ...(synthesis?.bullets ?? [])
  ].slice(0, 10);

  const memoryKind = inferMemoryKind({
    memoryType: memoryDecision.memoryType,
    tags: dedupeTags(analysis.tags, synthesis?.themes, memoryDecision.memoryType, analysis.category),
    summary,
    content: normalizedInput.normalizedText
  });
  const tags = dedupeTags(analysis.tags, synthesis?.themes, memoryDecision.memoryType, analysis.category, memoryKind);

  return {
    content: normalizeToText({
      input: normalizedInput.normalizedText,
      summary,
      facts,
      source: normalizedInput.sourcePluginId,
      scenario: normalizedInput.scenario,
      taskType: analysis.taskType,
      memoryKind,
      memoryType: memoryDecision.memoryType
    }),
    summary: buildMemorySummary(summary, memoryDecision.memoryType),
    tags,
    memoryKind,
    memoryType: memoryDecision.memoryType,
    sourceInputId: inputEvent.id,
    sourceType: SOURCE_TYPES.INPUT_EVENT,
    sourceId: inputEvent.id,
    importance: analysis.importance,
    confidence: analysis.confidence,
    conflictStatus: "none",
    conflictMemoryIds: []
  };
}

function applyConflictMetadata(memoryPayload: Record<string, unknown>, conflicts: Array<{ memory: MemoryRecord; score: number; reasons: string[] }>): Record<string, unknown> {
  if (conflicts.length === 0) return memoryPayload;
  const conflictIds = conflicts.map((item) => item.memory.id).filter(Boolean);
  return {
    ...memoryPayload,
    tags: dedupeTags(memoryPayload.tags as string[], "conflict_review"),
    confidence: Math.min(Number(memoryPayload.confidence ?? 0.7), 0.55),
    conflictStatus: "suspected",
    conflictMemoryIds: conflictIds,
    conflictReasons: conflicts.map((item) => ({
      memoryId: item.memory.id,
      score: item.score,
      reasons: item.reasons
    }))
  };
}

function dedupeTags(...groups: Array<Array<string | null | undefined> | string | null | undefined>): string[] {
  return [...new Set(
    groups
      .flat()
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  )].slice(0, 12);
}

function buildMemorySummary(summary: string, memoryType: string | null): string {
  if (!memoryType) return summary;
  if (summary.startsWith(`[${memoryType}]`)) return summary;
  return `[${memoryType}] ${summary}`;
}

function shouldUseStrictSimilarity(memoryDecision: MemoryDecision): boolean {
  return memoryDecision.memoryType === "知识片段" || memoryDecision.actionHint === "create";
}
