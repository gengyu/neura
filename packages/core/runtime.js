import { resolve } from "node:path";
import config from "../../neura.config.js";
import { PermissionPolicy } from "../policy/policy.js";
import { registerConfiguredPlugins } from "../plugin-sdk/registry.js";
import { Repository } from "../storage/repository.js";
import { SQLiteStore } from "../storage/sqlite.js";
import { RUNTIME_STATUSES } from "../shared/types.js";
import { loadLocalEnv } from "../shared/env.js";
import { createModelProvider } from "../model/provider.js";
import { ToolRegistry } from "../tools/tools.js";
import { AgentLoop } from "./agent-loop.js";

export function createRuntime() {
  loadLocalEnv();
  const store = new SQLiteStore(resolve(config.storage.databasePath));
  store.initialize();
  const repository = new Repository(store);
  repository.ensureAgent(config.agent);
  registerConfiguredPlugins(repository, config.plugins);
  const policy = new PermissionPolicy(config.policy);
  const modelProvider = createModelProvider(config.model);
  const tools = new ToolRegistry({ repository, policy });
  const agentLoop = new AgentLoop({ repository, policy, modelProvider });

  return {
    config,
    repository,
    policy,
    tools,
    agentLoop,
    async input(content, options = {}) {
      const pluginId = options.pluginId ?? "cli-input";
      if (!repository.isPluginEnabled(pluginId)) {
        throw new Error(`Input plugin is disabled: ${pluginId}`);
      }
      const event = repository.createInputEvent({
        pluginId,
        type: options.type ?? "text",
        content,
        metadata: options.metadata ?? {}
      });
      return { event, result: await agentLoop.process(event) };
    },
    markRunning(pid = process.pid) {
      repository.setRuntimeState("runtime", {
        status: RUNTIME_STATUSES.RUNNING,
        pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      });
      if (repository.isPluginEnabled("cli-input")) repository.setPluginStatus("cli-input", "running");
      if (repository.isPluginEnabled("cli-output")) repository.setPluginStatus("cli-output", "running");
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
      for (const plugin of repository.listPlugins()) {
        repository.setPluginStatus(plugin.id, plugin.enabled ? "enabled" : "disabled");
      }
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
