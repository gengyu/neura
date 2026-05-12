import chokidar from "chokidar";
import { mkdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { buildFileInput } from "../../../packages/core/ingest-budget.ts";
import { PLUGIN_STATUSES } from "../../../packages/shared/types.ts";

export default {
  id: "folder-watch-input",
  name: "Folder Watch Input",
  direction: "input",
  type: "folder-watch",

  init(runtime) {
    const options = runtime.config.runtime.folderWatch;
    if (!options?.enabled) return null;

    const inboxPath = resolve(options.path);
    const extensions = new Set(
      options.extensions ?? [".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".pdf", ".png", ".jpg", ".jpeg", ".webp"]
    );
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
        const content = imageInput ?? buildFileInput(filePath, extension, runtime.config.runtime.ingest);
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
      runtime.repository.setPluginStatus("folder-watch-input", PLUGIN_STATUSES.ERROR);
      runtime.repository.log("error", "folder-watch", "Folder watch input failed", {
        path: inboxPath,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    runtime.repository.setPluginStatus("folder-watch-input", PLUGIN_STATUSES.RUNNING);
    runtime.repository.log("info", "folder-watch", "Folder watch input started", { path: inboxPath });

    return async () => {
      await watcher.close();
    };
  }
};

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
