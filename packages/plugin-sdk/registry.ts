export function registerConfiguredPlugins(repository, plugins) {
  for (const plugin of plugins) {
    repository.upsertPlugin(plugin, plugin.enabled ? "enabled" : "disabled");
  }
}
