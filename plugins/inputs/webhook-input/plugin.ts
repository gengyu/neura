import Fastify from "fastify";
import { z } from "zod";
import { assertBearerToken, describeAuthRequirement, redactHeaders } from "../../../packages/shared/http-auth.ts";
import { PLUGIN_STATUSES } from "../../../packages/shared/types.ts";

const WebhookPayloadSchema = z.object({
  type: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional(),
  imagePath: z.string().optional(),
  mimeType: z.string().optional()
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
    const token = options.token ?? process.env.NEURA_WEBHOOK_TOKEN ?? "";

    app.get("/health", async () => ({
      ok: true,
      runtime: runtime.status().runtime?.value ?? null
    }));

    async function handleInput(request) {
      assertBearerToken(request, token, "Webhook");
      const body = WebhookPayloadSchema.parse(request.body ?? {});
      const content = body.imagePath
        ? {
            path: body.imagePath,
            mimeType: body.mimeType ?? "image/png",
            text: body.text ?? null,
            source: "webhook"
          }
        : body.content ?? body.text ?? body;
      const type = body.type ?? (body.imagePath ? "image" : typeof content === "string" ? "text" : "event");
      const { event, result } = await runtime.input(content, {
        pluginId: "webhook-input",
        type,
        metadata: {
          remoteAddress: request.ip,
          headers: redactHeaders(request.headers)
        }
      });
      return { eventId: event.id, result };
    }

    app.post("/input", handleInput);
    app.post("/webhook", handleInput);

    await app.listen({ host: options.host, port: options.port });
    runtime.repository.setPluginStatus("webhook-input", PLUGIN_STATUSES.RUNNING);
    runtime.repository.log("info", "webhook", "Webhook input started", {
      host: options.host,
      port: options.port,
      auth: describeAuthRequirement({ host: options.host, token })
    });

    return async () => {
      await app.close();
    };
  }
};
