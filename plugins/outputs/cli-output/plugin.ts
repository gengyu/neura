export default {
  id: "cli-output",
  name: "CLI Output",
  direction: "output",
  type: "cli",

  async send({ content }) {
    const summary = content.summary ?? content.message ?? JSON.stringify(content);
    const prefix = content.taskType ? `[Neura:${content.taskType}]` : "[Neura]";
    console.log(`${prefix} ${summary}`);
  }
};
