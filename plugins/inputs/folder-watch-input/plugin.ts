import chokidar from "chokidar";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
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
        const content = imageInput ?? toFileInput(filePath, extension);
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

function toFileInput(filePath, extension) {
  if (extension === ".pdf") {
    return {
      path: filePath,
      extension,
      kind: "binary-document",
      text: null,
      summaryHint: "PDF file detected from inbox"
    };
  }

  const raw = readFileSync(filePath, "utf8");
  return {
    path: filePath,
    extension,
    kind: detectTextKind(extension),
    text: extension === ".json" ? JSON.stringify(safeJson(raw), null, 2) : raw
  };
}

function imageMimeType(extension) {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}

function detectTextKind(extension) {
  if (extension === ".md") return "markdown";
  if (extension === ".json") return "json";
  if ([".js", ".ts", ".jsx", ".tsx"].includes(extension)) return "code";
  return "text";
}
