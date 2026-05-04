import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export class ToolRegistry {
  constructor({ repository, policy }) {
    this.repository = repository;
    this.policy = policy;
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
      this.policy.assertFileWriteAllowed(resolve(path));
      writeFileSync(path, content);
      return { path, written: true };
    });
  }

  record(toolName, input, riskLevel, fn) {
    try {
      const output = fn();
      this.repository.createToolCall({ toolName, input, output, status: "completed", riskLevel });
      return output;
    } catch (error) {
      const output = { error: error instanceof Error ? error.message : String(error) };
      this.repository.createToolCall({ toolName, input, output, status: "failed", riskLevel });
      throw error;
    }
  }
}
