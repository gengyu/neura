import { INPUT_STATUSES, TASK_STATUSES } from "../shared/types.js";
import { normalizeToText } from "../memory/memory.js";

export class AgentLoop {
  constructor({ repository, policy, modelProvider }) {
    this.repository = repository;
    this.policy = policy;
    this.modelProvider = modelProvider;
  }

  async process(inputEvent) {
    const task = this.repository.createTask(inputEvent.id, "agent_loop");
    this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.PROCESSING);
    this.repository.log("info", "input", "Input event accepted", { inputEventId: inputEvent.id, type: inputEvent.type });

    try {
      const initialTags = ["Neura", "智能体", "运行时", "记忆", "插件"];
      const contextMemories = initialTags.flatMap((tag) => this.repository.searchMemories(tag, 2)).slice(0, 5);
      const analysis = await this.modelProvider.analyzeInput(inputEvent, { forceOutput: true, relatedMemories: contextMemories });
      const { summary, tags, remembered } = analysis;
      const relatedMemories = tags
        .filter((tag) => tag !== "未分类")
        .flatMap((tag) => this.repository.searchMemories(tag, 3))
        .slice(0, 3);

      let memory = null;
      let memoryAction = "skipped";
      if (remembered) {
        const memoryPayload = {
          content: normalizeToText(inputEvent.content),
          summary,
          tags,
          sourceInputId: inputEvent.id,
          importance: analysis.importance,
          confidence: analysis.confidence
        };
        const similar = this.repository.findSimilarMemory(memoryPayload);
        if (similar) {
          memory = this.repository.updateMemory(similar.memory.id, memoryPayload);
          memoryAction = "updated";
          this.repository.log("info", "memory", "Memory updated", {
            memoryId: memory.id,
            inputEventId: inputEvent.id,
            similarity: similar.score,
            tags
          });
        } else {
          memory = this.repository.createMemory(memoryPayload);
          memoryAction = "created";
          this.repository.log("info", "memory", "Memory created", { memoryId: memory.id, inputEventId: inputEvent.id, tags });
        }
      }

      const result = {
        status: "completed",
        provider: analysis.provider,
        fallbackReason: analysis.fallbackReason ?? null,
        summary,
        tags,
        remembered,
        memoryAction,
        memoryId: memory?.id ?? null,
        relatedMemoryIds: [...new Set(relatedMemories.map((item) => item.id))]
      };

      if (analysis.outputDecision.shouldOutput && this.policy.canSendOutput()) {
        this.repository.createOutputEvent({
          pluginId: "cli-output",
          type: analysis.outputDecision.type,
          content: result
        });
        this.repository.log("info", "output", "CLI output event created", { inputEventId: inputEvent.id });
      }

      this.repository.finishTask(task.id, TASK_STATUSES.COMPLETED, result);
      this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.COMPLETED);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.finishTask(task.id, TASK_STATUSES.FAILED, null, message);
      this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.FAILED);
      this.repository.log("error", "task", "Agent loop failed", { inputEventId: inputEvent.id, error: message });
      throw error;
    }
  }
}
