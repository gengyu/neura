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

  describe() {
    return {
      output: this.policy.allowOutput ? "allowed" : "blocked",
      fileRead: this.policy.allowFileRead ? "allowed" : "blocked",
      fileWrite: this.policy.allowFileWrite ? "allowed" : "blocked",
      network: this.policy.allowNetwork ? "allowed" : "blocked",
      commandExecution: this.policy.allowCommandExecution ? "allowed" : "blocked"
    };
  }
}
