import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const AnalysisSchema = z.object({
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(8),
  taskType: z.string().default("context_capture"),
  category: z.string().default("context_summary"),
  intent: z.string().default("capture_context"),
  remembered: z.boolean().default(false),
  memoryType: z.string().default("上下文总结"),
  memoryReason: z.string().default("contains_long_term_value"),
  memoryActionHint: z.enum(["create", "update", "create_or_update", "skip"]).default("create_or_update"),
  importance: z.coerce.number().min(1).max(5).default(3),
  confidence: z.coerce.number().min(0).max(1).default(0.7),
  shouldOutput: z.boolean().default(false),
  outputType: z.string().default("summary"),
  outputReason: z.string().default("model_decision"),
  outputPriority: z.enum(["low", "medium", "high"]).default("medium"),
  extractedFacts: z.array(z.string().min(1)).max(8).default([]),
  warnings: z.array(z.string().min(1)).max(6).default([])
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
    const logModelRequest = options.logModelRequest;

    if (!executeTool) {
      return this._singleShot(inputEvent, context, { logModelRequest });
    }

    const systemPrompt = [
      "你是 Neura 的 Agent Loop 分析器。",
      "目标不是简单摘要，而是根据输入场景形成稳定、可执行、可沉淀的结构化判断。",
      "请优先贴合 Neura 的核心使用场景：记录想法、总结当前文章/材料、查询已有记忆、创建提醒、接收 webhook 事件、监听截图、监听文件、在授权后调用外部动作。",
      "taskType 优先使用这些稳定值：context_capture、memory_capture、summarize_current、memory_query、query、reminder、action_request、event_capture、knowledge_ingest、visual_capture、decision_capture、preference_capture。",
      "如果用户让你总结/归纳/提炼当前输入中的长内容，taskType 应为 summarize_current，不要把它当成 memory_query。",
      "如果用户问以前、之前、历史、记忆里、记录里是否有某事，taskType 应为 memory_query。",
      "如果用户明确说记住、保存、加入记忆、记录下来，remembered 必须为 true。",
      "如果已有上下文提示里已经提供了相关记忆，可以直接使用；如果没有或明显不足，必须先调用 search_memory 获取相关记忆，再提交最终分析结果。",
      "除非输入是纯文件路径且需要读取内容，否则不要调用 read_file。",
      "你可以使用 call_model 对某段内容做子任务推理（如二次总结、翻译、分类），使用 http_request 从外部 API 获取实时信息。",
      "如果 write_file、delete_file、execute_command 返回 confirmationRequired=true，说明动作已进入待确认队列。此时应把 shouldOutput 设为 true，并在摘要里明确告诉用户需要审批。",
      "remembered 必须只在存在长期价值时为 true，例如用户想法、项目设定、产品决策、技术决策、偏好、知识片段、任务线索、上下文总结。",
      "shouldOutput 必须谨慎判断：只有用户主动请求结果、外部系统需要响应、任务完成需要告知、出现错误、需要确认、发现重要信息或提醒时才为 true。普通沉淀型输入可为 false。",
      "memoryActionHint 用于提示更合适的记忆动作：create、update、create_or_update、skip。",
      "extractedFacts 只保留少量高价值事实，不要重复 summary。",
      "当你收集到足够信息后，必须调用 record_neura_input_analysis 工具来提交最终分析结果。"
    ].join("\n");
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildOpenAIUserContent(inputEvent, context) }
    ];
    const allTools = [...extraTools, ANALYSIS_TOOL_OPENAI];
    let searchedMemory = hasRelatedMemories(context) || !hasTool(allTools, "search_memory");
    const relatedMemories = new Map();
    collectRelatedMemories(relatedMemories, context.relatedMemories ?? []);

    for (let i = 0; i < 5; i++) {
      const requestMetadata = buildModelRequestMetadata({
        provider: this.id,
        model: this.model,
        mode: "openai-compatible.tools",
        inputEventId: inputEvent.id,
        iteration: i + 1,
        messages,
        tools: allTools
      });
      emitModelRequestLog(logModelRequest, "info", "Model request started", requestMetadata);
      let response;
      try {
        const request: Record<string, unknown> = {
          model: this.model,
          temperature: 0.2,
          messages,
          tools: allTools
        };
        if (extraTools.length === 0) {
          request.tool_choice = { type: "function", function: { name: ANALYSIS_TOOL_NAME } };
        }
        response = await this.client.chat.completions.create(request);
      } catch (error) {
        emitModelRequestLog(logModelRequest, "error", "Model request failed", {
          ...requestMetadata,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      emitModelRequestLog(logModelRequest, "info", "Model request completed", {
        ...requestMetadata,
        responseId: response.id ?? null,
        responseModel: response.model ?? null,
        finishReason: response.choices?.[0]?.finish_reason ?? null,
        usage: normalizeOpenAIUsage(response.usage)
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

  async _singleShot(inputEvent, context, options = {}) {
    const messages = [
      {
        role: "system",
        content: "你是 Neura 的 Agent Loop 分析器。请把输入事件分析成结构化结果，只保留有长期价值的信息。"
      },
      {
        role: "user",
        content: buildOpenAIUserContent(inputEvent, context)
      }
    ];
    const requestMetadata = buildModelRequestMetadata({
      provider: this.id,
      model: this.model,
      mode: "openai-compatible.single-shot",
      inputEventId: inputEvent.id,
      iteration: 1,
      messages,
      tools: []
    });
    emitModelRequestLog(options.logModelRequest, "info", "Model request started", requestMetadata);
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        response_format: zodResponseFormat(AnalysisSchema, "neura_input_analysis"),
        messages
      });
    } catch (error) {
      emitModelRequestLog(options.logModelRequest, "error", "Model request failed", {
        ...requestMetadata,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    emitModelRequestLog(options.logModelRequest, "info", "Model request completed", {
      ...requestMetadata,
      responseId: completion.id ?? null,
      responseModel: completion.model ?? null,
      finishReason: completion.choices?.[0]?.finish_reason ?? null,
      usage: normalizeOpenAIUsage(completion.usage)
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI-compatible provider returned empty analysis");
    const parsed = AnalysisSchema.parse(JSON.parse(content));
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
    const logModelRequest = options.logModelRequest;

    if (!executeTool) {
      return this._singleShot(inputEvent, context, { logModelRequest });
    }

    const systemPrompt = [
      "你是 Neura 的 Agent Loop 分析器。",
      "目标不是简单摘要，而是根据输入场景形成稳定、可执行、可沉淀的结构化判断。",
      "请优先贴合 Neura 的核心使用场景：记录想法、总结当前文章/材料、查询已有记忆、创建提醒、接收 webhook 事件、监听截图、监听文件、在授权后调用外部动作。",
      "taskType 优先使用这些稳定值：context_capture、memory_capture、summarize_current、memory_query、query、reminder、action_request、event_capture、knowledge_ingest、visual_capture、decision_capture、preference_capture。",
      "如果用户让你总结/归纳/提炼当前输入中的长内容，taskType 应为 summarize_current，不要把它当成 memory_query。",
      "如果用户问以前、之前、历史、记忆里、记录里是否有某事，taskType 应为 memory_query。",
      "如果用户明确说记住、保存、加入记忆、记录下来，remembered 必须为 true。",
      "如果已有上下文提示里已经提供了相关记忆，可以直接使用；如果没有或明显不足，必须先调用 search_memory 获取相关记忆，再提交最终分析结果。",
      "除非输入是纯文件路径且需要读取内容，否则不要调用 read_file。",
      "你可以使用 call_model 对某段内容做子任务推理（如二次总结、翻译、分类），使用 http_request 从外部 API 获取实时信息。",
      "如果 write_file、delete_file、execute_command 返回 confirmationRequired=true，说明动作已进入待确认队列。此时应把 shouldOutput 设为 true，并在摘要里明确告诉用户需要审批。",
      "remembered 必须只在存在长期价值时为 true，例如用户想法、项目设定、产品决策、技术决策、偏好、知识片段、任务线索、上下文总结。",
      "shouldOutput 必须谨慎判断：只有用户主动请求结果、外部系统需要响应、任务完成需要告知、出现错误、需要确认、发现重要信息或提醒时才为 true。普通沉淀型输入可为 false。",
      "memoryActionHint 用于提示更合适的记忆动作：create、update、create_or_update、skip。",
      "extractedFacts 只保留少量高价值事实，不要重复 summary。",
      "当你收集到足够信息后，必须调用 record_neura_input_analysis 工具来提交最终分析结果。"
    ].join("\n");
    const messages = [
      { role: "user", content: buildAnthropicUserContent(inputEvent, context) }
    ];
    const allTools = [...extraTools, ANALYSIS_TOOL_ANTHROPIC];
    let searchedMemory = hasRelatedMemories(context) || !hasTool(allTools, "search_memory");
    const relatedMemories = new Map();
    collectRelatedMemories(relatedMemories, context.relatedMemories ?? []);

    for (let i = 0; i < 5; i++) {
      const requestMetadata = buildModelRequestMetadata({
        provider: this.id,
        model: this.model,
        mode: "anthropic-compatible.tools",
        inputEventId: inputEvent.id,
        iteration: i + 1,
        messages,
        tools: allTools,
        system: systemPrompt
      });
      emitModelRequestLog(logModelRequest, "info", "Model request started", requestMetadata);
      let response;
      try {
        const request: Record<string, unknown> = {
          model: this.model,
          max_tokens: 1024,
          temperature: 0.2,
          system: systemPrompt,
          tools: allTools,
          messages
        };
        if (extraTools.length === 0) {
          request.tool_choice = { type: "tool", name: ANALYSIS_TOOL_NAME };
        }
        response = await this.client.messages.create(request);
      } catch (error) {
        emitModelRequestLog(logModelRequest, "error", "Model request failed", {
          ...requestMetadata,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      emitModelRequestLog(logModelRequest, "info", "Model request completed", {
        ...requestMetadata,
        responseId: response.id ?? null,
        responseModel: response.model ?? null,
        stopReason: response.stop_reason ?? null,
        usage: normalizeAnthropicUsage(response.usage)
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

  async _singleShot(inputEvent, context, options = {}) {
    const messages = [
      {
        role: "user",
        content: buildAnthropicUserContent(inputEvent, context)
      }
    ];
    const system = "你是 Neura 的 Agent Loop 分析器。请调用工具返回结构化分析结果。";
    const tools = [ANALYSIS_TOOL_ANTHROPIC];
    const requestMetadata = buildModelRequestMetadata({
      provider: this.id,
      model: this.model,
      mode: "anthropic-compatible.single-shot",
      inputEventId: inputEvent.id,
      iteration: 1,
      messages,
      tools,
      system
    });
    emitModelRequestLog(options.logModelRequest, "info", "Model request started", requestMetadata);
    let message;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        temperature: 0.2,
        system,
        tools,
        tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
        messages
      });
    } catch (error) {
      emitModelRequestLog(options.logModelRequest, "error", "Model request failed", {
        ...requestMetadata,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    emitModelRequestLog(options.logModelRequest, "info", "Model request completed", {
      ...requestMetadata,
      responseId: message.id ?? null,
      responseModel: message.model ?? null,
      stopReason: message.stop_reason ?? null,
      usage: normalizeAnthropicUsage(message.usage)
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
  if (!provider) throw new Error("Model provider not configured. Set NEURA_MODEL_PROVIDER or configure model.provider in neura.config.ts");
  const mergedConfig = { ...config, provider };
  if (provider === "mock") return new MockModelProvider(mergedConfig);
  if (provider === "deepseek") return new DeepSeekModelProvider(mergedConfig);
  if (provider === "openai-compatible") return new OpenAICompatibleModelProvider(mergedConfig);
  if (provider === "anthropic-compatible") return new AnthropicCompatibleModelProvider(mergedConfig);
  if (provider === "deepseek-anthropic") return new DeepSeekAnthropicModelProvider(mergedConfig);
  throw new Error(`Unsupported model provider: ${provider}`);
}

export class MockModelProvider {
  constructor(options = {}) {
    this.id = options.id ?? options.provider ?? "mock";
    this.model = options.model ?? "mock-neura-analyzer";
    this.client = null;
  }

  async analyzeInput(inputEvent, context = {}) {
    const contentText = normalizeMockInput(inputEvent.content);
    const relatedMemories = context.relatedMemories ?? [];
    const tags = buildMockTags(contentText, inputEvent.type);
    const remembered = contentText.trim().length > 0;
    const shouldOutput = inputEvent.pluginId === "cli-input" || inputEvent.pluginId === "admin-ui-output";

    return normalizeAnalysis(
      {
        provider: this.id,
        summary: buildMockSummary(contentText, inputEvent.type),
        tags,
        taskType: inferMockTaskType(contentText, inputEvent),
        category: inferMockCategory(contentText, inputEvent),
        intent: inferMockIntent(contentText, inputEvent),
        remembered,
        memoryType: inferMockMemoryType(contentText, inputEvent),
        memoryReason: remembered ? "mock_detected_long_term_value" : "mock_transient_input",
        memoryActionHint: remembered ? "create_or_update" : "skip",
        importance: scoreImportance(contentText),
        confidence: 0.98,
        shouldOutput,
        outputType: inputEvent.type === "image" ? "image_summary" : "summary",
        outputReason: shouldOutput ? "mock_user_visible_input" : "mock_capture_only",
        outputPriority: shouldOutput ? "high" : "low",
        extractedFacts: buildMockFacts(contentText),
        warnings: []
      },
      { relatedMemories }
    );
  }

  async callModel(prompt) {
    return { content: `Mock model response: ${String(prompt).slice(0, 160)}` };
  }
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
    "请按以下稳定规则分析输入，返回结构化结果。",
    "如果 search_memory 工具可用且已有上下文提示为空或不足，请搜索与输入最相关的记忆。搜索查询应来自输入主题、实体、项目名、关键决策或用户意图。",
    "请判断 taskType，并给出摘要、标签、分类(category)、意图(intent)、记忆类型(memoryType)、记忆理由(memoryReason)、重要性和输出决策。",
    "taskType 稳定值：context_capture、memory_capture、summarize_current、memory_query、query、reminder、action_request、event_capture、knowledge_ingest、visual_capture、decision_capture、preference_capture。",
    "总结当前长内容使用 summarize_current；查询历史记录使用 memory_query；明确要求记住/保存时 remembered=true。",
    "输出决策规则：普通记录/收藏/上下文沉淀通常 shouldOutput=false；用户明确询问、命令执行结果、错误、确认请求、重要提醒或外部同步响应才 shouldOutput=true。",
    "",
    "以下是本次动态输入：",
    `输入类型：${inputEvent.type}`,
    `输入标准化画像：${formatNormalizedInput(context.normalizedInput)}`,
    `已有上下文提示：${formatExistingContext(context)}`,
    `输入内容：${formatContent(inputEvent.content)}`
  ].join("\n");
}

function emitModelRequestLog(logger, level, message, metadata) {
  if (typeof logger !== "function") return;
  try {
    logger(level, message, metadata);
  } catch {
    // Model execution must not fail because logging failed.
  }
}

function buildModelRequestMetadata({ provider, model, mode, inputEventId, iteration, messages, tools, system = "" }) {
  const serializedMessages = safeJsonLength(messages);
  const serializedTools = safeJsonLength(tools);
  return {
    provider,
    model,
    mode,
    inputEventId,
    iteration,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    toolNames: summarizeToolNames(tools),
    relatedMemoryCount: countRelatedMemoryMentions(messages),
    hasImageInput: hasMessagePartType(messages, "image_url") || hasMessagePartType(messages, "image"),
    systemChars: String(system ?? "").length,
    messagesChars: serializedMessages,
    toolsChars: serializedTools,
    approximateRequestChars: serializedMessages + serializedTools + String(system ?? "").length
  };
}

function normalizeOpenAIUsage(usage = null) {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null
  };
}

function normalizeAnthropicUsage(usage = null) {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null
  };
}

function safeJsonLength(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}

function summarizeToolNames(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool.function?.name ?? tool.name).filter(Boolean);
}

function hasTool(tools = [], name) {
  return summarizeToolNames(tools).includes(name);
}

function countRelatedMemoryMentions(messages = []) {
  const text = JSON.stringify(messages ?? []);
  return (text.match(/memory_[a-z0-9_]+/g) ?? []).length;
}

function hasMessagePartType(messages = [], type) {
  return JSON.stringify(messages ?? []).includes(`"type":"${type}"`);
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
    taskType: parsed.taskType,
    category: parsed.category,
    intent: parsed.intent,
    remembered: parsed.remembered,
    memoryDecision: {
      shouldRemember: parsed.remembered,
      memoryType: parsed.memoryType,
      reason: parsed.memoryReason,
      actionHint: parsed.memoryActionHint
    },
    importance: parsed.importance,
    confidence: parsed.confidence,
    outputDecision: {
      shouldOutput: parsed.shouldOutput,
      type: parsed.outputType ?? "summary",
      reason: parsed.outputReason ?? "model_decision",
      priority: parsed.outputPriority ?? "medium"
    },
    extractedFacts: parsed.extractedFacts ?? [],
    warnings: parsed.warnings ?? [],
    relatedMemories: dedupeMemories(extras.relatedMemories ?? [])
  };
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function normalizeMockInput(content) {
  if (typeof content === "string") return content;
  if (content?.note || content?.text) return [content.note, content.text].filter(Boolean).join(" ").trim();
  if (content?.path) return `file:${content.path}`;
  return JSON.stringify(content, null, 2);
}

function buildMockSummary(contentText, inputType) {
  const trimmed = contentText.trim();
  if (!trimmed) return "空输入，未生成有效摘要。";
  if (inputType === "image") return `已分析图片输入：${trimmed.slice(0, 80)}`;
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}...`;
}

function buildMockTags(contentText, inputType) {
  const tags = new Set(["mock"]);
  if (inputType) tags.add(inputType);
  if (/[A-Za-z]/.test(contentText)) tags.add("english");
  if (/[\u4e00-\u9fff]/.test(contentText)) tags.add("中文");
  if (/插件|plugin/i.test(contentText)) tags.add("插件");
  if (/记忆|memory/i.test(contentText)) tags.add("记忆");
  if (/智能体|agent/i.test(contentText)) tags.add("智能体");
  return [...tags].slice(0, 8);
}

function buildMockFacts(contentText) {
  return contentText
    .split(/[\n。！？!?]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function scoreImportance(contentText) {
  if (contentText.length > 200) return 4;
  if (contentText.length > 60) return 3;
  return 2;
}

function inferMockCategory(contentText, inputEvent) {
  if (/偏好|喜欢|不要/.test(contentText)) return "preference";
  if (/设计|方案|架构|prd|需求/.test(contentText)) return "product_decision";
  if (inputEvent.type === "file") return "knowledge_snippet";
  if (inputEvent.pluginId === "webhook-input") return "external_event";
  return "context_summary";
}

function inferMockTaskType(contentText, inputEvent) {
  if (/总结|归纳|提炼|概括|摘要/.test(contentText) && contentText.length > 180) return "summarize_current";
  if (/提醒|稍后|待办/.test(contentText)) return "reminder";
  if (/历史|以前|之前|上次|过去|记忆里|记录里|查找|搜索|找一下|有没有/.test(contentText)) return "memory_query";
  if (/记住|保存|加入记忆|记录下来|帮我记/.test(contentText)) return "memory_capture";
  if (/[?？]/.test(contentText)) return "query";
  if (/帮我|请|整理|总结|分析|生成/.test(contentText)) return "action_request";
  if (inputEvent.pluginId === "webhook-input") return "event_capture";
  if (inputEvent.type === "file") return "knowledge_ingest";
  if (inputEvent.type === "image") return "visual_capture";
  if (/设计|方案|架构|需求|prd/.test(contentText)) return "decision_capture";
  return "context_capture";
}

function inferMockIntent(contentText, inputEvent) {
  if (/总结|归纳|提炼|概括|摘要/.test(contentText) && contentText.length > 180) return "summarize_current_input";
  if (/历史|以前|之前|上次|过去|记忆里|记录里|查找|搜索|找一下|有没有/.test(contentText)) return "lookup_memory";
  if (/记住|保存|加入记忆|记录下来|帮我记/.test(contentText)) return "remember_context";
  if (/[?？]/.test(contentText)) return "answer_request";
  if (/帮我|请|整理|总结|分析/.test(contentText)) return "action_request";
  if (inputEvent.pluginId === "webhook-input") return "capture_event";
  return "capture_context";
}

function inferMockMemoryType(contentText, inputEvent) {
  if (/偏好|喜欢|不要/.test(contentText)) return "偏好";
  if (/设计|方案|架构|需求|prd/.test(contentText)) return "产品决策";
  if (inputEvent.type === "file") return "知识片段";
  return "上下文总结";
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
    return context.relatedMemories.map((memory) => `${memory.id}: ${memory.summary}`).join("\n");
  }
  return "无，需自行调用 search_memory 检索";
}

function formatNormalizedInput(normalizedInput) {
  if (!normalizedInput) return "无";
  return JSON.stringify({
    sourceKind: normalizedInput.sourceKind,
    scenario: normalizedInput.scenario,
    title: normalizedInput.title,
    keywords: normalizedInput.keywords,
    signals: normalizedInput.signals,
    file: normalizedInput.file,
    image: normalizedInput.image,
    summaryHint: normalizedInput.summaryHint
  }, null, 2);
}

function hasRelatedMemories(context = {}) {
  return Array.isArray(context.relatedMemories) && context.relatedMemories.length > 0;
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
