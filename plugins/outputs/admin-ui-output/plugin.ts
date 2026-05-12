import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertBearerToken, describeAuthRequirement } from "../../../packages/shared/http-auth.ts";
import { APPROVAL_STATUSES, PLUGIN_STATUSES, SCHEDULE_STATUSES } from "../../../packages/shared/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const InputSchema = z.object({
  type: z.string().optional(),
  content: z.unknown()
});

const PluginToggleSchema = z.object({
  enabled: z.boolean()
});

const AgentSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1)
});

const ActiveAgentSchema = z.object({
  id: z.string().trim().min(1)
});

const ApprovalSchema = z.object({
  resolution: z.enum([APPROVAL_STATUSES.APPROVED, APPROVAL_STATUSES.REJECTED])
});

const ScheduleSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(["reminder", "input"]),
  text: z.string().min(1),
  runAt: z.string().min(1),
  intervalMs: z.number().int().positive().nullable().optional()
});

const MemoryEditSchema = z.object({
  summary: z.string().trim().min(1).optional(),
  content: z.string().trim().min(1).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.coerce.number().min(1).max(5).optional(),
  confidence: z.coerce.number().min(0).max(1).optional()
});

export default {
  id: "admin-ui-output",
  name: "Admin UI Output",
  direction: "output",
  type: "admin-ui",
  config: {
    enabled: true,
    host: "127.0.0.1",
    port: 8790
  },

  async init(runtime) {
    const options = this._mergedConfig ?? this.config;
    if (!options?.enabled) return null;

    const app = Fastify({ logger: false });
    const indexHtml = readFileSync(resolve(__dirname, "index.html"), "utf8");
    const token = options.token ?? process.env.NEURA_ADMIN_TOKEN ?? "";

    app.addHook("preHandler", async (request) => {
      if (request.url === "/" || request.url === "/api/config" || request.url === "/api/status") return;
      assertBearerToken(request, token, "Admin UI");
    });

    app.get("/", async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return indexHtml;
    });

    app.get("/api/status", async () => runtime.status());
    app.get("/api/agents", async () => ({
      activeAgent: runtime.repository.getActiveAgent(),
      agents: runtime.repository.listAgents()
    }));
    app.post("/api/agents", async (request) => {
      const body = AgentSchema.parse(request.body ?? {});
      return runtime.repository.createAgent({ id: body.id, name: body.name });
    });
    app.post("/api/agents/active", async (request) => {
      const body = ActiveAgentSchema.parse(request.body ?? {});
      return runtime.repository.setActiveAgent(body.id);
    });
    app.get("/api/config", async () => ({
      agent: runtime.config.agent,
      model: {
        provider: process.env.NEURA_MODEL_PROVIDER || runtime.config.model.provider,
        baseUrl: runtime.config.model.baseUrl,
        anthropicBaseUrl: runtime.config.model.anthropicBaseUrl,
        model: runtime.config.model.model,
        apiKeyEnv: runtime.config.model.apiKeyEnv,
        apiKeyConfigured:
          (process.env.NEURA_MODEL_PROVIDER || runtime.config.model.provider) === "mock"
            ? true
            : Boolean(process.env[runtime.config.model.apiKeyEnv])
      },
      runtime: runtime.config.runtime,
      policy: runtime.policy.describe()
    }));

    app.get("/api/plugins", async () => runtime.repository.listPlugins());
    app.post("/api/plugins/:id", async (request) => {
      const body = PluginToggleSchema.parse(request.body ?? {});
      await runtime.setPluginEnabled(request.params.id, body.enabled);
      return { ok: true, pluginId: request.params.id, enabled: body.enabled };
    });

    app.post("/api/input", async (request) => {
      const body = InputSchema.parse(request.body ?? {});
      const { event, result } = await runtime.input(body.content, {
        pluginId: "admin-ui-output",
        type: body.type ?? (typeof body.content === "string" ? "text" : "event"),
        metadata: { source: "admin-ui" }
      });
      return { event, result };
    });

    app.get("/api/memories", async (request) => {
      const query = request.query?.query;
      return query ? await runtime.repository.searchMemories(query) : runtime.repository.listMemories(50);
    });
    app.post("/api/memories/:id", async (request) => {
      const body = MemoryEditSchema.parse(request.body ?? {});
      const memory = runtime.repository.editMemory(request.params.id, body);
      if (!memory) {
        const error = new Error(`Memory not found: ${request.params.id}`);
        error.statusCode = 404;
        throw error;
      }
      return memory;
    });
    app.delete("/api/memories/:id", async (request) => {
      const deleted = runtime.repository.deleteMemory(request.params.id);
      if (!deleted) {
        const error = new Error(`Memory not found: ${request.params.id}`);
        error.statusCode = 404;
        throw error;
      }
      return { ok: true, deleted };
    });

    app.get("/api/inputs", async () => runtime.repository.listInputEvents(50));
    app.get("/api/tasks", async () => runtime.repository.listTasks(50));
    app.get("/api/outputs", async () => runtime.repository.listOutputEvents(50));
    app.get("/api/logs", async () => runtime.repository.recentLogs(50));
    app.get("/api/tools", async () => runtime.repository.listToolCalls(50));
    app.get("/api/approvals", async () => runtime.repository.listConfirmationRequests(null, 50));

    app.post("/api/approvals/:id", async (request) => {
      const body = ApprovalSchema.parse(request.body ?? {});
      const result = runtime.tools.resolveConfirmation(request.params.id, body.resolution);
      return { ok: true, result };
    });

    app.get("/api/schedules", async () => runtime.repository.listSchedules(null, 100));
    app.post("/api/schedules", async (request) => {
      const body = ScheduleSchema.parse(request.body ?? {});
      return runtime.repository.createSchedule({
        name: body.name,
        mode: body.mode,
        content: { text: body.text },
        runAt: body.runAt,
        intervalMs: body.intervalMs ?? null
      });
    });
    app.post("/api/schedules/:id/status", async (request) => {
      const body = z.object({ status: z.enum([SCHEDULE_STATUSES.ACTIVE, SCHEDULE_STATUSES.PAUSED, SCHEDULE_STATUSES.COMPLETED]) }).parse(request.body ?? {});
      runtime.repository.updateScheduleStatus(request.params.id, body.status);
      return { ok: true };
    });
    app.delete("/api/schedules/:id", async (request) => {
      runtime.repository.deleteSchedule(request.params.id);
      return { ok: true };
    });

    await app.listen({ host: options.host, port: options.port });
    runtime.repository.setPluginStatus(this.id, PLUGIN_STATUSES.RUNNING);
    runtime.repository.log("info", "admin-ui", "Admin UI started", {
      host: options.host,
      port: options.port,
      auth: describeAuthRequirement({ host: options.host, token })
    });

    return async () => {
      await app.close();
    };
  },

  async send() {
    // This plugin exposes management UI/API; it does not forward runtime output elsewhere.
  }
};
