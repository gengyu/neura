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

const memoryId = duplicateInput.match(/记忆 ID: (memory_[^\n]+)/)?.[1];
if (!memoryId) {
  throw new Error("Expected duplicate input to print memory id");
}
const tagUpdate = run(["memory", "tag", memoryId, "--add", "产品核心"]);
if (!tagUpdate.includes("产品核心")) {
  throw new Error("Expected memory tag command to update tags");
}
console.log("memory tag update: OK");

const memories = run(["memory", "search", "插件体系"]);
if (!memories.includes("插件") || !memories.includes("产品核心")) {
  throw new Error("Expected memory search to return plugin-related memory");
}
console.log("memory search: OK");

const reminder = run(["input", "提醒我 10分钟后 回看 Neura 核心链路"]);
if (!reminder.includes("任务类型: reminder") || !reminder.includes("定时任务:")) {
  throw new Error("Expected reminder input to create a schedule");
}
console.log("reminder schedule: OK");

const naturalReminder = run(["input", "提醒我 明天 9点 整理产品计划"]);
if (!naturalReminder.includes("任务类型: reminder") || !naturalReminder.includes("定时任务:")) {
  throw new Error("Expected natural language reminder to create a schedule");
}
console.log("natural reminder schedule: OK");

const article = [
  "帮我总结这段文章：",
  "Neura 的核心价值不是插件数量，而是把任意输入变成可沉淀、可检索、可行动的个人上下文。",
  "当用户丢进一个想法时，系统应该判断它是临时信息、长期记忆、提醒、当前内容整理，还是历史查询。",
  "如果是文章或材料，应该先总结当前内容，再决定是否写入知识片段。",
  "如果是历史问题，应该检索记忆并给出基于记录的答案。"
].join("\n");
const currentSummary = run(["input", article]);
if (!currentSummary.includes("任务类型: summarize_current") || !currentSummary.includes("summarize_current")) {
  throw new Error("Expected long summary request to summarize current input");
}
console.log("current summary: OK");

const reminderWordOnly = run(["input", "帮我总结：提醒这个词只是在文章里出现，不代表要创建提醒。这个系统应该理解语境，而不是看到关键词就行动。"]);
if (reminderWordOnly.includes("任务类型: reminder") || reminderWordOnly.includes("定时任务:")) {
  throw new Error("Expected reminder keyword without time to avoid schedule creation");
}
console.log("reminder context guard: OK");

const memoryQuery = run(["input", "之前有没有关于插件体系的记录？"]);
if (!memoryQuery.includes("任务类型: memory_query") || !memoryQuery.includes("search_memory") || !memoryQuery.includes("写入记忆: 否")) {
  throw new Error("Expected history query to search memory");
}
console.log("memory query decision: OK");

const records = run(["records", "list"]);
if (!records.includes("类型: memory_query") || !records.includes("决策:")) {
  throw new Error("Expected records inbox to show capture results");
}
console.log("records inbox: OK");

const filteredRecords = run(["records", "list", "--type", "summarize_current"]);
if (!filteredRecords.includes("类型: summarize_current")) {
  throw new Error("Expected records inbox to filter by task type");
}
console.log("records filter: OK");

const queriedRecords = run(["records", "list", "--query", "插件体系"]);
if (!queriedRecords.includes("插件体系")) {
  throw new Error("Expected records inbox to search by query text");
}
console.log("records query: OK");

const recordId = memoryQuery.match(/输入 ID: (input_[^\n]+)/)?.[1];
if (!recordId) {
  throw new Error("Expected input command to print input id");
}
const recordDetail = run(["records", "show", recordId]);
if (!recordDetail.includes("关键点:") || !recordDetail.includes("相关记忆:")) {
  throw new Error("Expected record detail to show structured capture details");
}
console.log("record detail: OK");

const archived = run(["records", "archive", recordId]);
if (!archived.includes("已归档")) {
  throw new Error("Expected record archive command to archive record");
}
const archivedList = run(["records", "list", "--archived"]);
if (!archivedList.includes(recordId) || !archivedList.includes("状态: 已归档")) {
  throw new Error("Expected archived record to appear in archived list");
}
const activeList = run(["records", "list"]);
if (activeList.includes(recordId)) {
  throw new Error("Expected archived record to be hidden from active list");
}
const unarchived = run(["records", "unarchive", recordId]);
if (!unarchived.includes("已取消归档")) {
  throw new Error("Expected record unarchive command to restore record");
}
console.log("record archive: OK");

console.log("Smoke test passed");
