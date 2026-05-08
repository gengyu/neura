export const INPUT_TYPES = new Set(["text", "image", "file", "url", "event", "command"]);

export const INPUT_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  IGNORED: "ignored"
};

export const TASK_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed"
};

export const TOOL_CALL_STATUSES = {
  COMPLETED: "completed",
  FAILED: "failed",
  REJECTED: "rejected",
  PENDING_CONFIRMATION: "pending_confirmation"
};

export const OUTPUT_STATUSES = {
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed"
};

export const APPROVAL_STATUSES = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected"
};

export const SCHEDULE_STATUSES = {
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed"
};

export const AGENT_STATUSES = {
  ACTIVE: "active",
  RUNNING: "running",
  STOPPED: "stopped"
};

export const PLUGIN_STATUSES = {
  ENABLED: "enabled",
  DISABLED: "disabled",
  RUNNING: "running",
  ERROR: "error"
};

export const SOURCE_TYPES = {
  INPUT_EVENT: "input_event",
  TASK: "task",
  SCHEDULE: "schedule",
  APPROVAL: "approval",
  RUNTIME_STATE: "runtime_state",
  MEMORY_REVIEW: "memory_review",
  MANUAL: "manual",
  INTERNAL: "internal"
};

export const RUNTIME_EVENT_TYPES = {
  SCHEDULE_REMINDER: "schedule_reminder",
  APPROVAL_REQUIRED: "approval_required",
  RUNTIME_STATE_CHANGED: "runtime_state_changed",
  MEMORY_REVIEW: "memory_review",
  MANUAL_OUTPUT: "manual_output",
  EMIT_OUTPUT: "emit_output"
};

export const RUNTIME_STATUSES = {
  RUNNING: "running",
  STOPPED: "stopped"
};
