export function buildOutputPlan({ normalizedInput, analysis, repository }) {
  const enabledOutputs = repository
    .listPlugins()
    .filter((plugin) => plugin.direction === "output" && plugin.enabled);

  const idsByType = new Map(enabledOutputs.map((plugin) => [plugin.type, plugin.id]));
  const preferredPluginIds = [];

  const addIfEnabled = (type) => {
    const id = idsByType.get(type);
    if (id && !preferredPluginIds.includes(id)) preferredPluginIds.push(id);
  };

  addIfEnabled("file");

  const taskType = analysis.taskType ?? normalizedInput.taskType;

  if (analysis.outputDecision.shouldOutput) {
    if (normalizedInput.sourcePluginId === "cli-input") {
      addIfEnabled("cli");
    } else if (normalizedInput.sourcePluginId === "admin-ui-output") {
      addIfEnabled("admin-ui");
    } else if (normalizedInput.sourcePluginId === "webhook-input") {
      addIfEnabled("admin-ui");
      if (analysis.outputDecision.priority === "high") addIfEnabled("system-notification");
    } else if (taskType === "reminder") {
      addIfEnabled("system-notification");
      addIfEnabled("cli");
      addIfEnabled("admin-ui");
    } else if (["query", "memory_query", "action_request", "summarize_current"].includes(taskType)) {
      addIfEnabled("cli");
      addIfEnabled("admin-ui");
    } else if (analysis.outputDecision.priority === "high") {
      addIfEnabled("system-notification");
      addIfEnabled("admin-ui");
    } else {
      addIfEnabled("admin-ui");
    }
  }

  return {
    preferredPluginIds,
    deliveryMode: describeDeliveryMode(preferredPluginIds, idsByType),
    shouldPersistLog: idsByType.has("file")
  };
}

function describeDeliveryMode(preferredPluginIds, idsByType) {
  if (preferredPluginIds.includes(idsByType.get("system-notification"))) return "push";
  if (preferredPluginIds.includes(idsByType.get("cli"))) return "interactive";
  if (preferredPluginIds.includes(idsByType.get("admin-ui"))) return "dashboard";
  return "silent";
}
