import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export class ToolRegistry {
  constructor({ repository, policy, getModelProvider }) {
    this.repository = repository;
    this.policy = policy;
    this.getModelProvider = getModelProvider;
  }

  searchMemory(query) {
    return this.record("search_memory", { query }, "low", () => this.repository.searchMemories(query));
  }

  readFile(path) {
    return this.record("read_file", { path }, "medium", () => {
      this.policy.assertFileReadAllowed(resolve(path));
      return { path, content: readFileSync(path, "utf8") };
    });
  }

  writeFile(path, content) {
    return this.record("write_file", { path, contentLength: String(content).length }, "medium", () => {
      const absolutePath = resolve(path);
      this.policy.assertFileWriteAllowed(absolutePath);
      const exists = existsSync(absolutePath);
      const confirmation = this.maybeRequireConfirmation("write_file", {
        path: absolutePath,
        content,
        exists
      }, exists ? "覆盖已有文件需要用户确认" : "写入敏感路径需要用户确认", { exists, path: absolutePath });
      if (confirmation) return confirmation;
      writeFileSync(absolutePath, content);
      return { path: absolutePath, written: true, overwritten: exists };
    });
  }

  deleteFile(path) {
    return this.record("delete_file", { path }, "high", () => {
      const absolutePath = resolve(path);
      this.policy.assertFileWriteAllowed(absolutePath);
      const confirmation = this.maybeRequireConfirmation("delete_file", { path: absolutePath }, "删除文件需要用户确认");
      if (confirmation) return confirmation;
      unlinkSync(absolutePath);
      return { path: absolutePath, deleted: true };
    });
  }

  executeCommand(command, args = [], options = {}) {
    return this.record("execute_command", { command, args, cwd: options.cwd ?? process.cwd() }, "high", () => {
      this.policy.assertCommandExecutionAllowed(command);
      const confirmation = this.maybeRequireConfirmation(
        "execute_command",
        { command, args, cwd: options.cwd ?? process.cwd() },
        "执行 shell 命令需要用户确认"
      );
      if (confirmation) return confirmation;
      const output = execFileSync(command, args, {
        cwd: options.cwd ?? process.cwd(),
        encoding: "utf8"
      });
      return { command, args, cwd: options.cwd ?? process.cwd(), output };
    });
  }

  async callModel(prompt, systemMessage = "You are a helpful assistant. Respond concisely in the same language as the user.") {
    return this.record("call_model", { prompt, systemMessage }, "low", async () => {
      const modelProvider = this.getModelProvider?.();
      if (!modelProvider) throw new Error("Model provider not available for call_model tool");
      if (typeof modelProvider.callModel === "function") {
        return modelProvider.callModel(prompt, systemMessage);
      }
      if (modelProvider.client?.beta?.chat?.completions?.parse) {
        const completion = await modelProvider.client.chat.completions.create({
          model: modelProvider.model,
          temperature: 0.3,
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: prompt }
          ]
        });
        return { content: completion.choices[0]?.message?.content ?? "" };
      }
      if (modelProvider.client?.messages?.create) {
        const message = await modelProvider.client.messages.create({
          model: modelProvider.model,
          max_tokens: 800,
          temperature: 0.3,
          system: systemMessage,
          messages: [{ role: "user", content: prompt }]
        });
        const textBlock = message.content.find((part) => part.type === "text");
        return { content: textBlock?.text ?? "" };
      }
      throw new Error("No compatible model client available for call_model");
    });
  }

  async httpRequest(url, method = "GET", headers = {}, body = null) {
    return this.record("http_request", { url, method, headers, body }, "medium", async () => {
      this.policy.assertNetworkAllowed(url);
      const options = {
        method: method.toUpperCase(),
        headers: { "User-Agent": "Neura/0.1", ...headers }
      };
      if (body !== null && !["GET", "HEAD"].includes(options.method)) {
        options.body = typeof body === "string" ? body : JSON.stringify(body);
        if (!options.headers["Content-Type"] && !options.headers["content-type"]) {
          options.headers["Content-Type"] = "application/json";
        }
      }
      const response = await fetch(url, options);
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, headers: Object.fromEntries(response.headers), data };
    });
  }

  resolveConfirmation(requestId, resolution) {
    const request = this.repository.getConfirmationRequest(requestId);
    if (!request) {
      throw new Error(`Confirmation request not found: ${requestId}`);
    }
    if (request.status !== "pending") {
      return request;
    }
    const resolved = this.repository.resolveConfirmationRequest(requestId, resolution);
    if (resolution !== "approved") {
      this.repository.createToolCall({
        toolName: request.toolName,
        input: request.payload,
        output: { confirmationResolved: "rejected", requestId },
        status: "rejected",
        riskLevel: "high"
      });
      return resolved;
    }

    const payload = request.payload ?? {};
    if (request.toolName === "write_file") {
      writeFileSync(payload.path, payload.content);
      const result = { path: payload.path, written: true, overwritten: Boolean(payload.exists) };
      this.repository.createToolCall({
        toolName: request.toolName,
        input: payload,
        output: { confirmationResolved: "approved", requestId, result },
        status: "completed",
        riskLevel: "high"
      });
      return { ...resolved, result };
    }
    if (request.toolName === "delete_file") {
      unlinkSync(payload.path);
      const result = { path: payload.path, deleted: true };
      this.repository.createToolCall({
        toolName: request.toolName,
        input: payload,
        output: { confirmationResolved: "approved", requestId, result },
        status: "completed",
        riskLevel: "high"
      });
      return { ...resolved, result };
    }
    if (request.toolName === "execute_command") {
      const output = execFileSync(payload.command, payload.args ?? [], {
        cwd: payload.cwd ?? process.cwd(),
        encoding: "utf8"
      });
      const result = { command: payload.command, args: payload.args ?? [], cwd: payload.cwd ?? process.cwd(), output };
      this.repository.createToolCall({
        toolName: request.toolName,
        input: payload,
        output: { confirmationResolved: "approved", requestId, result },
        status: "completed",
        riskLevel: "high"
      });
      return { ...resolved, result };
    }
    return resolved;
  }

  async record(toolName, input, riskLevel, fn) {
    try {
      const output = await fn();
      const status = output?.confirmationRequired ? "pending_confirmation" : "completed";
      this.repository.createToolCall({ toolName, input, output, status, riskLevel });
      return output;
    } catch (error) {
      const output = { error: error instanceof Error ? error.message : String(error) };
      this.repository.createToolCall({ toolName, input, output, status: "failed", riskLevel });
      throw error;
    }
  }

  maybeRequireConfirmation(toolName, payload, reason, metadata = {}) {
    if (!this.policy.requiresConfirmation(toolName, metadata)) return null;
    const request = this.repository.createConfirmationRequest({ toolName, payload, reason });
    return {
      confirmationRequired: true,
      requestId: request.id,
      reason
    };
  }
}
