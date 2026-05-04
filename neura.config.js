export default {
  agent: {
    id: "default-agent",
    name: "Neura"
  },
  storage: {
    databasePath: "data/neura.db"
  },
  runtime: {
    heartbeatIntervalMs: 5000
  },
  model: {
    provider: "rule-based"
  },
  policy: {
    allowOutput: true,
    allowFileRead: false,
    allowFileWrite: false,
    allowNetwork: false,
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
