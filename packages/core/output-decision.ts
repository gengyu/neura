import { APPROVAL_STATUSES, RUNTIME_EVENT_TYPES, SOURCE_TYPES } from "../shared/types.ts";
import type { GenericRecord } from "./types.ts";

type OutputDecisionSource = GenericRecord & {
  sourceType?: string;
  eventType?: string;
  type?: string;
  approval?: { status?: string };
  error?: unknown;
  priority?: string;
  runtimeState?: { level?: string; notify?: boolean };
  preferredPluginIds?: string[];
  shouldOutput?: boolean;
  outputType?: string;
  taskResult?: {
    outputHint?: { shouldOutput?: boolean; type?: string; outputType?: string; reason?: string; priority?: string; preferredPluginIds?: string[] };
    outputDecision?: { shouldOutput?: boolean; type?: string; outputType?: string; reason?: string; priority?: string; preferredPluginIds?: string[] };
  };
};

export function buildOutputDecision(source: OutputDecisionSource = {}) {
  const sourceType = source.sourceType ?? SOURCE_TYPES.INTERNAL;
  const eventType = source.eventType ?? source.type ?? null;

  if (sourceType === SOURCE_TYPES.SCHEDULE || eventType === RUNTIME_EVENT_TYPES.SCHEDULE_REMINDER) {
    return {
      shouldOutput: true,
      outputType: "reminder",
      reason: "schedule_reminder_due",
      priority: "high",
      preferredPluginIds: []
    };
  }

  if (sourceType === SOURCE_TYPES.APPROVAL || eventType === RUNTIME_EVENT_TYPES.APPROVAL_REQUIRED || source.approval?.status === APPROVAL_STATUSES.PENDING) {
    return {
      shouldOutput: true,
      outputType: "confirmation_request",
      reason: "approval_required",
      priority: "high",
      preferredPluginIds: []
    };
  }

  if (eventType === "runtime_error" || source.error) {
    return {
      shouldOutput: true,
      outputType: "error",
      reason: "runtime_error",
      priority: "high",
      preferredPluginIds: []
    };
  }

  if (sourceType === SOURCE_TYPES.RUNTIME_STATE || eventType === RUNTIME_EVENT_TYPES.RUNTIME_STATE_CHANGED) {
    const important = source.priority === "high" || source.runtimeState?.level === "error" || source.runtimeState?.notify === true;
    return {
      shouldOutput: Boolean(important),
      outputType: important ? "status_report" : "none",
      reason: important ? "runtime_state_requires_notification" : "runtime_state_no_output_needed",
      priority: source.priority ?? (important ? "high" : "low"),
      preferredPluginIds: source.preferredPluginIds ?? []
    };
  }

  if (sourceType === SOURCE_TYPES.MEMORY_REVIEW || eventType === RUNTIME_EVENT_TYPES.MEMORY_REVIEW) {
    return {
      shouldOutput: Boolean(source.shouldOutput ?? true),
      outputType: source.outputType ?? "summary",
      reason: "memory_review_ready",
      priority: source.priority ?? "medium",
      preferredPluginIds: source.preferredPluginIds ?? []
    };
  }

  if (sourceType === SOURCE_TYPES.MANUAL || eventType === RUNTIME_EVENT_TYPES.MANUAL_OUTPUT) {
    return {
      shouldOutput: true,
      outputType: source.outputType ?? "status_report",
      reason: "manual_output_request",
      priority: source.priority ?? "medium",
      preferredPluginIds: source.preferredPluginIds ?? []
    };
  }

  if (source.taskResult?.outputHint?.shouldOutput || source.taskResult?.outputDecision?.shouldOutput) {
    const hint = source.taskResult.outputHint ?? source.taskResult.outputDecision;
    if (!hint) {
      return {
        shouldOutput: false,
        outputType: "none",
        reason: "task_output_hint_missing",
        priority: "low",
        preferredPluginIds: []
      };
    }
    return {
      shouldOutput: true,
      outputType: hint.type ?? hint.outputType ?? "summary",
      reason: hint.reason ?? "task_output_hint",
      priority: hint.priority ?? "medium",
      preferredPluginIds: hint.preferredPluginIds ?? []
    };
  }

  return {
    shouldOutput: false,
    outputType: "none",
    reason: "no_output_needed",
    priority: "low",
    preferredPluginIds: []
  };
}
