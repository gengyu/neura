import { execFile } from "node:child_process";

export default {
  id: "system-notification-output",
  name: "System Notification Output",
  direction: "output",
  type: "system-notification",

  async send({ content }) {
    const title = content.title ?? `Neura${content.taskType ? ` · ${content.taskType}` : ""}`;
    const body = truncate(content.summary ?? content.message ?? JSON.stringify(content), 180);

    if (process.platform === "darwin") {
      await runAppleScript(title, body);
      return;
    }

    console.log(`[Notification] ${title}: ${body}`);
  }
};

function truncate(value, maxLength) {
  return String(value).length > maxLength ? `${String(value).slice(0, maxLength - 1)}…` : String(value);
}

function runAppleScript(title, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("osascript", ["-e", `display notification ${toAppleScriptString(body)} with title ${toAppleScriptString(title)}`], (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function toAppleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
