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
    if (!work || work.prNumber == null || work.issueNumber == null) {
      throw new Error("phase-needs-attention requires a work item with prNumber and issueNumber");
    }

    const reviewRound = (await ctx.state.get<number>("review_round")) ?? 0;
    const repairRound = (await ctx.state.get<number>("repair_round")) ?? 0;
    const qaFailRound = (await ctx.state.get<number>("qa_fail_round")) ?? 0;
    const triage = (await ctx.state.get<string>("triage_scrutiny")) ?? "unknown";

    // Strip stale qa: labels — they'd be misleading once we escalate.
    for (const label of ["qa:pass", "qa:fail"]) {
      Bun.spawnSync({
        cmd: ["gh", "pr", "edit", String(work.prNumber), "--remove-label", label],
        stderr: "pipe",
        stdout: "pipe",
      });
    }

    const body = [
      "## 🚩 Needs attention",
      "",
      `Automated sprint pipeline exhausted its round caps on PR #${work.prNumber}.`,
      "",
      "| Round type | Count |",
      "|------------|-------|",
      `| Review     | ${reviewRound} |`,
      `| Repair     | ${repairRound} |`,
      `| QA fail    | ${qaFailRound} |`,
      "",
      `Triage scrutiny was **${triage}**. An operator should decide between: refining the issue spec, taking over the PR manually, or closing it.`,
    ].join("\n");

    const cmt = Bun.spawnSync({
      cmd: ["gh", "pr", "comment", String(work.prNumber), "--body", body],
      stdout: "pipe",
      stderr: "pipe",
    });
    const commented = cmt.exitCode === 0;

    try {
      await ctx.mcp._work_items.work_items_update({ id: work.id, phase: "needs-attention" });
    } catch {
      /* non-fatal */
    }

    return {
      prNumber: work.prNumber,
      issueNumber: work.issueNumber,
      reviewRound,
      repairRound,
      qaFailRound,
      commented,
    };
  },
});
