import { PLUGIN_STATUSES } from "../shared/types.ts";

export function registerConfiguredPlugins(repository, plugins) {
  for (const plugin of plugins) {
    repository.upsertPlugin(plugin, plugin.enabled ? PLUGIN_STATUSES.ENABLED : PLUGIN_STATUSES.DISABLED);
  }
}
