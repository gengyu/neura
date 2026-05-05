#!/usr/bin/env bun
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../packages/core/runtime.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pidFile = resolve(root, "data/neura.pid");
const stopRequestFile = resolve(root, "data/neura.stop");
const daemonPath = resolve(root, "apps/daemon/daemon.ts");

const program = new Command();

program
  .name("neura")
  .description("Neura personal agent runtime")
  .version("0.1.0");

program.command("start").description("启动 Neura Runtime").action(start);
program.command("stop").description("停止 Neura Runtime").action(stop);
program.command("restart").description("重启 Neura Runtime").action(async () => {
  await stop();
  start();
});
program.command("status").description("查看运行状态").action(status);
program.command("input").description("发送一条 CLI 输入").argument("<text...>", "输入内容").action(input);
program.command("input-image").description("发送一张图片输入").argument("<path>", "图片路径").argument("[note...]", "附加说明").action(inputImage);

const inputs = program.command("inputs").description("输入事件");
inputs.command("list").description("列出最近输入").action(listInputs);

const tasks = program.command("tasks").description("任务");
tasks.command("list").description("列出最近任务").action(listTasks);

const memory = program.command("memory").description("记忆");
memory.command("list").description("列出记忆").action(listMemories);
memory.command("search").description("搜索记忆").argument("<query...>", "搜索词").action(searchMemories);
memory.command("reindex").description("重建记忆向量索引").action(reindexMemories);

const agents = program.command("agents").description("Agent 管理");
agents.command("list").description("列出 Agent").action(listAgents);
agents.command("current").description("查看当前 Agent").action(currentAgent);
agents.command("create").description("创建 Agent").argument("<name...>", "Agent 名称").option("--id <id>", "Agent ID").action(createAgent);
agents.command("use").description("切换当前 Agent").argument("<agentId>", "Agent ID").action(useAgent);

const plugins = program.command("plugins").description("插件");
plugins.command("list").description("列出插件").action(listPlugins);
plugins.command("enable").description("启用插件").argument("<pluginId>", "插件 ID").action((pluginId) => setPluginEnabled(pluginId, true));
plugins.command("disable").description("禁用插件").argument("<pluginId>", "插件 ID").action((pluginId) => setPluginEnabled(pluginId, false));

const tools = program.command("tools").description("工具调用");
tools.command("list").description("列出工具调用").action(listTools);

const approvals = program.command("approvals").description("高风险动作审批");
approvals.command("list").description("列出审批请求").action(listApprovals);
approvals.command("approve").description("批准一个审批请求").argument("<requestId>", "审批请求 ID").action((requestId) => resolveApproval(requestId, "approved"));
approvals.command("reject").description("拒绝一个审批请求").argument("<requestId>", "审批请求 ID").action((requestId) => resolveApproval(requestId, "rejected"));

const schedules = program.command("schedules").description("定时任务");
schedules.command("list").description("列出定时任务").action(listSchedules);
schedules.command("add")
  .description("创建定时任务")
  .requiredOption("--mode <mode>", "reminder 或 input")
  .option("--name <name>", "任务名称")
  .option("--at <time>", "运行时间，支持 ISO 时间")
  .option("--in <duration>", "延迟时间，例如 10m、2h")
  .option("--every <duration>", "重复周期，例如 30m、1d")
  .argument("<text...>", "任务内容")
  .action(addSchedule);
schedules.command("pause").description("暂停定时任务").argument("<scheduleId>", "任务 ID").action((scheduleId) => updateScheduleStatus(scheduleId, "paused"));
schedules.command("resume").description("恢复定时任务").argument("<scheduleId>", "任务 ID").action((scheduleId) => updateScheduleStatus(scheduleId, "active"));
schedules.command("remove").description("删除定时任务").argument("<scheduleId>", "任务 ID").action(removeSchedule);

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
  if (isProcessAlive(existingPid)) {
    console.log(`Neura 已在运行，PID: ${existingPid}`);
    return;
  }
  if (existsSync(stopRequestFile)) unlinkSync(stopRequestFile);

  const child = spawn(process.execPath, [daemonPath], {
    env: process.env,
    cwd: root,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log(`Neura 已启动，PID: ${child.pid}`);
}

async function stop() {
  const pid = readPid();
  const runtime = await createRuntime();
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

async function status() {
  const runtime = await createRuntime();
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
  console.log(`当前 Agent: ${runtime.repository.getActiveAgentId()}`);
  if (alive && pid) console.log(`PID: ${pid}`);
  console.log(`连接状态: ${connection}`);
  console.log(`输入插件: ${state.inputCount}`);
  console.log(`输出插件: ${state.outputCount}`);
  console.log(`输入事件: ${state.counts.inputEvents}`);
  console.log(`任务: ${state.counts.tasks}`);
  console.log(`记忆: ${state.counts.memories}`);
  console.log(`输出事件: ${state.counts.outputEvents}`);
  console.log(`待审批: ${state.counts.pendingApprovals}`);
  console.log(`激活中的定时任务: ${state.counts.activeSchedules}`);
  console.log(`错误日志: ${state.counts.errors}`);
  if (runtimeState.heartbeatAt) console.log(`最近心跳: ${runtimeState.heartbeatAt}`);
}

async function input(textParts) {
  const text = textParts.join(" ").trim();
  const runtime = await createRuntime();
  const { event, result } = await runtime.input(text, { metadata: { command: "neura input" } });

  console.log("已处理输入");
  console.log(`输入 ID: ${event.id}`);
  console.log(`摘要: ${result.summary}`);
  console.log(`标签: ${result.tags.join(", ")}`);
  console.log(`写入记忆: ${result.remembered ? "是" : "否"}`);
  console.log(`记忆动作: ${formatMemoryAction(result.memoryAction)}`);
  if (result.memoryId) console.log(`记忆 ID: ${result.memoryId}`);
}

async function inputImage(path, noteParts = []) {
  const runtime = await createRuntime();
  const absolutePath = resolve(path);
  const { event, result } = await runtime.input(
    {
      path: absolutePath,
      mimeType: detectImageMimeType(absolutePath),
      note: noteParts.join(" ").trim() || null
    },
    {
      pluginId: "cli-input",
      type: "image",
      metadata: { command: "neura input-image", path: absolutePath }
    }
  );

  console.log("已处理图片输入");
  console.log(`输入 ID: ${event.id}`);
  console.log(`摘要: ${result.summary}`);
  console.log(`标签: ${result.tags.join(", ")}`);
  console.log(`写入记忆: ${result.remembered ? "是" : "否"}`);
}

async function listInputs() {
  const runtime = await createRuntime();
  const inputs = runtime.repository.listInputEvents();
  if (inputs.length === 0) return console.log("还没有输入事件。");
  for (const event of inputs) {
    console.log(`${event.id}`);
    console.log(`  插件: ${event.pluginId}`);
    console.log(`  类型: ${event.type}`);
    console.log(`  状态: ${event.status}`);
    console.log(`  创建时间: ${event.createdAt}`);
  }
}

async function listTasks() {
  const runtime = await createRuntime();
  const tasks = runtime.repository.listTasks();
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

async function listMemories() {
  const runtime = await createRuntime();
  const memories = runtime.repository.listMemories();
  if (memories.length === 0) return console.log("还没有记忆。");
  for (const memory of memories) {
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${memory.tags.join(", ")}`);
    console.log(`  重要性: ${memory.importance}`);
    console.log(`  创建时间: ${memory.createdAt}`);
  }
}

async function searchMemories(queryParts) {
  const runtime = await createRuntime();
  const memories = runtime.repository.searchMemories(queryParts.join(" ").trim());
  if (memories.length === 0) return console.log("没有找到相关记忆。");
  for (const memory of memories) {
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${memory.tags.join(", ")}`);
    console.log(`  内容: ${memory.content}`);
  }
}

async function reindexMemories() {
  const runtime = await createRuntime();
  const count = runtime.repository.reindexMemoryVectors();
  console.log(`已重建记忆向量索引: ${count}`);
}

async function listAgents() {
  const runtime = await createRuntime();
  const activeId = runtime.repository.getActiveAgentId();
  for (const agent of runtime.repository.listAgents()) {
    console.log(`${agent.id}${agent.id === activeId ? " *" : ""}`);
    console.log(`  名称: ${agent.name}`);
    console.log(`  状态: ${agent.status}`);
    console.log(`  创建时间: ${agent.createdAt}`);
  }
}

async function currentAgent() {
  const runtime = await createRuntime();
  const agent = runtime.repository.getActiveAgent();
  console.log(`${agent.id}`);
  console.log(`  名称: ${agent.name}`);
  console.log(`  状态: ${agent.status}`);
}

async function createAgent(nameParts, options) {
  const runtime = await createRuntime();
  const agent = runtime.repository.createAgent({
    id: options.id,
    name: nameParts.join(" ").trim()
  });
  console.log(`已创建 Agent: ${agent.id}`);
}

async function useAgent(agentId) {
  const runtime = await createRuntime();
  const agent = runtime.repository.setActiveAgent(agentId);
  console.log(`已切换 Agent: ${agent.id}`);
}

async function listPlugins() {
  const runtime = await createRuntime();
  const plugins = runtime.repository.listPlugins();
  for (const plugin of plugins) {
    console.log(`${plugin.id}`);
    console.log(`  名称: ${plugin.name}`);
    console.log(`  方向: ${plugin.direction}`);
    console.log(`  类型: ${plugin.type}`);
    console.log(`  状态: ${plugin.status}`);
    console.log(`  启用: ${plugin.enabled ? "是" : "否"}`);
  }
}

async function setPluginEnabled(pluginId, enabled) {
  const runtime = await createRuntime();
  await runtime.setPluginEnabled(pluginId, enabled);
  console.log(`${pluginId} 已${enabled ? "启用" : "禁用"}`);
}

async function logs() {
  const runtime = await createRuntime();
  const logs = runtime.repository.recentLogs();
  if (logs.length === 0) return console.log("还没有日志。");
  for (const log of logs) {
    console.log(`[${log.createdAt}] ${log.level}/${log.type} ${log.message}`);
  }
}

async function listTools() {
  const runtime = await createRuntime();
  const calls = runtime.repository.listToolCalls();
  if (calls.length === 0) return console.log("还没有工具调用。");
  for (const call of calls) {
    console.log(`${call.id}`);
    console.log(`  工具: ${call.toolName}`);
    console.log(`  状态: ${call.status}`);
    console.log(`  风险: ${call.riskLevel}`);
    console.log(`  时间: ${call.createdAt}`);
  }
}

async function listApprovals() {
  const runtime = await createRuntime();
  const approvals = runtime.repository.listConfirmationRequests();
  if (approvals.length === 0) return console.log("当前没有审批请求。");
  for (const request of approvals) {
    console.log(`${request.id}`);
    console.log(`  工具: ${request.toolName}`);
    console.log(`  状态: ${request.status}`);
    console.log(`  原因: ${request.reason}`);
    console.log(`  创建时间: ${request.createdAt}`);
  }
}

async function resolveApproval(requestId, resolution) {
  const runtime = await createRuntime();
  const resolved = runtime.tools.resolveConfirmation(requestId, resolution);
  console.log(`审批已${resolution === "approved" ? "批准" : "拒绝"}: ${requestId}`);
  if (resolved?.result?.output) console.log(resolved.result.output);
}

async function listSchedules() {
  const runtime = await createRuntime();
  const items = runtime.repository.listSchedules();
  if (items.length === 0) return console.log("当前没有定时任务。");
  for (const item of items) {
    console.log(`${item.id}`);
    console.log(`  名称: ${item.name}`);
    console.log(`  模式: ${item.mode}`);
    console.log(`  状态: ${item.status}`);
    console.log(`  下次执行: ${item.runAt}`);
    if (item.intervalMs) console.log(`  周期: ${formatDuration(item.intervalMs)}`);
  }
}

async function addSchedule(textParts, options) {
  const runtime = await createRuntime();
  const runAt = parseScheduleTime(options.at, options.in);
  const intervalMs = options.every ? parseDuration(options.every) : null;
  const mode = options.mode;
  if (!["reminder", "input"].includes(mode)) {
    throw new Error(`Unsupported schedule mode: ${mode}`);
  }
  const text = textParts.join(" ").trim();
  const schedule = runtime.repository.createSchedule({
    name: options.name ?? text.slice(0, 40),
    mode,
    content: { text },
    runAt,
    intervalMs
  });
  console.log(`已创建定时任务: ${schedule.id}`);
  console.log(`执行时间: ${schedule.runAt}`);
}

async function updateScheduleStatus(scheduleId, status) {
  const runtime = await createRuntime();
  runtime.repository.updateScheduleStatus(scheduleId, status);
  console.log(`定时任务已${status === "active" ? "恢复" : "暂停"}: ${scheduleId}`);
}

async function removeSchedule(scheduleId) {
  const runtime = await createRuntime();
  runtime.repository.deleteSchedule(scheduleId);
  console.log(`定时任务已删除: ${scheduleId}`);
}

async function showConfig() {
  const runtime = await createRuntime();
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

function detectImageMimeType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

function parseScheduleTime(at, delay) {
  if (at) return new Date(at).toISOString();
  if (delay) return new Date(Date.now() + parseDuration(delay)).toISOString();
  throw new Error("Please provide --at or --in for schedules add");
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Unsupported duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 3_600_000;
  return amount * 86_400_000;
}

function formatDuration(value) {
  if (value % 86_400_000 === 0) return `${value / 86_400_000}d`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
}
