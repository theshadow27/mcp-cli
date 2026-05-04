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
import { prEdit } from "./gh";
import { runRepair } from "./repair-fn";

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
    model: z.enum(["opus", "sonnet"]).optional(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-repair requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.prNumber == null) missing.push("prNumber");
    if (missing.length > 0) {
      throw new Error(
        `phase-repair requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    return runRepair(
      input,
      { id: work.id, prNumber: work.prNumber },
      ctx.state,
      { prEdit },
    );
  },
});
