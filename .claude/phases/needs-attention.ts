/**
 * Phase: needs-attention — terminal. Escalation path when caps blow.
 *
 * Clears qa:pass/qa:fail labels (they're stale once we give up), posts a
 * summary comment on the PR with rounds attempted + final state, and
 * updates the work item's phase. The item stays tracked — the orchestrator
 * surfaces it to the user for manual decision (not auto-untracked like
 * done).
 */
import { defineAlias, z } from "mcp-cli";
import { prComment, prEdit } from "./gh";
import { runNeedsAttention } from "./needs-attention-fn";

defineAlias({
  name: "phase-needs-attention",
  description: "Sprint phase: terminal. Escalate a PR that exhausted automated repair.",
  input: z.object({}).default({}),
  output: z.object({
    prNumber: z.number(),
    issueNumber: z.number(),
    reviewRound: z.number(),
    repairRound: z.number(),
    qaFailRound: z.number(),
    commented: z.boolean(),
  }),
  fn: async (_input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-needs-attention requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.prNumber == null) missing.push("prNumber");
    if (work.issueNumber == null) missing.push("issueNumber");
    if (missing.length > 0) {
      throw new Error(
        `phase-needs-attention requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    return runNeedsAttention(
      { id: work.id, prNumber: work.prNumber, issueNumber: work.issueNumber },
      ctx.state,
      {
        prEdit,
        prComment,
        updateWorkItemPhase: (id, phase) =>
          ctx.mcp._work_items.work_items_update({ id, phase }),
      },
    );
  },
});
