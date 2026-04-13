/**
 * Phase: review — adversarial review for high-scrutiny PRs.
 *
 * On first entry: emits the spawn plan for a sonnet reviewer.
 * On re-entry (review_session_id already set): scans the PR for the sticky
 *   `## Adversarial Review` comment and decides the transition.
 *     - no comment yet         → { action: "wait" }
 *     - 🔴 or 🟡 present       → { action: "goto", target: "repair" } (with round cap)
 *     - all ✅ / no blockers    → { action: "goto", target: "qa" }
 *
 * Round cap: review_round >= 2 and issues remain → prefer qa (matches
 * run.md's "two reviews max" rule).
 *
 * State writes (this handler): review_session_id sentinel, review_round, previous_phase.
 * Orchestrator responsibility: replace review_session_id "pending:*" with real
 * session ID after spawn; delete review_session_id before re-entering review
 * for a new round (so the handler spawns a fresh reviewer rather than reading
 * the previous reviewer's comment).
 */
import { defineAlias, z } from "mcp-cli";

const REVIEW_ROUND_CAP = 2;

function scanReviewComments(prNumber: number): { found: boolean; hasBlockers: boolean; summary: string } {
  const proc = Bun.spawnSync({
    cmd: ["gh", "pr", "view", String(prNumber), "--json", "comments", "-q", ".comments[].body"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return { found: false, hasBlockers: false, summary: "gh pr view failed" };
  const body = new TextDecoder().decode(proc.stdout);
  // Sticky reviewer comment always starts with this marker.
  const sticky = body.split(/\n{2,}/).reverse().find((b) => b.includes("## Adversarial Review"));
  if (!sticky) return { found: false, hasBlockers: false, summary: "no sticky comment yet" };
  const hasBlockers = /🔴|🟡/.test(sticky);
  return { found: true, hasBlockers, summary: hasBlockers ? "blockers remain" : "all clear" };
}

defineAlias({
  name: "phase-review",
  description: "Sprint phase: spawn adversarial reviewer or act on its sticky comment.",
  input: z.object({
    provider: z.string().default("claude"),
  }),
  output: z.object({
    action: z.enum(["spawn", "wait", "goto"]),
    target: z.enum(["repair", "qa"]).optional(),
    reason: z.string(),
    round: z.number(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work || work.prNumber == null || work.branch == null) {
      throw new Error("phase-review requires a work item with prNumber and branch");
    }

    const round = (await ctx.state.get<number>("review_round")) ?? 1;
    const sessionId = await ctx.state.get<string>("review_session_id");

    // No session yet → spawn one.
    if (!sessionId) {
      const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
      const prompt = `/adversarial-review (PR ${work.prNumber}, branch ${work.branch}, round ${round})`;
      const cmdBase = input.provider.startsWith("acp:")
        ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
        : ["mcx", input.provider, "spawn"];
      const command = [...cmdBase, "--worktree", "--model", "sonnet", "-t", prompt, "--allow", ...allowTools];
      // Persist round counter and sentinel before returning — re-entry returns
      // "wait" (not a new spawn) until the orchestrator clears review_session_id.
      await ctx.state.set("review_round", round);
      await ctx.state.set("review_session_id", `pending:${Date.now()}`);
      return {
        action: "spawn" as const,
        reason: `review round ${round} starting`,
        round,
        command,
        prompt,
        allowTools,
      };
    }

    // Session exists — check PR for sticky comment.
    const scan = scanReviewComments(work.prNumber);
    if (!scan.found) {
      return { action: "wait" as const, reason: scan.summary, round };
    }

    if (!scan.hasBlockers) {
      return { action: "goto" as const, target: "qa" as const, reason: "review clean → qa", round };
    }

    // Blockers present. Cap exceeded → hand off to qa instead of looping.
    if (round >= REVIEW_ROUND_CAP) {
      return {
        action: "goto" as const,
        target: "qa" as const,
        reason: `review round cap (${REVIEW_ROUND_CAP}) reached; deferring remaining items to qa`,
        round,
      };
    }

    await ctx.state.set("review_round", round + 1);
    await ctx.state.set("previous_phase", "review");
    return { action: "goto" as const, target: "repair" as const, reason: "blockers remain → repair", round };
  },
});
