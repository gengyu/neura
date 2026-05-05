import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "../../packages/core/runtime.ts";

const runtime = await createRuntime();
const stopRequestPath = resolve("data/neura.stop");

await runtime.markRunning(process.pid);
const stopPlugins = await runtime.initPlugins();

const interval = setInterval(async () => {
  try {
    if (existsSync(stopRequestPath)) {
      unlinkSync(stopRequestPath);
      shutdown("stop_request");
      return;
    }
    runtime.heartbeat(process.pid);
    await runtime.processDueSchedules(new Date());
  } catch (error) {
    runtime.repository.log("error", "runtime", "Heartbeat loop failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}, runtime.config.runtime.heartbeatIntervalMs);

async function shutdown(signal) {
  clearInterval(interval);
  await stopPlugins();
  runtime.markStopped(signal);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  runtime.repository.log("error", "runtime", "Uncaught exception", { error: error.message });
  shutdown("uncaughtException");
});

process.stdin.resume();
