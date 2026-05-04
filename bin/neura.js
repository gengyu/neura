#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../packages/core/runtime.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pidFile = resolve(root, "data/neura.pid");
const stopRequestFile = resolve(root, "data/neura.stop");
const daemonPath = resolve(root, "apps/daemon/daemon.js");

const program = new Command();

program
  .name("neura")
  .description("Neura personal agent runtime")
  .version("0.1.0");

program.command("start").description("启动 Neura Runtime").action(start);
program.command("stop").description("停止 Neura Runtime").action(stop);
program.command("restart").description("重启 Neura Runtime").action(() => {
  stop();
  start();
});
program.command("status").description("查看运行状态").action(status);
program.command("input").description("发送一条 CLI 输入").argument("<text...>", "输入内容").action(input);

const inputs = program.command("inputs").description("输入事件");
inputs.command("list").description("列出最近输入").action(listInputs);

const tasks = program.command("tasks").description("任务");
tasks.command("list").description("列出最近任务").action(listTasks);

const memory = program.command("memory").description("记忆");
memory.command("list").description("列出记忆").action(listMemories);
memory.command("search").description("搜索记忆").argument("<query...>", "搜索词").action(searchMemories);

const plugins = program.command("plugins").description("插件");
plugins.command("list").description("列出插件").action(listPlugins);
plugins.command("enable").description("启用插件").argument("<pluginId>", "插件 ID").action((pluginId) => setPluginEnabled(pluginId, true));
plugins.command("disable").description("禁用插件").argument("<pluginId>", "插件 ID").action((pluginId) => setPluginEnabled(pluginId, false));

const tools = program.command("tools").description("工具调用");
tools.command("list").description("列出工具调用").action(listTools);

program.command("config").description("查看配置").action(showConfig);
program.command("logs").description("查看最近日志").action(logs);

await program.parseAsync(process.argv);

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function isHeartbeatFresh(runtimeState) {
  if (runtimeState?.status !== "running" || !runtimeState.heartbeatAt) return false;
  return Date.now() - Date.parse(runtimeState.heartbeatAt) < 15000;
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function start() {
  const existingPid = readPid();
  const runtime = createRuntime();
  const runtimeState = runtime.status().runtime?.value;
  if (isProcessAlive(existingPid) || isHeartbeatFresh(runtimeState)) {
    console.log(`Neura 已在运行，PID: ${existingPid}`);
    return;
  }
  if (existsSync(stopRequestFile)) unlinkSync(stopRequestFile);

  const child = spawn(process.execPath, [daemonPath], {
    cwd: root,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log(`Neura 已启动，PID: ${child.pid}`);
}

function stop() {
  const pid = readPid();
  const runtime = createRuntime();
  const runtimeState = runtime.status().runtime?.value;

  if (!pid && !isHeartbeatFresh(runtimeState)) {
    runtime.markStopped("not_running");
    if (existsSync(pidFile)) unlinkSync(pidFile);
    if (existsSync(stopRequestFile)) unlinkSync(stopRequestFile);
    console.log("Neura 当前未运行");
    return;
  }

  writeFileSync(stopRequestFile, new Date().toISOString());
  let signalSent = false;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      signalSent = true;
    } catch {
      // In restricted environments the daemon will notice the stop request file.
    }
  }
  runtime.markStopped("stop_command");
  if (existsSync(pidFile)) unlinkSync(pidFile);
  if (signalSent && existsSync(stopRequestFile)) unlinkSync(stopRequestFile);
  console.log("Neura 已停止");
}

function status() {
  const runtime = createRuntime();
  const state = runtime.status();
  const runtimeState = state.runtime?.value ?? { status: "stopped" };
  const pid = readPid() ?? runtimeState.pid;
  const alive = isProcessAlive(pid) || isHeartbeatFresh(runtimeState);
  const connection =
    state.inputCount > 0 && state.outputCount > 0
      ? "有输入，有输出"
      : state.inputCount > 0
        ? "有输入，无输出"
        : state.outputCount > 0
          ? "无输入，有输出"
          : "无输入，无输出";

  console.log(`状态: ${alive ? "运行中" : "已停止"}`);
  if (alive && pid) console.log(`PID: ${pid}`);
  console.log(`连接状态: ${connection}`);
  console.log(`输入插件: ${state.inputCount}`);
  console.log(`输出插件: ${state.outputCount}`);
  console.log(`输入事件: ${state.counts.inputEvents}`);
  console.log(`任务: ${state.counts.tasks}`);
  console.log(`记忆: ${state.counts.memories}`);
  console.log(`输出事件: ${state.counts.outputEvents}`);
  console.log(`错误日志: ${state.counts.errors}`);
  if (runtimeState.heartbeatAt) console.log(`最近心跳: ${runtimeState.heartbeatAt}`);
}

async function input(textParts) {
  const text = textParts.join(" ").trim();
  const runtime = createRuntime();
  const { event, result } = await runtime.input(text, { metadata: { command: "neura input" } });

  console.log("已处理输入");
  console.log(`输入 ID: ${event.id}`);
  console.log(`摘要: ${result.summary}`);
  console.log(`标签: ${result.tags.join(", ")}`);
  console.log(`写入记忆: ${result.remembered ? "是" : "否"}`);
  console.log(`记忆动作: ${formatMemoryAction(result.memoryAction)}`);
  if (result.memoryId) console.log(`记忆 ID: ${result.memoryId}`);
}

function listInputs() {
  const inputs = createRuntime().repository.listInputEvents();
  if (inputs.length === 0) return console.log("还没有输入事件。");
  for (const event of inputs) {
    console.log(`${event.id}`);
    console.log(`  插件: ${event.pluginId}`);
    console.log(`  类型: ${event.type}`);
    console.log(`  状态: ${event.status}`);
    console.log(`  创建时间: ${event.createdAt}`);
  }
}

function listTasks() {
  const tasks = createRuntime().repository.listTasks();
  if (tasks.length === 0) return console.log("还没有任务。");
  for (const task of tasks) {
    console.log(`${task.id}`);
    console.log(`  输入: ${task.inputEventId}`);
    console.log(`  类型: ${task.type}`);
    console.log(`  状态: ${task.status}`);
    console.log(`  创建时间: ${task.createdAt}`);
    if (task.error) console.log(`  错误: ${task.error}`);
  }
}

function listMemories() {
  const memories = createRuntime().repository.listMemories();
  if (memories.length === 0) return console.log("还没有记忆。");
  for (const memory of memories) {
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${memory.tags.join(", ")}`);
    console.log(`  重要性: ${memory.importance}`);
    console.log(`  创建时间: ${memory.createdAt}`);
  }
}

function searchMemories(queryParts) {
  const memories = createRuntime().repository.searchMemories(queryParts.join(" ").trim());
  if (memories.length === 0) return console.log("没有找到相关记忆。");
  for (const memory of memories) {
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${memory.tags.join(", ")}`);
    console.log(`  内容: ${memory.content}`);
  }
}

function listPlugins() {
  const plugins = createRuntime().repository.listPlugins();
  for (const plugin of plugins) {
    console.log(`${plugin.id}`);
    console.log(`  名称: ${plugin.name}`);
    console.log(`  方向: ${plugin.direction}`);
    console.log(`  类型: ${plugin.type}`);
    console.log(`  状态: ${plugin.status}`);
    console.log(`  启用: ${plugin.enabled ? "是" : "否"}`);
  }
}

function setPluginEnabled(pluginId, enabled) {
  createRuntime().repository.setPluginEnabled(pluginId, enabled);
  console.log(`${pluginId} 已${enabled ? "启用" : "禁用"}`);
}

function logs() {
  const logs = createRuntime().repository.recentLogs();
  if (logs.length === 0) return console.log("还没有日志。");
  for (const log of logs) {
    console.log(`[${log.createdAt}] ${log.level}/${log.type} ${log.message}`);
  }
}

function listTools() {
  const calls = createRuntime().repository.listToolCalls();
  if (calls.length === 0) return console.log("还没有工具调用。");
  for (const call of calls) {
    console.log(`${call.id}`);
    console.log(`  工具: ${call.toolName}`);
    console.log(`  状态: ${call.status}`);
    console.log(`  风险: ${call.riskLevel}`);
    console.log(`  时间: ${call.createdAt}`);
  }
}

function showConfig() {
  const runtime = createRuntime();
  const model = runtime.config.model;
  console.log("模型:");
  console.log(`  provider: ${process.env.NEURA_MODEL_PROVIDER || model.provider}`);
  console.log(`  baseUrl: ${model.baseUrl}`);
  console.log(`  anthropicBaseUrl: ${model.anthropicBaseUrl}`);
  console.log(`  model: ${model.model}`);
  console.log(`  apiKeyEnv: ${model.apiKeyEnv}`);
  console.log(`  apiKey: ${process.env[model.apiKeyEnv] ? "已配置" : "未配置"}`);
  console.log("Webhook:");
  console.log(`  enabled: ${runtime.config.runtime.webhook.enabled}`);
  console.log(`  url: http://${runtime.config.runtime.webhook.host}:${runtime.config.runtime.webhook.port}/input`);
  console.log("文件夹监听:");
  console.log(`  enabled: ${runtime.config.runtime.folderWatch.enabled}`);
  console.log(`  path: ${runtime.config.runtime.folderWatch.path}`);
}

function formatMemoryAction(action) {
  if (action === "created") return "新增";
  if (action === "updated") return "更新";
  return "跳过";
}
