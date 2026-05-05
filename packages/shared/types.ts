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

export const RUNTIME_STATUSES = {
  RUNNING: "running",
  STOPPED: "stopped"
};
