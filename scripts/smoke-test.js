import { execFileSync } from "node:child_process";

function run(args) {
  return execFileSync(process.execPath, ["./bin/neura.js", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEURA_MODEL_PROVIDER: "rule-based"
    }
  });
}

const input = run(["input", "我想让 Neura 的插件体系保持极简，只分为输入插件和输出插件"]);
if (!input.includes("写入记忆: 是")) {
  throw new Error("Expected input to create a memory");
}

const duplicateInput = run(["input", "我想让 Neura 的插件体系保持极简，只分为输入插件和输出插件"]);
if (!duplicateInput.includes("记忆动作: 更新")) {
  throw new Error("Expected duplicate input to update an existing memory");
}

const memories = run(["memory", "search", "插件体系"]);
if (!memories.includes("插件")) {
  throw new Error("Expected memory search to return plugin-related memory");
}

const plugins = run(["plugins", "list"]);
if (!plugins.includes("cli-input") || !plugins.includes("cli-output")) {
  throw new Error("Expected default plugins to be registered");
}

const status = run(["status"]);
if (!status.includes("记忆:")) {
  throw new Error("Expected status summary");
}

console.log("Smoke test passed");
