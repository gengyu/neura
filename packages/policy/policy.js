import { resolve } from "node:path";

export class PermissionPolicy {
  constructor(policy) {
    this.policy = policy;
  }

  canSendOutput() {
    return this.policy.allowOutput === true;
  }

  assertFileReadAllowed(path) {
    if (!this.policy.allowFileRead) {
      throw new Error(`File read is blocked by policy: ${path}`);
    }
  }

  assertFileWriteAllowed(path) {
    if (!this.policy.allowFileWrite) {
      throw new Error(`File write is blocked by policy: ${path}`);
    }
  }

  assertNetworkAllowed(url) {
    if (!this.policy.allowNetwork) {
      throw new Error(`Network request is blocked by policy: ${url}`);
    }
  }

  assertCommandExecutionAllowed(command) {
    if (!this.policy.allowCommandExecution) {
      throw new Error(`Command execution is blocked by policy: ${command}`);
    }
  }

  requiresConfirmation(action, metadata = {}) {
    const confirmationEnabled = this.policy.requireConfirmation !== false;
    if (!confirmationEnabled) return false;
    if (action === "execute_command") return true;
    if (action === "delete_file") return true;
    if (action === "write_file" && metadata.exists) return true;
    if (action === "write_file" && isSensitivePath(metadata.path)) return true;
    return false;
  }

  describe() {
    return {
      output: this.policy.allowOutput ? "allowed" : "blocked",
      fileRead: this.policy.allowFileRead ? "allowed" : "blocked",
      fileWrite: this.policy.allowFileWrite ? "allowed" : "blocked",
      network: this.policy.allowNetwork ? "allowed" : "blocked",
      commandExecution: this.policy.allowCommandExecution ? "allowed_with_confirmation" : "blocked",
      requireConfirmation: this.policy.requireConfirmation !== false
    };
  }
}

function isSensitivePath(path) {
  if (!path) return false;
  const normalized = resolve(path);
  return normalized.startsWith("/etc") || normalized.startsWith("/System") || normalized.startsWith("/usr");
}
