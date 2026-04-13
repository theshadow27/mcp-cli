/**
 * Phase: repair — fix blockers raised by review or qa.
 *
 * Prompts differ by previous_phase:
 *   - review → read sticky "## Adversarial Review" comment, fix 🔴/🟡
 *   - qa     → read the qa:fail comment, address every blocker
 *
 * Worktree reuse: prefer --cwd worktree_path when known; fall back to
 * --worktree if the impl worktree was auto-cleaned by `bye`.
 *
 * Cap: repair_round >= 3 → goto needs-attention (matches "stop the loop").
 *
 * State writes: repair_session_id, repair_round.
 */
import { defineAlias, z } from "mcp-cli";

const REPAIR_ROUND_CAP = 3;

defineAlias({
  name: "phase-repair",
  description: "Sprint phase: spawn opus repair session for a PR with blockers.",
  input: z.object({
    provider: z.string().default("claude"),
  }),
  output: z.object({
    action: z.enum(["spawn", "goto"]),
    target: z.enum(["needs-attention"]).optional(),
    reason: z.string(),
    round: z.number(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work || work.prNumber == null) {
      throw new Error("phase-repair requires a work item with prNumber");
    }

    const round = ((await ctx.state.get<number>("repair_round")) ?? 0) + 1;
    if (round > REPAIR_ROUND_CAP) {
      return {
        action: "goto" as const,
        target: "needs-attention" as const,
        reason: `repair cap (${REPAIR_ROUND_CAP}) exceeded — escalating`,
        round: round - 1,
      };
    }

    const previous = ((await ctx.state.get<string>("previous_phase")) ?? "review") as "review" | "qa";
    const worktreePath = await ctx.state.get<string>("worktree_path");

    const prompt =
      previous === "qa"
        ? `Repair PR #${work.prNumber}. Read the qa:fail comment: gh pr view ${work.prNumber} --comments. Address every blocker. Push to existing branch.`
        : `Repair PR #${work.prNumber}. Read the adversarial review sticky comment: gh pr view ${work.prNumber} --comments. Fix all 🔴 and 🟡. Push to existing branch.`;

    const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "ExitPlanMode", "EnterPlanMode"];
    const cmdBase = input.provider.startsWith("acp:")
      ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
      : ["mcx", input.provider, "spawn"];
    const worktreeFlags = worktreePath ? ["--cwd", worktreePath] : ["--worktree"];
    const command = [...cmdBase, ...worktreeFlags, "--model", "opus", "-t", prompt, "--allow", ...allowTools];

    await ctx.state.set("repair_round", round);

    return {
      action: "spawn" as const,
      reason: `repair round ${round}, triggered by ${previous}`,
      round,
      command,
      prompt,
      allowTools,
    };
  },
});
