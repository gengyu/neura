import { generateTags, scoreImportance, shouldRemember, summarizeContent } from "../memory/memory.js";

export class RuleBasedModelProvider {
  constructor(options = {}) {
    this.id = "rule-based";
    this.options = options;
  }

  analyzeInput(inputEvent, context = {}) {
    const summary = summarizeContent(inputEvent.content);
    const tags = generateTags(inputEvent.content);
    const remembered = shouldRemember(inputEvent.content);

    return {
      provider: this.id,
      summary,
      tags,
      remembered,
      importance: scoreImportance(inputEvent.content, tags),
      confidence: remembered ? 0.72 : 0.58,
      outputDecision: {
        shouldOutput: true,
        type: "summary",
        reason: context.forceOutput ? "requested" : "input_processed"
      }
    };
  }
}

export function createModelProvider(config = {}) {
  if (!config.provider || config.provider === "rule-based") {
    return new RuleBasedModelProvider(config);
  }

  throw new Error(`Unsupported model provider: ${config.provider}`);
}
