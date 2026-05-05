import { resolve } from "node:path";
import config from "../../neura.config.js";
import { PermissionPolicy } from "../policy/policy.js";
import { loadPlugins } from "../plugin-sdk/loader.js";
import { Repository } from "../storage/repository.js";
import { SQLiteStore } from "../storage/sqlite.js";
import { RUNTIME_STATUSES } from "../shared/types.js";
import { loadLocalEnv } from "../shared/env.js";
import { createModelProvider } from "../model/provider.js";
import { ToolRegistry } from "../tools/tools.js";
import { AgentLoop } from "./agent-loop.js";
import { OutputDispatcher } from "./output-dispatcher.js";
import { ScheduleManager } from "./schedule-manager.js";

async function initializePlugins(repository, configPlugins) {
  const loaded = await loadPlugins();
  const overrideMap = new Map();
  if (Array.isArray(configPlugins)) {
    for (const override of configPlugins) {
      overrideMap.set(override.id, override);
    }
  }

  for (const plugin of loaded) {
    const override = overrideMap.get(plugin.id);
    const enabled = override?.enabled ?? true;
    const mergedConfig = { ...plugin.config, ...override?.config };
    repository.upsertPlugin({ ...plugin, enabled, config: mergedConfig }, enabled ? "enabled" : "disabled");
    plugin._enabled = enabled;
    plugin._mergedConfig = mergedConfig;
  }

  return loaded;
}

export async function createRuntime() {
  loadLocalEnv();
  const store = new SQLiteStore(resolve(config.storage.databasePath));
  store.initialize();
  const repository = new Repository(store);
  repository.ensureAgent(config.agent);

  const loadedPlugins = await initializePlugins(repository, config.plugins);

  const policy = new PermissionPolicy(config.policy);
  const modelProvider = createModelProvider(config.model);
  const tools = new ToolRegistry({ repository, policy });
  const outputDispatcher = new OutputDispatcher({ repository, plugins: loadedPlugins });
  let runtime;
  const agentLoop = new AgentLoop({
    repository,
    policy,
    modelProvider,
    tools,
    outputDispatcher: (event) => outputDispatcher.send(event)
  });
  const scheduleManager = new ScheduleManager({
    repository,
    outputDispatcher,
    runtime: {
      input: (...args) => runtime.input(...args)
    }
  });

  runtime = {
    config,
    repository,
    policy,
    tools,
    agentLoop,
    outputDispatcher,
    scheduleManager,
    loadedPlugins,

    async input(content, options = {}) {
      const pluginId = options.pluginId ?? "cli-input";
      if (!options.internal && !repository.isPluginEnabled(pluginId)) {
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

    async initPlugins() {
      const cleanupFns = [];
      for (const plugin of loadedPlugins) {
        if (plugin._enabled && typeof plugin.init === "function") {
          try {
            const cleanup = await plugin.init(runtime);
            if (typeof cleanup === "function") {
              cleanupFns.push(cleanup);
            }
          } catch (error) {
            repository.setPluginStatus(plugin.id, "error");
            repository.log("error", "runtime", `Failed to init plugin ${plugin.id}`, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      return cleanupFns;
    },

    markRunning(pid = process.pid) {
      repository.setRuntimeState("runtime", {
        status: RUNTIME_STATUSES.RUNNING,
        pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      });
      for (const plugin of repository.listPlugins()) {
        if (plugin.enabled) repository.setPluginStatus(plugin.id, "running");
      }
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

    async processDueSchedules(now = new Date()) {
      return scheduleManager.processDueSchedules(now);
    },

    async dispatchOutput(event) {
      return outputDispatcher.send(event);
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

  return runtime;
}
