#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../packages/core/runtime.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pidFile = resolve(root, "data/neura.pid");
const stopRequestFile = resolve(root, "data/neura.stop");
const daemonPath = resolve(root, "apps/daemon/daemon.js");

const [, , command, ...args] = process.argv;

function printHelp() {
  console.log(`Neura

Usage:
  neura start
  neura stop
  neura restart
  neura status
  neura input <text>
  neura memory list
  neura memory search <query>
  neura plugins list
  neura logs
`);
}

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

function input() {
  const text = args.join(" ").trim();
  if (!text) {
    console.error("请输入要交给 Neura 的内容。");
    process.exitCode = 1;
    return;
  }

  const runtime = createRuntime();
  const { event, result } = runtime.input(text, { metadata: { command: "neura input" } });

  console.log("已处理输入");
  console.log(`输入 ID: ${event.id}`);
  console.log(`摘要: ${result.summary}`);
  console.log(`标签: ${result.tags.join(", ")}`);
  console.log(`写入记忆: ${result.remembered ? "是" : "否"}`);
  console.log(`记忆动作: ${formatMemoryAction(result.memoryAction)}`);
  if (result.memoryId) console.log(`记忆 ID: ${result.memoryId}`);
}

function listMemories() {
  const runtime = createRuntime();
  const memories = runtime.repository.listMemories();
  if (memories.length === 0) {
    console.log("还没有记忆。");
    return;
  }
  for (const memory of memories) {
    const tags = memory.tags.join(", ");
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${tags}`);
    console.log(`  重要性: ${memory.importance}`);
    console.log(`  创建时间: ${memory.createdAt}`);
  }
}

function searchMemories() {
  const query = args.slice(1).join(" ").trim();
  if (!query) {
    console.error("请输入搜索关键词。");
    process.exitCode = 1;
    return;
  }
  const runtime = createRuntime();
  const memories = runtime.repository.searchMemories(query);
  if (memories.length === 0) {
    console.log("没有找到相关记忆。");
    return;
  }
  for (const memory of memories) {
    const tags = memory.tags.join(", ");
    console.log(`${memory.id}`);
    console.log(`  摘要: ${memory.summary}`);
    console.log(`  标签: ${tags}`);
    console.log(`  内容: ${memory.content}`);
  }
}

function formatMemoryAction(action) {
  if (action === "created") return "新增";
  if (action === "updated") return "更新";
  return "跳过";
}

function listPlugins() {
  const runtime = createRuntime();
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

function logs() {
  const runtime = createRuntime();
  const logs = runtime.repository.recentLogs();
  if (logs.length === 0) {
    console.log("还没有日志。");
    return;
  }
  for (const log of logs) {
    console.log(`[${log.createdAt}] ${log.level}/${log.type} ${log.message}`);
  }
}

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    stop();
    start();
    break;
  case "status":
    status();
    break;
  case "input":
    input();
    break;
  case "memory":
    if (args[0] === "list") listMemories();
    else if (args[0] === "search") searchMemories();
    else printHelp();
    break;
  case "plugins":
    if (args[0] === "list") listPlugins();
    else printHelp();
    break;
  case "logs":
    logs();
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`未知命令: ${command}`);
    printHelp();
    process.exitCode = 1;
}
