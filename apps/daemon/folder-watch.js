import chokidar from "chokidar";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

export function startFolderWatcher(runtime) {
  const options = runtime.config.runtime.folderWatch;
  if (!options?.enabled) return null;
  if (!runtime.repository.isPluginEnabled("folder-watch-input")) return null;

  const inboxPath = resolve(options.path);
  const extensions = new Set(options.extensions ?? [".txt", ".md", ".json"]);
  mkdirSync(inboxPath, { recursive: true });

  const watcher = chokidar.watch(inboxPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on("add", async (filePath) => {
    if (!extensions.has(extname(filePath))) return;
    try {
      const raw = readFileSync(filePath, "utf8");
      const content = extname(filePath) === ".json" ? safeJson(raw) : raw;
      await runtime.input(content, {
        pluginId: "folder-watch-input",
        type: "file",
        metadata: { path: filePath }
      });
    } catch (error) {
      runtime.repository.log("error", "folder-watch", "Folder input failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  watcher.on("error", (error) => {
    runtime.repository.setPluginStatus("folder-watch-input", "error");
    runtime.repository.log("error", "folder-watch", "Folder watch input failed", {
      path: inboxPath,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  runtime.repository.setPluginStatus("folder-watch-input", "running");
  runtime.repository.log("info", "folder-watch", "Folder watch input started", { path: inboxPath });
  return watcher;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
