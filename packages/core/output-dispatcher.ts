import { OUTPUT_STATUSES, SOURCE_TYPES } from "../shared/types.ts";

export class OutputDispatcher {
  constructor({ repository, plugins }) {
    this.repository = repository;
    this.setPlugins(plugins);
  }

  setPlugins(plugins) {
    this.plugins = plugins.filter((plugin) => plugin.direction === "output" && plugin._enabled);
  }

  async send({ type, content, sourceType = SOURCE_TYPES.INTERNAL, sourceId = null, preferredPluginIds = null }) {
    const targets = preferredPluginIds
      ? this.plugins.filter((plugin) => preferredPluginIds.includes(plugin.id))
      : this.plugins;
    const selectedTargets = targets.length > 0 ? targets : this.plugins.filter((plugin) => plugin.type === "file");

    const results = [];
    for (const plugin of selectedTargets) {
      const event = this.repository.createOutputEvent({
        pluginId: plugin.id,
        sourceType,
        sourceId,
        type,
        content,
        status: OUTPUT_STATUSES.PENDING
      });

      try {
        if (typeof plugin.send === "function") {
          await plugin.send({ event, content, type, repository: this.repository });
        }
        this.repository.updateOutputEventStatus(event.id, OUTPUT_STATUSES.SENT, content);
        results.push({ pluginId: plugin.id, status: OUTPUT_STATUSES.SENT, eventId: event.id });
      } catch (error) {
        this.repository.updateOutputEventStatus(event.id, OUTPUT_STATUSES.FAILED, {
          ...content,
          error: error instanceof Error ? error.message : String(error)
        });
        this.repository.log("error", "output", `Output plugin ${plugin.id} failed`, {
          error: error instanceof Error ? error.message : String(error),
          outputEventId: event.id
        });
        results.push({
          pluginId: plugin.id,
          status: OUTPUT_STATUSES.FAILED,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  }
}
