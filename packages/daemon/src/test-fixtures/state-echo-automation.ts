import { defineAutomation } from "@mcp-cli/core";

export default defineAutomation({
  name: "state-echo",
  events: ["pr.merged"],
  fn: async (_event, ctx) => {
    const allState = await ctx.state.all();
    ctx.emit({
      event: "test.state",
      category: "automation",
      stateKeys: Object.keys(allState).sort(),
      stateSnapshot: allState,
    });
    return { action: "none", reason: "echoed state" };
  },
});
