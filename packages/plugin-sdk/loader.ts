import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url).pathname;

export async function loadPlugins() {
  const plugins = [];

  for (const direction of ["inputs", "outputs"]) {
    const dir = resolve(root, "plugins", direction);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = resolvePluginPath(dir, entry.name);
      if (!pluginPath) continue;
      try {
        const mod = await import(pathToFileURL(pluginPath).href);
        const plugin = mod.default;
        if (plugin && plugin.id && plugin.direction) {
          plugins.push(plugin);
        }
      } catch (error) {
        console.error(`Failed to load plugin from ${pluginPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return plugins;
}

function resolvePluginPath(dir, name) {
  for (const filename of ["plugin.ts", "plugin.js"]) {
    const pluginPath = resolve(dir, name, filename);
    if (existsSync(pluginPath)) return pluginPath;
  }
  return null;
}
