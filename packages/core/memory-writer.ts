import { normalizeToText } from "../memory/memory.ts";
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
} from "./types.ts";

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

  if (similar && memoryDecision.actionHint !== "create") {
    const memory = repository.updateMemory(similar.memory.id, memoryPayload);
    repository.log("info", "memory", "Memory updated", {
      memoryId: memory.id,
      inputEventId: inputEvent.id,
      similarity: similar.score,
      tags: memoryPayload.tags,
      memoryType: memoryDecision.memoryType
    });
    return { memory, memoryAction: "updated" };
  }

  if (memoryDecision.actionHint === "skip") {
    return { memory: null, memoryAction: "skipped" };
  }

  const memory = repository.createMemory(memoryPayload);
  repository.log("info", "memory", "Memory created", {
    memoryId: memory.id,
    inputEventId: inputEvent.id,
    tags: memoryPayload.tags,
    memoryType: memoryDecision.memoryType
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

  return {
    content: normalizeToText({
      input: normalizedInput.normalizedText,
      summary,
      facts,
      source: normalizedInput.sourcePluginId,
      scenario: normalizedInput.scenario,
      taskType: analysis.taskType
    }),
    summary: buildMemorySummary(summary, memoryDecision.memoryType),
    tags: dedupeTags(analysis.tags, synthesis?.themes, memoryDecision.memoryType, analysis.category),
    sourceInputId: inputEvent.id,
    sourceType: SOURCE_TYPES.INPUT_EVENT,
    sourceId: inputEvent.id,
    importance: analysis.importance,
    confidence: analysis.confidence
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
