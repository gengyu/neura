import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { generateTags, scoreImportance, shouldRemember, summarizeContent } from "../memory/memory.js";

const AnalysisSchema = z.object({
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(8),
  remembered: z.boolean(),
  importance: z.number().min(1).max(5),
  confidence: z.number().min(0).max(1),
  shouldOutput: z.boolean().default(true),
  outputType: z.string().default("summary")
});

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

export class OpenAICompatibleModelProvider {
  constructor(options = {}) {
    this.id = options.id ?? options.provider ?? "openai-compatible";
    this.model = options.model ?? "deepseek-chat";
    this.apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "OPENAI_API_KEY"];
    this.fallback = new RuleBasedModelProvider();
    this.client = this.apiKey
      ? new OpenAI({
          apiKey: this.apiKey,
          baseURL: trimTrailingSlash(options.baseUrl),
          timeout: options.timeoutMs ?? 30000
        })
      : null;
  }

  async analyzeInput(inputEvent, context = {}) {
    const fallback = this.fallback.analyzeInput(inputEvent, context);
    if (!this.client) return fallbackWithReason(this.id, fallback, "missing_api_key");

    try {
      const completion = await this.client.beta.chat.completions.parse({
        model: this.model,
        temperature: 0.2,
        response_format: zodResponseFormat(AnalysisSchema, "neura_input_analysis"),
        messages: [
          {
            role: "system",
            content: "你是 Neura 的 Agent Loop 分析器。请把输入事件分析成结构化结果，只保留有长期价值的信息。"
          },
          {
            role: "user",
            content: buildPrompt(inputEvent, context)
          }
        ]
      });

      const parsed = completion.choices[0]?.message?.parsed;
      return normalizeAnalysis({ provider: this.id, ...parsed }, fallback);
    } catch (error) {
      return fallbackWithReason(this.id, fallback, error instanceof Error ? error.message : String(error));
    }
  }
}

export class DeepSeekModelProvider extends OpenAICompatibleModelProvider {
  constructor(options = {}) {
    super({
      ...options,
      id: "deepseek",
      baseUrl: options.baseUrl ?? "https://api.deepseek.com",
      model: options.model ?? "deepseek-chat",
      apiKeyEnv: options.apiKeyEnv ?? "DEEPSEEK_API_KEY"
    });
  }
}

export class AnthropicCompatibleModelProvider {
  constructor(options = {}) {
    this.id = options.id ?? options.provider ?? "anthropic-compatible";
    this.model = options.model ?? "deepseek-chat";
    this.apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    this.fallback = new RuleBasedModelProvider();
    this.client = this.apiKey
      ? new Anthropic({
          apiKey: this.apiKey,
          baseURL: trimTrailingSlash(options.baseUrl),
          timeout: options.timeoutMs ?? 30000
        })
      : null;
  }

  async analyzeInput(inputEvent, context = {}) {
    const fallback = this.fallback.analyzeInput(inputEvent, context);
    if (!this.client) return fallbackWithReason(this.id, fallback, "missing_api_key");

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        temperature: 0.2,
        system: "你是 Neura 的 Agent Loop 分析器。请调用工具返回结构化分析结果。",
        tools: [
          {
            name: "record_neura_input_analysis",
            description: "Record a structured Neura input analysis.",
            input_schema: z.toJSONSchema(AnalysisSchema)
          }
        ],
        tool_choice: { type: "tool", name: "record_neura_input_analysis" },
        messages: [
          {
            role: "user",
            content: buildPrompt(inputEvent, context)
          }
        ]
      });

      const toolUse = message.content.find((part) => part.type === "tool_use" && part.name === "record_neura_input_analysis");
      const parsed = AnalysisSchema.parse(toolUse?.input);
      return normalizeAnalysis({ provider: this.id, ...parsed }, fallback);
    } catch (error) {
      return fallbackWithReason(this.id, fallback, error instanceof Error ? error.message : String(error));
    }
  }
}

export class DeepSeekAnthropicModelProvider extends AnthropicCompatibleModelProvider {
  constructor(options = {}) {
    super({
      ...options,
      id: "deepseek-anthropic",
      baseUrl: options.anthropicBaseUrl ?? options.baseUrl ?? "https://api.deepseek.com/anthropic",
      model: options.model ?? "deepseek-chat",
      apiKeyEnv: options.apiKeyEnv ?? "DEEPSEEK_API_KEY"
    });
  }
}

export function createModelProvider(config = {}) {
  const provider = process.env.NEURA_MODEL_PROVIDER || config.provider;
  const mergedConfig = { ...config, provider };
  if (!provider || provider === "rule-based") return new RuleBasedModelProvider(mergedConfig);
  if (provider === "deepseek") return new DeepSeekModelProvider(mergedConfig);
  if (provider === "openai-compatible") return new OpenAICompatibleModelProvider(mergedConfig);
  if (provider === "anthropic-compatible") return new AnthropicCompatibleModelProvider(mergedConfig);
  if (provider === "deepseek-anthropic") return new DeepSeekAnthropicModelProvider(mergedConfig);
  throw new Error(`Unsupported model provider: ${provider}`);
}

function buildPrompt(inputEvent, context) {
  return [
    `输入类型：${inputEvent.type}`,
    `输入内容：${formatContent(inputEvent.content)}`,
    `相关记忆 ID：${(context.relatedMemories ?? []).map((memory) => memory.id).join(", ") || "无"}`,
    "请判断是否值得长期记忆，并给出摘要、标签、重要性和输出决策。"
  ].join("\n");
}

function normalizeAnalysis(candidate, fallback) {
  const parsed = AnalysisSchema.safeParse(candidate);
  const value = parsed.success ? parsed.data : fallback;
  return {
    provider: candidate.provider,
    summary: value.summary,
    tags: value.tags,
    remembered: value.remembered,
    importance: value.importance,
    confidence: value.confidence,
    outputDecision: {
      shouldOutput: value.shouldOutput ?? fallback.outputDecision.shouldOutput,
      type: value.outputType ?? fallback.outputDecision.type,
      reason: "model_decision"
    }
  };
}

function fallbackWithReason(id, fallback, reason) {
  return {
    ...fallback,
    provider: `${id}:fallback`,
    fallbackReason: reason
  };
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function formatContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}
