import { defineAutomation } from "@mcp-cli/core";

export default defineAutomation({
  name: "bind",
  events: ["pr.opened"],
  fn: async (event, ctx) => {
    const prNumber = event.prNumber;
    const branch = event.branch;

    if (typeof prNumber !== "number" || typeof branch !== "string") {
      return { action: "none", reason: "event missing prNumber or branch" };
    }

    let item = ctx.findWorkItemByBranch(branch);

    if (!item) {
      const pattern = ctx.config.branchPattern;
      if (typeof pattern === "string") {
        try {
          const match = new RegExp(pattern).exec(branch);
          if (match?.groups?.issue) {
            const issueNumber = Number.parseInt(match.groups.issue, 10);
            if (!Number.isNaN(issueNumber)) {
              item = ctx.findWorkItemByIssue(issueNumber);
            }
          }
        } catch {
          ctx.logger.warn(`invalid branchPattern regex: ${pattern}`);
        }
      }
    }

    if (!item) {
      return { action: "none", reason: `no tracked item with branch ${branch}` };
    }

    if (item.prNumber != null) {
      return { action: "none", reason: `item already bound to PR #${item.prNumber}` };
    }

    ctx.logger.info(`binding PR #${prNumber} to ${item.id} via branch ${branch}`);

    return {
      action: "set-state",
      workItemId: item.id,
      patch: { prNumber, branch },
    };
  },
});
