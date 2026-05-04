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
    timeoutMs: 30000,
    fallbackProvider: "rule-based"
  },
  policy: {
    allowOutput: true,
    allowFileRead: true,
    allowFileWrite: true,
    allowNetwork: true,
    allowCommandExecution: false
  },
  plugins: [
    {
      id: "cli-input",
      name: "CLI Input",
      direction: "input",
      type: "cli",
      enabled: true,
      config: {}
    },
    {
      id: "webhook-input",
      name: "Webhook Input",
      direction: "input",
      type: "webhook",
      enabled: true,
      config: {
        path: "/input"
      }
    },
    {
      id: "folder-watch-input",
      name: "Folder Watch Input",
      direction: "input",
      type: "folder-watch",
      enabled: true,
      config: {
        path: "data/inbox"
      }
    },
    {
      id: "cli-output",
      name: "CLI Output",
      direction: "output",
      type: "cli",
      enabled: true,
      config: {}
    },
    {
      id: "local-log-output",
      name: "Local Log Output",
      direction: "output",
      type: "file",
      enabled: true,
      config: {
        path: "logs/neura.log"
      }
    }
  ]
};
