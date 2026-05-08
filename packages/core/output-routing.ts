import { SOURCE_TYPES } from "../shared/types.ts";

export function buildOutputRoute({ outputEvent = {}, decision = {}, repository }) {
  const enabledOutputs = repository
    .listPlugins()
    .filter((plugin) => plugin.direction === "output" && plugin.enabled);

  const idsByType = new Map(enabledOutputs.map((plugin) => [plugin.type, plugin.id]));
  const preferredPluginIds = [...(decision.preferredPluginIds ?? outputEvent.preferredPluginIds ?? [])];

  const addIfEnabled = (type) => {
    const id = idsByType.get(type);
    if (id && !preferredPluginIds.includes(id)) preferredPluginIds.push(id);
  };

  addIfEnabled("file");

  const outputType = decision.outputType ?? outputEvent.type;
  const sourceType = outputEvent.sourceType;
  const priority = decision.priority ?? outputEvent.priority ?? "medium";

  if (sourceType === SOURCE_TYPES.SCHEDULE || outputType === "reminder") {
    addIfEnabled("system-notification");
    addIfEnabled("cli");
    addIfEnabled("admin-ui");
  } else if (sourceType === SOURCE_TYPES.APPROVAL || outputType === "confirmation_request") {
    addIfEnabled("cli");
    addIfEnabled("admin-ui");
    addIfEnabled("system-notification");
  } else if (sourceType === SOURCE_TYPES.MEMORY_REVIEW) {
    addIfEnabled("admin-ui");
    if (priority === "high") addIfEnabled("system-notification");
  } else if (sourceType === SOURCE_TYPES.MANUAL) {
    addIfEnabled("cli");
    addIfEnabled("admin-ui");
  } else if (sourceType === SOURCE_TYPES.RUNTIME_STATE) {
    addIfEnabled("admin-ui");
    if (priority === "high") addIfEnabled("system-notification");
  } else if (outputType === "error" || priority === "high") {
    addIfEnabled("system-notification");
    addIfEnabled("admin-ui");
  } else {
    addIfEnabled("admin-ui");
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
