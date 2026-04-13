/**
 * Phase: qa — spawn QA session or act on its label verdict.
 *
 * On first entry: emits spawn plan for a sonnet QA session. Reuses
 *   worktree_path if known, otherwise --worktree.
 * On re-entry (qa_session_id set): reads PR labels.
 *   - no qa:pass / qa:fail  → { action: "wait" }
 *   - qa:pass               → { action: "goto", target: "done" }
 *   - qa:fail               → { action: "goto", target: "repair" } (with cap)
 *
 * Cap: qa_fail_round >= 2 → needs-attention (matches "stop the loop").
 *
 * State writes: qa_session_id, qa_fail_round, previous_phase.
 */
import { defineAlias, z } from "mcp-cli";

const QA_FAIL_CAP = 2;

function readQaLabel(prNumber: number): "pass" | "fail" | null {
  const proc = Bun.spawnSync({
    cmd: ["gh", "pr", "view", String(prNumber), "--json", "labels", "-q", ".labels[].name"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const lines = new TextDecoder().decode(proc.stdout).split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "qa:pass") return "pass";
    if (line.trim() === "qa:fail") return "fail";
  }
  return null;
}

defineAlias({
  name: "phase-qa",
  description: "Sprint phase: spawn QA session or act on its label verdict.",
  input: z.object({
    provider: z.string().default("claude"),
  }),
  output: z.object({
    action: z.enum(["spawn", "wait", "goto"]),
    target: z.enum(["done", "repair", "needs-attention"]).optional(),
    reason: z.string(),
    round: z.number().optional(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work || work.prNumber == null || work.branch == null || work.issueNumber == null) {
      throw new Error("phase-qa requires a work item with issueNumber, branch, prNumber");
    }

    const sessionId = await ctx.state.get<string>("qa_session_id");

    if (!sessionId) {
      const worktreePath = await ctx.state.get<string>("worktree_path");
      const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
      const prompt = `/qa ${work.issueNumber} (PR ${work.prNumber}, branch ${work.branch})`;
      const cmdBase = input.provider.startsWith("acp:")
        ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
        : ["mcx", input.provider, "spawn"];
      const worktreeFlags = worktreePath ? ["--cwd", worktreePath] : ["--worktree"];
      const command = [...cmdBase, ...worktreeFlags, "--model", "sonnet", "-t", prompt, "--allow", ...allowTools];
      return {
        action: "spawn" as const,
        reason: "qa session starting",
        command,
        prompt,
        allowTools,
      };
    }

    const label = readQaLabel(work.prNumber);
    if (label === null) {
      return { action: "wait" as const, reason: "qa:pass / qa:fail label not set yet" };
    }

    if (label === "pass") {
      return { action: "goto" as const, target: "done" as const, reason: "qa:pass → done" };
    }

    const round = ((await ctx.state.get<number>("qa_fail_round")) ?? 0) + 1;
    if (round > QA_FAIL_CAP) {
      return {
        action: "goto" as const,
        target: "needs-attention" as const,
        reason: `qa fail cap (${QA_FAIL_CAP}) exceeded — escalating`,
        round: round - 1,
      };
    }
    await ctx.state.set("qa_fail_round", round);
    await ctx.state.set("previous_phase", "qa");
    return {
      action: "goto" as const,
      target: "repair" as const,
      reason: `qa:fail round ${round} → repair`,
      round,
    };
  },
});
