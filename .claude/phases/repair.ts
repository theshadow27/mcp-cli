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
 * State writes (this handler): repair_session_id sentinel, repair_round.
 * Orchestrator responsibility: replace repair_session_id "pending:*" with real
 * session ID after spawn; delete it on spawn failure so next entry re-spawns.
 */
import { defineAlias, z } from "mcp-cli";

const REPAIR_ROUND_CAP = 3;

function removeLabel(prNumber: number, label: string): void {
  Bun.spawnSync({
    cmd: ["gh", "pr", "edit", String(prNumber), "--remove-label", label],
    stdout: "pipe",
    stderr: "pipe",
  });
}

const ProviderSchema = z
  .string()
  .refine(
    (v) => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"),
    { message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"' },
  );

defineAlias({
  name: "phase-repair",
  description: "Sprint phase: spawn opus repair session for a PR with blockers.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
  }),
  output: z.object({
    action: z.enum(["spawn", "goto", "in-flight"]),
    target: z.enum(["needs-attention"]).optional(),
    reason: z.string(),
    round: z.number(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-repair requires a work item (got: null)");
    }
    if (work.prNumber == null) {
      throw new Error(`phase-repair requires 'prNumber' on the work item ${work.id} (missing: prNumber)`);
    }

    // In-flight guard — repair session already running; don't spawn a second.
    const existingSession = await ctx.state.get<string>("repair_session_id");
    if (existingSession) {
      const round = (await ctx.state.get<number>("repair_round")) ?? 1;
      return {
        action: "in-flight" as const,
        reason: `repair session in flight (round ${round})`,
        round,
      };
    }

    const prevRound = (await ctx.state.get<number>("repair_round")) ?? 0;
    const round = prevRound + 1;
    if (round > REPAIR_ROUND_CAP) {
      return {
        action: "goto" as const,
        target: "needs-attention" as const,
        reason: `repair cap (${REPAIR_ROUND_CAP}) exceeded — escalating`,
        round: prevRound,
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

    // Clear stale QA state so the qa phase re-spawns fresh after repair.
    // Without this, qa sees the old qa:fail label and loops back to repair
    // instead of running a new QA session (sprint 36 hit this on #1412).
    await ctx.state.delete("qa_session_id");
    removeLabel(work.prNumber, "qa:fail");

    // Persist round and sentinel before returning. Orchestrator replaces
    // repair_session_id with real session ID; deletes on spawn failure.
    await ctx.state.set("repair_round", round);
    await ctx.state.set("repair_session_id", `pending:${Date.now()}`);

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
