import { SOURCE_TYPES } from "../shared/types.ts";
import type { OutputEvent, OutputPlugin, OutputRoutingRepository } from "./types.ts";

type OutputRouteDecision = {
  preferredPluginIds?: string[];
  outputType?: string;
  priority?: string;
};

export function buildOutputRoute({
  outputEvent = {},
  decision = {},
  repository
}: {
  outputEvent?: OutputEvent;
  decision?: OutputRouteDecision;
  repository: OutputRoutingRepository;
}): { preferredPluginIds: string[]; deliveryMode: string; shouldPersistLog: boolean } {
  const enabledOutputs = (repository.listPlugins?.() ?? [])
    .filter((plugin: OutputPlugin) => plugin.direction === "output" && plugin.enabled);

  const idsByType = new Map<string, string>(enabledOutputs.map((plugin: OutputPlugin) => [plugin.type, plugin.id]));
  const preferredPluginIds = [...(decision.preferredPluginIds ?? outputEvent.preferredPluginIds ?? [])];

  const addIfEnabled = (type: string): void => {
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

function describeDeliveryMode(preferredPluginIds: string[], idsByType: Map<string, string>): string {
  const notificationId = idsByType.get("system-notification");
  const cliId = idsByType.get("cli");
  const adminUiId = idsByType.get("admin-ui");
  if (notificationId && preferredPluginIds.includes(notificationId)) return "push";
  if (cliId && preferredPluginIds.includes(cliId)) return "interactive";
  if (adminUiId && preferredPluginIds.includes(adminUiId)) return "dashboard";
  return "silent";
}
