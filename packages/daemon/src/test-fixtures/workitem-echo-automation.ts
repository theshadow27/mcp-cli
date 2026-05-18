import { defineAutomation } from "@mcp-cli/core";

export default defineAutomation({
  name: "workitem-echo",
  events: ["pr.merged"],
  fn: async (event, ctx) => {
    ctx.emit({
      event: "test.workitem",
      category: "automation",
      workItemId: ctx.workItem?.id ?? "none",
      phase: ctx.workItem?.phase ?? "none",
      prNumber: ctx.workItem?.prNumber ?? null,
    });
    return { action: "none", reason: `workItem=${ctx.workItem?.id ?? "null"}` };
  },
});
