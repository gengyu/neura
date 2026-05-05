import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export default {
  id: "local-log-output",
  name: "Local Log Output",
  direction: "output",
  type: "file",

  async send({ content }) {
    const outputPath = resolve("logs/neura-output.log");
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, JSON.stringify({ createdAt: new Date().toISOString(), content }) + "\n");
  }
};
