import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const AnalysisSchema = z.object({
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(8),
  remembered: z.boolean(),
  importance: z.number().min(1).max(5),
  confidence: z.number().min(0).max(1),
  shouldOutput: z.boolean(),
  outputType: z.string().default("summary")
});

const ANALYSIS_TOOL_NAME = "record_neura_input_analysis";

const ANALYSIS_TOOL_OPENAI = {
  type: "function",
  function: {
    name: ANALYSIS_TOOL_NAME,
    description: "Record a structured Neura input analysis after you have gathered all necessary information.",
    parameters: z.toJSONSchema(AnalysisSchema)
  }
};

const ANALYSIS_TOOL_ANTHROPIC = {
  name: ANALYSIS_TOOL_NAME,
  description: "Record a structured Neura input analysis after you have gathered all necessary information.",
  input_schema: z.toJSONSchema(AnalysisSchema)
};

export class OpenAICompatibleModelProvider {
  constructor(options = {}) {
    this.id = options.id ?? options.provider ?? "openai-compatible";
    this.model = options.model ?? "deepseek-chat";
    this.apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "OPENAI_API_KEY"];
    if (!this.apiKey) {
      throw new Error(`Missing API key for OpenAI-compatible provider "${this.id}". Set ${options.apiKeyEnv ?? "OPENAI_API_KEY"} environment variable.`);
    }
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: trimTrailingSlash(options.baseUrl),
      timeout: options.timeoutMs ?? 30000
    });
  }

  async analyzeInput(inputEvent, context = {}, options = {}) {
    const executeTool = options.executeTool;
    const extraTools = (options.tools ?? []).map(toOpenAITool);

    if (!executeTool || extraTools.length === 0) {
      return this._singleShot(inputEvent, context);
    }

    const systemPrompt = [
      "你是 Neura 的 Agent Loop 分析器。",
      "你必须先调用 search_memory 获取相关记忆，再提交最终分析结果。",
      "除非输入是纯文件路径且需要读取内容，否则不要调用 read_file。",
      "如果 write_file、delete_file、execute_command 返回 confirmationRequired=true，说明动作已进入待确认队列。此时应把 shouldOutput 设为 true，并在摘要里明确告诉用户需要审批。",
      "shouldOutput 必须谨慎判断：只有用户主动请求结果、外部系统需要响应、任务完成需要告知、出现错误、需要确认、发现重要信息或提醒时才为 true。普通沉淀型输入可为 false。",
      "当你收集到足够信息后，必须调用 record_neura_input_analysis 工具来提交最终分析结果。"
    ].join("\n");
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildOpenAIUserContent(inputEvent, context) }
    ];
    const allTools = [...extraTools, ANALYSIS_TOOL_OPENAI];
    let searchedMemory = false;
    const relatedMemories = new Map();

    for (let i = 0; i < 5; i++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        messages,
        tools: allTools
      });

      const msg = response.choices[0]?.message;
      if (!msg) throw new Error("OpenAI-compatible provider returned empty response");

      messages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const args = JSON.parse(tc.function.arguments || "{}");
          if (tc.function.name === ANALYSIS_TOOL_NAME) {
            if (!searchedMemory) {
              throw new Error("Model submitted analysis before calling search_memory");
            }
            return normalizeAnalysis({ provider: this.id, ...args }, { relatedMemories: [...relatedMemories.values()] });
          }
          const result = await executeTool(tc.function.name, args);
          if (tc.function.name === "search_memory") {
            searchedMemory = true;
            collectRelatedMemories(relatedMemories, result);
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });
        }
        continue;
      }

      if (msg.content) {
        if (!searchedMemory) {
          throw new Error("Model returned text analysis before calling search_memory");
        }
        try {
          const parsed = AnalysisSchema.parse(JSON.parse(msg.content));
          return normalizeAnalysis({ provider: this.id, ...parsed }, { relatedMemories: [...relatedMemories.values()] });
        } catch {
          throw new Error("OpenAI-compatible provider returned unexpected response without tool calls");
        }
      }

      throw new Error("OpenAI-compatible provider returned empty message");
    }

    throw new Error("Model did not produce analysis after max iterations");
  }

  async _singleShot(inputEvent, context) {
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
          content: buildOpenAIUserContent(inputEvent, context)
        }
      ]
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) throw new Error("OpenAI-compatible provider returned empty analysis");
    return normalizeAnalysis({ provider: this.id, ...parsed });
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
    if (!this.apiKey) {
      throw new Error(`Missing API key for Anthropic-compatible provider "${this.id}". Set ${options.apiKeyEnv ?? "ANTHROPIC_API_KEY"} environment variable.`);
    }
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: trimTrailingSlash(options.baseUrl),
      timeout: options.timeoutMs ?? 30000
    });
  }

  async analyzeInput(inputEvent, context = {}, options = {}) {
    const executeTool = options.executeTool;
    const extraTools = (options.tools ?? []).map(toAnthropicTool);

    if (!executeTool || extraTools.length === 0) {
      return this._singleShot(inputEvent, context);
    }

    const systemPrompt = [
      "你是 Neura 的 Agent Loop 分析器。",
      "你必须先调用 search_memory 获取相关记忆，再提交最终分析结果。",
      "除非输入是纯文件路径且需要读取内容，否则不要调用 read_file。",
      "如果 write_file、delete_file、execute_command 返回 confirmationRequired=true，说明动作已进入待确认队列。此时应把 shouldOutput 设为 true，并在摘要里明确告诉用户需要审批。",
      "shouldOutput 必须谨慎判断：只有用户主动请求结果、外部系统需要响应、任务完成需要告知、出现错误、需要确认、发现重要信息或提醒时才为 true。普通沉淀型输入可为 false。",
      "当你收集到足够信息后，必须调用 record_neura_input_analysis 工具来提交最终分析结果。"
    ].join("\n");
    const messages = [
      { role: "user", content: buildAnthropicUserContent(inputEvent, context) }
    ];
    const allTools = [...extraTools, ANALYSIS_TOOL_ANTHROPIC];
    let searchedMemory = false;
    const relatedMemories = new Map();

    for (let i = 0; i < 5; i++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        temperature: 0.2,
        system: systemPrompt,
        tools: allTools,
        messages
      });

      const toolUses = response.content.filter((part) => part.type === "tool_use");

      if (toolUses.length > 0) {
        messages.push({ role: "assistant", content: response.content });

        const toolResults = [];
        for (const toolUse of toolUses) {
          if (toolUse.name === ANALYSIS_TOOL_NAME) {
            if (!searchedMemory) {
              throw new Error("Model submitted analysis before calling search_memory");
            }
            return normalizeAnalysis(
              { provider: this.id, ...AnalysisSchema.parse(toolUse.input) },
              { relatedMemories: [...relatedMemories.values()] }
            );
          }
          const result = await executeTool(toolUse.name, toolUse.input);
          if (toolUse.name === "search_memory") {
            searchedMemory = true;
            collectRelatedMemories(relatedMemories, result);
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
        }

        if (toolResults.length > 0) {
          messages.push({ role: "user", content: toolResults });
        }
        continue;
      }

      const textBlock = response.content.find((part) => part.type === "text");
      if (textBlock) {
        if (!searchedMemory) {
          throw new Error("Model returned text analysis before calling search_memory");
        }
        try {
          const parsed = AnalysisSchema.parse(JSON.parse(textBlock.text));
          return normalizeAnalysis({ provider: this.id, ...parsed }, { relatedMemories: [...relatedMemories.values()] });
        } catch {
          throw new Error("Anthropic-compatible provider returned unexpected text response");
        }
      }

      throw new Error("Anthropic-compatible provider returned empty response");
    }

    throw new Error("Model did not produce analysis after max iterations");
  }

  async _singleShot(inputEvent, context) {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 800,
      temperature: 0.2,
      system: "你是 Neura 的 Agent Loop 分析器。请调用工具返回结构化分析结果。",
      tools: [ANALYSIS_TOOL_ANTHROPIC],
      tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
      messages: [
        {
          role: "user",
          content: buildAnthropicUserContent(inputEvent, context)
        }
      ]
    });

    const toolUse = message.content.find((part) => part.type === "tool_use" && part.name === ANALYSIS_TOOL_NAME);
    if (!toolUse) throw new Error("Anthropic-compatible provider did not return expected tool use");
    return normalizeAnalysis({ provider: this.id, ...AnalysisSchema.parse(toolUse.input) });
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
  if (!provider) throw new Error("Model provider not configured. Set NEURA_MODEL_PROVIDER or configure model.provider in neura.config.js");
  const mergedConfig = { ...config, provider };
  if (provider === "deepseek") return new DeepSeekModelProvider(mergedConfig);
  if (provider === "openai-compatible") return new OpenAICompatibleModelProvider(mergedConfig);
  if (provider === "anthropic-compatible") return new AnthropicCompatibleModelProvider(mergedConfig);
  if (provider === "deepseek-anthropic") return new DeepSeekAnthropicModelProvider(mergedConfig);
  throw new Error(`Unsupported model provider: ${provider}`);
}

function toOpenAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  };
}

function buildPrompt(inputEvent, context) {
  return [
    `输入类型：${inputEvent.type}`,
    `输入内容：${formatContent(inputEvent.content)}`,
    `已有上下文提示：${formatExistingContext(context)}`,
    "请先使用 search_memory 搜索与输入最相关的记忆。搜索查询应来自输入主题、实体、项目名、关键决策或用户意图。",
    "请判断是否值得长期记忆，并给出摘要、标签、重要性和输出决策。",
    "输出决策规则：普通记录/收藏/上下文沉淀通常 shouldOutput=false；用户明确询问、命令执行结果、错误、确认请求、重要提醒或外部同步响应才 shouldOutput=true。"
  ].join("\n");
}

function buildOpenAIUserContent(inputEvent, context) {
  const prompt = buildPrompt(inputEvent, context);
  const image = getImageAttachment(inputEvent);
  if (!image) return prompt;
  return [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: {
        url: toDataUrl(image)
      }
    }
  ];
}

function buildAnthropicUserContent(inputEvent, context) {
  const prompt = buildPrompt(inputEvent, context);
  const image = getImageAttachment(inputEvent);
  if (!image) return prompt;
  return [
    { type: "text", text: prompt },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.base64
      }
    }
  ];
}

function normalizeAnalysis(candidate, extras = {}) {
  const parsed = AnalysisSchema.parse(candidate);
  return {
    provider: candidate.provider,
    summary: parsed.summary,
    tags: parsed.tags,
    remembered: parsed.remembered,
    importance: parsed.importance,
    confidence: parsed.confidence,
    outputDecision: {
      shouldOutput: parsed.shouldOutput,
      type: parsed.outputType ?? "summary",
      reason: "model_decision"
    },
    relatedMemories: dedupeMemories(extras.relatedMemories ?? [])
  };
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function formatContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function getImageAttachment(inputEvent) {
  if (inputEvent.type !== "image") return null;
  const path = inputEvent.content?.path ?? inputEvent.content?.imagePath ?? inputEvent.metadata?.path;
  if (!path) return null;
  const absolutePath = resolve(path);
  const base64 = readFileSync(absolutePath).toString("base64");
  return {
    path: absolutePath,
    mimeType: inputEvent.content?.mimeType ?? detectMimeType(absolutePath),
    base64
  };
}

function formatExistingContext(context = {}) {
  if (Array.isArray(context.relatedMemories) && context.relatedMemories.length > 0) {
    return context.relatedMemories.map((memory) => memory.id).join(", ");
  }
  return "无，需自行调用 search_memory 检索";
}

function collectRelatedMemories(target, result) {
  for (const memory of dedupeMemories(Array.isArray(result) ? result : [])) {
    target.set(memory.id, memory);
  }
}

function dedupeMemories(memories) {
  const unique = new Map();
  for (const memory of memories) {
    if (!memory || !memory.id) continue;
    unique.set(memory.id, memory);
  }
  return [...unique.values()];
}

function toDataUrl(image) {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function detectMimeType(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}
