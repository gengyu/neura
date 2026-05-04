import { resolve } from "node:path";
import config from "../../neura.config.js";
import { PermissionPolicy } from "../policy/policy.js";
import { registerConfiguredPlugins } from "../plugin-sdk/registry.js";
import { Repository } from "../storage/repository.js";
import { SQLiteStore } from "../storage/sqlite.js";
import { RUNTIME_STATUSES } from "../shared/types.js";
import { createModelProvider } from "../model/provider.js";
import { AgentLoop } from "./agent-loop.js";

export function createRuntime() {
  const store = new SQLiteStore(resolve(config.storage.databasePath));
  store.initialize();
  const repository = new Repository(store);
  repository.ensureAgent(config.agent);
  registerConfiguredPlugins(repository, config.plugins);
  const policy = new PermissionPolicy(config.policy);
  const modelProvider = createModelProvider(config.model);
  const agentLoop = new AgentLoop({ repository, policy, modelProvider });

  return {
    config,
    repository,
    policy,
    agentLoop,
    input(content, options = {}) {
      const event = repository.createInputEvent({
        pluginId: options.pluginId ?? "cli-input",
        type: options.type ?? "text",
        content,
        metadata: options.metadata ?? {}
      });
      return { event, result: agentLoop.process(event) };
    },
    markRunning(pid = process.pid) {
      repository.setRuntimeState("runtime", {
        status: RUNTIME_STATUSES.RUNNING,
        pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      });
      repository.setPluginStatus("cli-input", "running");
      repository.setPluginStatus("cli-output", "running");
      repository.log("info", "runtime", "Runtime started", { pid });
    },
    heartbeat(pid = process.pid) {
      const current = repository.getRuntimeState("runtime")?.value ?? {};
      repository.setRuntimeState("runtime", {
        ...current,
        status: RUNTIME_STATUSES.RUNNING,
        pid,
        heartbeatAt: new Date().toISOString()
      });
    },
    markStopped(reason = "stopped") {
      const current = repository.getRuntimeState("runtime")?.value ?? {};
      repository.setRuntimeState("runtime", {
        ...current,
        status: RUNTIME_STATUSES.STOPPED,
        pid: null,
        stoppedAt: new Date().toISOString(),
        reason
      });
      repository.setPluginStatus("cli-input", "enabled");
      repository.setPluginStatus("cli-output", "enabled");
      repository.log("info", "runtime", "Runtime stopped", { reason });
    },
    status() {
      return {
        runtime: repository.getRuntimeState("runtime"),
        policy: policy.describe(),
        ...repository.statusSummary()
      };
    }
  };
}
