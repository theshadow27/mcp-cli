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
 * State writes (this handler): qa_session_id sentinel, qa_fail_round, previous_phase.
 * Orchestrator responsibility: replace qa_session_id "pending:*" with real
 * session ID after spawn; delete it on spawn failure.
 */
import { defineAlias, z } from "mcp-cli";

const QA_FAIL_CAP = 2;

const ProviderSchema = z
  .string()
  .refine(
    (v) => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"),
    { message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"' },
  );

function readQaLabels(prNumber: number): { hasPass: boolean; hasFail: boolean } {
  const proc = Bun.spawnSync({
    cmd: ["gh", "pr", "view", String(prNumber), "--json", "labels", "-q", ".labels[].name"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return { hasPass: false, hasFail: false };
  const names = new Set(
    new TextDecoder().decode(proc.stdout).split(/\r?\n/).map((l) => l.trim()),
  );
  return { hasPass: names.has("qa:pass"), hasFail: names.has("qa:fail") };
}

function removeLabel(prNumber: number, label: string): void {
  Bun.spawnSync({
    cmd: ["gh", "pr", "edit", String(prNumber), "--remove-label", label],
    stdout: "pipe",
    stderr: "pipe",
  });
}

defineAlias({
  name: "phase-qa",
  description: "Sprint phase: spawn QA session or act on its label verdict.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
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
      // Write sentinel before returning — prevents re-spawn on retry.
      // Orchestrator replaces with real session ID after spawn.
      await ctx.state.set("qa_session_id", `pending:${Date.now()}`);
      return {
        action: "spawn" as const,
        reason: "qa session starting",
        command,
        prompt,
        allowTools,
      };
    }

    const { hasPass, hasFail } = readQaLabels(work.prNumber);
    if (!hasPass && !hasFail) {
      return { action: "wait" as const, reason: "qa:pass / qa:fail label not set yet" };
    }

    // Label hygiene: pass is the authoritative verdict when both are present
    // (the most recent QA round set it). Strip the stale counterpart on
    // every verdict so merge gates can trust "pass xor fail" (see #1303).
    if (hasPass) {
      if (hasFail) removeLabel(work.prNumber, "qa:fail");
      return { action: "goto" as const, target: "done" as const, reason: "qa:pass → done" };
    }
    // hasFail only — no stale pass possible (we would have returned above).

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
