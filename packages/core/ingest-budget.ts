import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";

const DEFAULT_INGEST = {
  maxModelInputChars: 24_000,
  maxFileReadBytes: 512_000,
  previewHeadChars: 14_000,
  previewTailChars: 6_000,
  chunkChars: 6_000,
  maxChunks: 12
};

export function resolveIngestConfig(config = {}) {
  return {
    ...DEFAULT_INGEST,
    ...(config ?? {})
  };
}

export function prepareInputForIngest(content, { type = "text", ingest = {} } = {}) {
  const options = resolveIngestConfig(ingest);
  if (typeof content === "string") {
    return prepareTextContent(content, { type, options, sourceKind: "text" });
  }
  if (!content || typeof content !== "object") return content;
  if (content.ingest?.strategy) return content;

  if (type === "file" && typeof content.text === "string") {
    const prepared = prepareTextContent(content.text, { type, options, sourceKind: "file" });
    return {
      ...content,
      text: prepared.text ?? content.text,
      ingest: prepared.ingest
    };
  }
  if (type === "event" || type === "url") {
    const serialized = JSON.stringify(content, null, 2);
    if (serialized.length <= options.maxModelInputChars) return content;
    const prepared = prepareTextContent(serialized, { type, options, sourceKind: type });
    return {
      ...content,
      text: prepared.text,
      ingest: prepared.ingest
    };
  }
  return content;
}

export function buildFileInput(filePath, extension = extname(filePath).toLowerCase(), ingest = {}) {
  const options = resolveIngestConfig(ingest);
  const stat = statSync(filePath);
  const binaryKind = detectBinaryKind(extension);
  if (binaryKind) {
    return {
      path: filePath,
      extension,
      kind: binaryKind,
      text: null,
      summaryHint: `${extension || "binary"} file detected. Neura records metadata and avoids full parsing by default.`,
      ingest: {
        strategy: "metadata_only",
        originalBytes: stat.size,
        skippedReason: "binary_or_unsupported_document",
        warnings: ["未直接解析二进制/大型文档内容；如需深度总结，请先导出为文本或提供摘要。"]
      }
    };
  }

  const raw = readTextWithinBudget(filePath, options.maxFileReadBytes);
  const prepared = prepareTextContent(raw.text, {
    type: "file",
    options,
    sourceKind: "file",
    originalBytes: stat.size,
    readBytes: raw.readBytes,
    truncatedByBytes: raw.truncated
  });
  return {
    path: filePath,
    extension,
    kind: detectTextKind(extension),
    text: prepared.text,
    ingest: prepared.ingest
  };
}

export function formatContentForModel(content, maxChars = DEFAULT_INGEST.maxModelInputChars) {
  if (content && typeof content === "object" && content.ingest?.modelContent) {
    return content.ingest.modelContent;
  }
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return truncateWithNotice(text, maxChars);
}

function prepareTextContent(text, { type, options, sourceKind, originalBytes = null, readBytes = null, truncatedByBytes = false }) {
  const originalChars = text.length;
  const tooLarge = originalChars > options.maxModelInputChars || truncatedByBytes;
  if (!tooLarge) {
    return {
      text,
      ingest: {
        strategy: "full",
        sourceKind,
        originalChars,
        originalBytes,
        readBytes,
        truncated: false,
        chunks: []
      }
    };
  }

  const preview = buildPreview(text, options);
  const chunks = buildChunks(text, options);
  const warnings = [
    "输入超过单次模型预算，已使用前后片段预览和本地分块索引，避免一次性消耗大量 token。"
  ];
  if (truncatedByBytes) {
    warnings.push("文件超过读取预算，只读取了预算内内容；原文件未完整送入模型。");
  }

  return {
    text: preview,
    ingest: {
      strategy: type === "file" ? "file_preview_chunks" : "text_preview_chunks",
      sourceKind,
      originalChars,
      originalBytes,
      readBytes,
      truncated: true,
      chunkChars: options.chunkChars,
      chunkCount: Math.ceil(originalChars / options.chunkChars),
      indexedChunkCount: chunks.length,
      chunks,
      warnings,
      modelContent: [
        "[Neura ingest budget notice]",
        `strategy=${type === "file" ? "file_preview_chunks" : "text_preview_chunks"}`,
        `originalChars=${originalChars}`,
        originalBytes === null ? null : `originalBytes=${originalBytes}`,
        readBytes === null ? null : `readBytes=${readBytes}`,
        `indexedChunkCount=${chunks.length}`,
        "",
        preview
      ].filter(Boolean).join("\n")
    }
  };
}

function readTextWithinBudget(filePath, maxBytes) {
  const stat = statSync(filePath);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  let readBytes = 0;
  try {
    readBytes = readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    closeSync(fd);
  }
  return {
    text: buffer.subarray(0, readBytes).toString("utf8"),
    readBytes,
    truncated: stat.size > maxBytes
  };
}

function buildPreview(text, options) {
  const head = text.slice(0, options.previewHeadChars);
  const tail = text.slice(Math.max(options.previewHeadChars, text.length - options.previewTailChars));
  return [
    head,
    "",
    `[... omitted ${Math.max(0, text.length - head.length - tail.length)} chars by Neura ingest budget ...]`,
    "",
    tail
  ].join("\n");
}

function buildChunks(text, options) {
  const chunks = [];
  const total = Math.ceil(text.length / options.chunkChars);
  const max = Math.min(total, options.maxChunks);
  for (let index = 0; index < max; index += 1) {
    const start = index * options.chunkChars;
    const end = Math.min(text.length, start + options.chunkChars);
    chunks.push({
      index,
      start,
      end,
      text: text.slice(start, end)
    });
  }
  return chunks;
}

function truncateWithNotice(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... truncated by Neura model prompt budget: ${text.length - maxChars} chars omitted ...]`;
}

function detectBinaryKind(extension) {
  if (extension === ".pdf") return "binary-document";
  if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(extension)) return "office-document";
  return null;
}

function detectTextKind(extension) {
  if (extension === ".md") return "markdown";
  if (extension === ".json") return "json";
  if ([".js", ".ts", ".jsx", ".tsx"].includes(extension)) return "code";
  return "text";
}
