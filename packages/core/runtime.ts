import { resolve } from "node:path";
import config from "../../neura.config.ts";
import { PermissionPolicy } from "../policy/policy.ts";
import { loadPlugins } from "../plugin-sdk/loader.ts";
import { Repository } from "../storage/repository.ts";
import { SQLiteStore } from "../storage/sqlite.ts";
import { AGENT_STATUSES, PLUGIN_STATUSES, RUNTIME_EVENT_TYPES, RUNTIME_STATUSES, SOURCE_TYPES, TASK_STATUSES } from "../shared/types.ts";
import { loadLocalEnv } from "../shared/env.ts";
import { createModelProvider } from "../model/provider.ts";
import { ToolRegistry } from "../tools/tools.ts";
import { AgentLoop } from "./agent-loop.ts";
import { OutputDispatcher } from "./output-dispatcher.ts";
import { synthesizeResult } from "./result-synthesizer.ts";
import { ScheduleManager } from "./schedule-manager.ts";
import { buildOutputDecision } from "./output-decision.ts";
import { buildOutputRoute } from "./output-routing.ts";

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
    repository.upsertPlugin({ ...plugin, enabled, config: mergedConfig }, enabled ? PLUGIN_STATUSES.ENABLED : PLUGIN_STATUSES.DISABLED);
    plugin._enabled = enabled;
    plugin._mergedConfig = mergedConfig;
  }
  repository.pruneMissingPlugins(loaded.map((plugin) => plugin.id));

  return loaded;
}

export async function createRuntime() {
  loadLocalEnv();
  const store = new SQLiteStore(resolve(config.storage.databasePath));
  store.initialize();
  const repository = new Repository(store);
  repository.ensureAgent(config.agent);
  if (!repository.getActiveAgent()) {
    repository.setActiveAgent(config.agent.id);
  }

  const loadedPlugins = await initializePlugins(repository, config.plugins);

  const policy = new PermissionPolicy(config.policy);
  let modelProvider = null;
  const getModelProvider = () => {
    if (!modelProvider) {
      modelProvider = createModelProvider(config.model);
    }
    return modelProvider;
  };
  const outputDispatcher = new OutputDispatcher({ repository, plugins: loadedPlugins });
  const tools = new ToolRegistry({ repository, policy, getModelProvider, outputDispatcher });
  const pluginCleanups = new Map();
  const pluginMap = new Map(loadedPlugins.map((plugin) => [plugin.id, plugin]));
  let runtime;
  const agentLoop = new AgentLoop({
    repository,
    policy,
    getModelProvider,
    tools
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
    pluginMap,
    pluginCleanups,

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

    async review(query = "", options = {}) {
      const limit = options.limit ?? 12;
      const memories = query
        ? repository.searchMemories(query, limit)
        : repository.listMemories(limit);
      return synthesizeResult({
        mode: "review",
        query,
        memories,
        modelProvider: getModelProvider()
      });
    },

    async initPlugins() {
      for (const plugin of loadedPlugins) {
        if (plugin._enabled) {
          try {
            await runtime.startPlugin(plugin.id);
          } catch {
            // Keep the runtime alive even if one plugin fails to initialize.
          }
        }
      }
      return async () => {
        for (const pluginId of [...pluginCleanups.keys()]) {
          await runtime.stopPlugin(pluginId);
        }
      };
    },

    async startPlugin(pluginId) {
      const plugin = pluginMap.get(pluginId);
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
      if (pluginCleanups.has(pluginId)) return false;
      if (typeof plugin.init !== "function") {
        repository.setPluginStatus(pluginId, PLUGIN_STATUSES.ENABLED);
        return true;
      }

      try {
        const cleanup = await plugin.init(runtime);
        if (typeof cleanup === "function") {
          pluginCleanups.set(pluginId, cleanup);
        }
        repository.setPluginStatus(pluginId, PLUGIN_STATUSES.RUNNING);
        return true;
      } catch (error) {
        repository.setPluginStatus(pluginId, PLUGIN_STATUSES.ERROR);
        repository.log("error", "runtime", `Failed to init plugin ${plugin.id}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },

    async stopPlugin(pluginId) {
      const cleanup = pluginCleanups.get(pluginId);
      if (!cleanup) return false;

      pluginCleanups.delete(pluginId);
      try {
        await cleanup();
        repository.setPluginStatus(pluginId, repository.isPluginEnabled(pluginId) ? PLUGIN_STATUSES.ENABLED : PLUGIN_STATUSES.DISABLED);
        return true;
      } catch (error) {
        repository.setPluginStatus(pluginId, PLUGIN_STATUSES.ERROR);
        repository.log("error", "runtime", `Failed to cleanup plugin ${pluginId}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },

    async reloadPlugin(pluginId) {
      await runtime.stopPlugin(pluginId);
      return runtime.startPlugin(pluginId);
    },

    async setPluginEnabled(pluginId, enabled) {
      repository.setPluginEnabled(pluginId, enabled);
      const plugin = pluginMap.get(pluginId);
      if (plugin) {
        plugin._enabled = enabled;
      }
      outputDispatcher.setPlugins(loadedPlugins);
      if (enabled) {
        return runtime.startPlugin(pluginId);
      }
      return runtime.stopPlugin(pluginId);
    },

    markRunning(pid = process.pid) {
      repository.setAgentStatus(repository.getActiveAgentId(), AGENT_STATUSES.RUNNING);
      repository.setRuntimeState("runtime", {
        status: RUNTIME_STATUSES.RUNNING,
        pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      });
      for (const plugin of repository.listPlugins()) {
        if (plugin.enabled) repository.setPluginStatus(plugin.id, PLUGIN_STATUSES.RUNNING);
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

    async emitOutput(source = {}, content = {}) {
      const sourceType = source.sourceType ?? SOURCE_TYPES.MANUAL;
      const sourceId = source.sourceId ?? null;
      const task = repository.createTask({
        sourceType,
        sourceId,
        type: source.eventType ?? source.type ?? RUNTIME_EVENT_TYPES.EMIT_OUTPUT
      });
      const decision = buildOutputDecision(source);
      if (!decision.shouldOutput || !policy.canSendOutput()) {
        repository.finishTask(task.id, TASK_STATUSES.COMPLETED, {
          outputDecision: decision,
          outputResults: []
        });
        return null;
      }
      const route = buildOutputRoute({
        outputEvent: {
          sourceType,
          sourceId,
          type: decision.outputType,
          priority: decision.priority
        },
        decision,
        repository
      });
      const results = await outputDispatcher.send({
        type: decision.outputType,
        sourceType,
        sourceId,
        content,
        preferredPluginIds: route.preferredPluginIds
      });
      repository.finishTask(task.id, TASK_STATUSES.COMPLETED, {
        outputDecision: decision,
        outputRoute: route,
        outputResults: results
      });
      return results;
    },

    async dispatchOutput(event) {
      return outputDispatcher.send(event);
    },

    markStopped(reason = AGENT_STATUSES.STOPPED) {
      const current = repository.getRuntimeState("runtime")?.value ?? {};
      repository.setAgentStatus(repository.getActiveAgentId(), AGENT_STATUSES.STOPPED);
      repository.setRuntimeState("runtime", {
        ...current,
        status: RUNTIME_STATUSES.STOPPED,
        pid: null,
        stoppedAt: new Date().toISOString(),
        reason
      });
      for (const plugin of repository.listPlugins()) {
        repository.setPluginStatus(plugin.id, plugin.enabled ? PLUGIN_STATUSES.ENABLED : PLUGIN_STATUSES.DISABLED);
      }
      repository.log("info", "runtime", "Runtime stopped", { reason });
    },

    status() {
      return {
        runtime: repository.getRuntimeState("runtime"),
        policy: policy.describe(),
        model: describeModelConfig(config.model),
        ...repository.statusSummary()
      };
    }
  };

  return runtime;
}

function describeModelConfig(modelConfig) {
  const provider = process.env.NEURA_MODEL_PROVIDER || modelConfig.provider;
  return {
    provider,
    model: modelConfig.model,
    apiKeyEnv: modelConfig.apiKeyEnv,
    apiKeyConfigured: provider === "mock" ? true : Boolean(process.env[modelConfig.apiKeyEnv])
  };
}
