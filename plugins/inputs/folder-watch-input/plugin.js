import chokidar from "chokidar";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

export default {
  id: "folder-watch-input",
  name: "Folder Watch Input",
  direction: "input",
  type: "folder-watch",

  init(runtime) {
    const options = runtime.config.runtime.folderWatch;
    if (!options?.enabled) return null;

    const inboxPath = resolve(options.path);
    const extensions = new Set(options.extensions ?? [".txt", ".md", ".json", ".png", ".jpg", ".jpeg", ".webp"]);
    mkdirSync(inboxPath, { recursive: true });

    const watcher = chokidar.watch(inboxPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    watcher.on("add", async (filePath) => {
      const extension = extname(filePath).toLowerCase();
      if (!extensions.has(extension)) return;
      try {
        const imageInput = toImageInput(filePath, extension);
        const raw = imageInput ? null : readFileSync(filePath, "utf8");
        const content = imageInput ?? (extension === ".json" ? safeJson(raw) : raw);
        await runtime.input(content, {
          pluginId: "folder-watch-input",
          type: imageInput ? "image" : "file",
          metadata: { path: filePath, source: "folder-watch" }
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

    return async () => {
      await watcher.close();
    };
  }
};

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toImageInput(filePath, extension) {
  const mimeType = imageMimeType(extension);
  if (!mimeType) return null;
  return {
    path: filePath,
    mimeType,
    source: "folder-watch"
  };
}

function imageMimeType(extension) {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}
