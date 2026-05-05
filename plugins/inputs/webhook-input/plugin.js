import Fastify from "fastify";
import { z } from "zod";

const WebhookPayloadSchema = z.object({
  type: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional()
}).passthrough();

export default {
  id: "webhook-input",
  name: "Webhook Input",
  direction: "input",
  type: "webhook",

  async init(runtime) {
    const options = runtime.config.runtime.webhook;
    if (!options?.enabled) return null;

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

    await app.listen({ host: options.host, port: options.port });
    runtime.repository.setPluginStatus("webhook-input", "running");
    runtime.repository.log("info", "webhook", "Webhook input started", { host: options.host, port: options.port });

    return async () => {
      await app.close();
    };
  }
};
