import chokidar from "chokidar";
import { mkdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { PLUGIN_STATUSES } from "../../../packages/shared/types.ts";

export default {
  id: "screenshot-watch-input",
  name: "Screenshot Watch Input",
  direction: "input",
  type: "screenshot-watch",

  init(runtime) {
    const options = runtime.config.runtime.screenshotWatch;
    if (!options?.enabled) return null;

    const watchPath = resolve(options.path);
    const extensions = new Set((options.extensions ?? [".png", ".jpg", ".jpeg", ".webp"]).map((item) => item.toLowerCase()));
    mkdirSync(watchPath, { recursive: true });

    const watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    watcher.on("add", async (filePath) => {
      const extension = extname(filePath).toLowerCase();
      const mimeType = imageMimeType(extension);
      if (!extensions.has(extension) || !mimeType) return;

      try {
        await runtime.input(
          {
            path: filePath,
            mimeType,
            source: "screenshot-watch"
          },
          {
            pluginId: "screenshot-watch-input",
            type: "image",
            metadata: { path: filePath, source: "screenshot-watch" }
          }
        );
      } catch (error) {
        runtime.repository.log("error", "screenshot-watch", "Screenshot input failed", {
          filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    watcher.on("error", (error) => {
      runtime.repository.setPluginStatus("screenshot-watch-input", PLUGIN_STATUSES.ERROR);
      runtime.repository.log("error", "screenshot-watch", "Screenshot watch failed", {
        path: watchPath,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    runtime.repository.setPluginStatus("screenshot-watch-input", PLUGIN_STATUSES.RUNNING);
    runtime.repository.log("info", "screenshot-watch", "Screenshot watch started", { path: watchPath });

    return async () => {
      await watcher.close();
    };
  }
};

function imageMimeType(extension) {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}
