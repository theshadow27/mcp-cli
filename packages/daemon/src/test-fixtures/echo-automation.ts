import { defineAutomation } from "@mcp-cli/core";

export default defineAutomation({
  name: "echo",
  events: ["pr.merged"],
  fn: async (event, ctx) => {
    ctx.logger.info(`echo: ${event.event}`);
    return { action: "none", reason: `echoed ${event.event}` };
  },
});
