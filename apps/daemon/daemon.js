import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "../../packages/core/runtime.js";

const runtime = createRuntime();
const stopRequestPath = resolve("data/neura.stop");
runtime.markRunning(process.pid);

const interval = setInterval(() => {
  if (existsSync(stopRequestPath)) {
    unlinkSync(stopRequestPath);
    shutdown("stop_request");
    return;
  }
  runtime.heartbeat(process.pid);
}, runtime.config.runtime.heartbeatIntervalMs);

function shutdown(signal) {
  clearInterval(interval);
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
