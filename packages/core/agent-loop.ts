import { INPUT_STATUSES, TASK_STATUSES } from "../shared/types.ts";
import { normalizeToText } from "../memory/memory.ts";

const AVAILABLE_TOOLS = [
  {
    name: "search_memory",
    description: "搜索 Neura 记忆库，查找与查询相关的历史记忆，用于获取上下文",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词或短语" }
      },
      required: ["query"]
    }
  },
  {
    name: "read_file",
    description: "读取本地文件内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "写入本地文件内容。覆盖已有文件属于高风险动作，可能需要用户确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" },
        content: { type: "string", description: "要写入的内容" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "delete_file",
    description: "删除本地文件。高风险动作，必须由用户确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件的绝对路径" }
      },
      required: ["path"]
    }
  },
  {
    name: "execute_command",
    description: "执行本地命令。高风险动作，必须由用户确认。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "命令参数列表"
        },
        cwd: { type: "string", description: "命令执行目录，可选" }
      },
      required: ["command"]
    }
  },
  {
    name: "call_model",
    description: "调用 AI 模型对子任务进行独立推理。当你需要对某段内容做二次总结、翻译、分类或深入分析时使用。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "发送给模型的提示词" },
        systemMessage: { type: "string", description: "系统消息，可选。用于设定模型角色或回复风格" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "http_request",
    description: "发送 HTTP 请求到外部 API。用于获取实时信息、调用外部服务或触发 Webhook。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "请求 URL" },
        method: { type: "string", description: "HTTP 方法，默认 GET" },
        headers: { type: "object", description: "请求头，可选" },
        body: { type: "string", description: "请求体，可选。仅 POST/PUT/PATCH 有效" }
      },
      required: ["url"]
    }
  }
];

export class AgentLoop {
  constructor({ repository, policy, getModelProvider, tools, outputDispatcher }) {
    this.repository = repository;
    this.policy = policy;
    this.getModelProvider = getModelProvider;
    this.tools = tools;
    this.outputDispatcher = outputDispatcher;
  }

  async process(inputEvent) {
    const task = this.repository.createTask(inputEvent.id, "agent_loop");
    this.repository.updateInputEventStatus(inputEvent.id, INPUT_STATUSES.PROCESSING);
    this.repository.log("info", "input", "Input event accepted", { inputEventId: inputEvent.id, type: inputEvent.type });

    try {
      const modelProvider = this.getModelProvider();
      const contextMemories = this.repository.searchMemories(normalizeToText(inputEvent.content), 5);
      const executeTool = this.tools
        ? async (name, input) => {
            if (name === "search_memory") return this.tools.searchMemory(input.query);
            if (name === "read_file") return this.tools.readFile(input.path);
            if (name === "write_file") return this.tools.writeFile(input.path, input.content);
            if (name === "delete_file") return this.tools.deleteFile(input.path);
            if (name === "execute_command") return this.tools.executeCommand(input.command, input.args, { cwd: input.cwd });
            if (name === "call_model") return this.tools.callModel(input.prompt, input.systemMessage);
            if (name === "http_request") return this.tools.httpRequest(input.url, input.method, input.headers ?? {}, input.body ?? null);
            throw new Error(`Unknown tool: ${name}`);
          }
        : undefined;

      const analysis = await modelProvider.analyzeInput(
        inputEvent,
        { relatedMemories: contextMemories },
        { tools: this.tools ? AVAILABLE_TOOLS : [], executeTool }
      );

      const { summary, tags, remembered } = analysis;
      const relatedMemories = analysis.relatedMemories ?? [];

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
        summary,
        tags,
        remembered,
        memoryAction,
        memoryId: memory?.id ?? null,
        shouldOutput: analysis.outputDecision.shouldOutput,
        outputType: analysis.outputDecision.type,
        relatedMemoryIds: [...new Set(relatedMemories.map((item) => item.id))]
      };

      if (analysis.outputDecision.shouldOutput && this.policy.canSendOutput()) {
        if (this.outputDispatcher) {
          await this.outputDispatcher({
            type: analysis.outputDecision.type,
            content: result
          });
        } else {
          this.repository.createOutputEvent({
            pluginId: "cli-output",
            type: analysis.outputDecision.type,
            content: result
          });
        }
        this.repository.log("info", "output", "Output event created", { inputEventId: inputEvent.id });
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
