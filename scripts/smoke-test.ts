import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

const smokeDatabasePath = "data/neura-smoke-test.db";

if (existsSync(smokeDatabasePath)) {
  unlinkSync(smokeDatabasePath);
}

function run(args) {
  return execFileSync("bun", ["./bin/neura.ts", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEURA_MODEL_PROVIDER: process.env.NEURA_MODEL_PROVIDER || "mock",
      NEURA_DATABASE_PATH: process.env.NEURA_DATABASE_PATH || smokeDatabasePath
    }
  });
}

// Check that plugins load correctly (no model API key needed for listing)
const plugins = run(["plugins", "list"]);
if (!plugins.includes("cli-input") || !plugins.includes("cli-output")) {
  throw new Error("Expected default plugins to be registered");
}
console.log("plugin list: OK");

const status = run(["status"]);
if (!status.includes("连接状态:")) {
  throw new Error("Expected status summary");
}
console.log("status: OK");

const input = run(["input", "我想让 Neura 的插件体系保持极简，只分为输入插件和输出插件"]);
if (!input.includes("已处理输入")) {
  throw new Error("Expected input to be processed");
}
console.log("input: OK");

const duplicateInput = run(["input", "我想让 Neura 的插件体系保持极简，只分为输入插件和输出插件"]);
if (!duplicateInput.includes("记忆动作: 更新")) {
  throw new Error("Expected duplicate input to update an existing memory");
}
console.log("memory dedup: OK");

const memories = run(["memory", "search", "插件体系"]);
if (!memories.includes("插件")) {
  throw new Error("Expected memory search to return plugin-related memory");
}
console.log("memory search: OK");

console.log("Smoke test passed");
