import Fastify from "fastify";
import { z } from "zod";

const WebhookPayloadSchema = z.object({
  type: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional()
}).passthrough();

export async function startWebhookServer(runtime) {
  const options = runtime.config.runtime.webhook;
  if (!options?.enabled) return null;
  if (!runtime.repository.isPluginEnabled("webhook-input")) return null;

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    ok: true,
    runtime: runtime.status().runtime?.value ?? null
  }));

  async function handleInput(request) {
    const body = WebhookPayloadSchema.parse(request.body ?? {});
    const content = body.content ?? body.text ?? body;
    const type = body.type ?? (typeof content === "string" ? "text" : "event");
    const { event, result } = await runtime.input(content, {
      pluginId: "webhook-input",
      type,
      metadata: {
        remoteAddress: request.ip,
        headers: request.headers
      }
    });
    return { eventId: event.id, result };
  }

  app.post("/input", handleInput);
  app.post("/webhook", handleInput);

  try {
    await app.listen({ host: options.host, port: options.port });
    runtime.repository.setPluginStatus("webhook-input", "running");
    runtime.repository.log("info", "webhook", "Webhook input started", { host: options.host, port: options.port });
    return app;
  } catch (error) {
    runtime.repository.setPluginStatus("webhook-input", "error");
    runtime.repository.log("error", "webhook", "Webhook input failed", {
      host: options.host,
      port: options.port,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
