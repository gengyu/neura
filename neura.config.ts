import { loadLocalEnv } from "./packages/shared/env.ts";

loadLocalEnv();

export default {
  agent: {
    id: process.env.NEURA_AGENT_ID || "default-agent",
    name: process.env.NEURA_AGENT_NAME || "Neura"
  },
  storage: {
    databasePath: process.env.NEURA_DATABASE_PATH || "data/neura.db"
  },
  runtime: {
    heartbeatIntervalMs: numberEnv("NEURA_HEARTBEAT_INTERVAL_MS", 5000),
    webhook: {
      enabled: boolEnv("NEURA_WEBHOOK_ENABLED", true),
      host: process.env.NEURA_WEBHOOK_HOST || "127.0.0.1",
      port: numberEnv("NEURA_WEBHOOK_PORT", 8787),
      token: process.env.NEURA_WEBHOOK_TOKEN || ""
    },
    folderWatch: {
      enabled: boolEnv("NEURA_FOLDER_WATCH_ENABLED", true),
      path: process.env.NEURA_INBOX_PATH || "data/inbox",
      extensions: [".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".pdf", ".png", ".jpg", ".jpeg", ".webp"]
    },
    screenshotWatch: {
      enabled: boolEnv("NEURA_SCREENSHOT_WATCH_ENABLED", true),
      path: process.env.NEURA_SCREENSHOT_PATH || "data/screenshots",
      extensions: [".png", ".jpg", ".jpeg", ".webp"]
    },
    adminUi: {
      enabled: boolEnv("NEURA_ADMIN_UI_ENABLED", true),
      host: process.env.NEURA_ADMIN_HOST || "127.0.0.1",
      port: numberEnv("NEURA_ADMIN_PORT", 8790),
      token: process.env.NEURA_ADMIN_TOKEN || ""
    },
    ingest: {
      maxModelInputChars: numberEnv("NEURA_MAX_MODEL_INPUT_CHARS", 24000),
      maxFileReadBytes: numberEnv("NEURA_MAX_FILE_READ_BYTES", 512000),
      previewHeadChars: numberEnv("NEURA_PREVIEW_HEAD_CHARS", 14000),
      previewTailChars: numberEnv("NEURA_PREVIEW_TAIL_CHARS", 6000),
      chunkChars: numberEnv("NEURA_INGEST_CHUNK_CHARS", 6000),
      maxChunks: numberEnv("NEURA_INGEST_MAX_CHUNKS", 12)
    }
  },
  model: {
    provider: process.env.NEURA_MODEL_PROVIDER || "deepseek",
    baseUrl: process.env.NEURA_MODEL_BASE_URL || "https://api.deepseek.com",
    anthropicBaseUrl: process.env.NEURA_MODEL_ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic",
    model: process.env.NEURA_MODEL || "deepseek-chat",
    apiKeyEnv: process.env.NEURA_MODEL_API_KEY_ENV || "DEEPSEEK_API_KEY",
    timeoutMs: numberEnv("NEURA_MODEL_TIMEOUT_MS", 30000)
  },
  policy: {
    allowOutput: boolEnv("NEURA_ALLOW_OUTPUT", true),
    allowFileRead: boolEnv("NEURA_ALLOW_FILE_READ", true),
    allowFileWrite: boolEnv("NEURA_ALLOW_FILE_WRITE", true),
    allowNetwork: boolEnv("NEURA_ALLOW_NETWORK", true),
    allowCommandExecution: boolEnv("NEURA_ALLOW_COMMAND_EXECUTION", false),
    requireConfirmation: boolEnv("NEURA_REQUIRE_CONFIRMATION", true)
  },
  // Plugins are auto-discovered from the plugins/ directory.
  // Use this array to override enabled status or config for specific plugins.
  plugins: [
    { id: "cli-input", enabled: true },
    { id: "webhook-input", enabled: true },
    { id: "folder-watch-input", enabled: true },
    { id: "screenshot-watch-input", enabled: true },
    { id: "cli-output", enabled: true },
    { id: "local-log-output", enabled: true },
    { id: "system-notification-output", enabled: true },
    {
      id: "admin-ui-output",
      enabled: true,
      config: {
        enabled: boolEnv("NEURA_ADMIN_UI_ENABLED", true),
        host: process.env.NEURA_ADMIN_HOST || "127.0.0.1",
        port: numberEnv("NEURA_ADMIN_PORT", 8790),
        token: process.env.NEURA_ADMIN_TOKEN || ""
      }
    }
  ]
};

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
