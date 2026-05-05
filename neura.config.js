export default {
  agent: {
    id: "default-agent",
    name: "Neura"
  },
  storage: {
    databasePath: "data/neura.db"
  },
  runtime: {
    heartbeatIntervalMs: 5000,
    webhook: {
      enabled: true,
      host: "127.0.0.1",
      port: 8787
    },
    folderWatch: {
      enabled: true,
      path: "data/inbox",
      extensions: [".txt", ".md", ".json"]
    }
  },
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    timeoutMs: 30000
  },
  policy: {
    allowOutput: true,
    allowFileRead: true,
    allowFileWrite: true,
    allowNetwork: true,
    allowCommandExecution: false
  },
  // Plugins are auto-discovered from the plugins/ directory.
  // Use this array to override enabled status or config for specific plugins.
  plugins: [
    { id: "cli-input", enabled: true },
    { id: "webhook-input", enabled: true },
    { id: "folder-watch-input", enabled: true },
    { id: "cli-output", enabled: true },
    { id: "local-log-output", enabled: true }
  ]
};
