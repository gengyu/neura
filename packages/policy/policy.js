export class PermissionPolicy {
  constructor(policy) {
    this.policy = policy;
  }

  canSendOutput() {
    return this.policy.allowOutput === true;
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
