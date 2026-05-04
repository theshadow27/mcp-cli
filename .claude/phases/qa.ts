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
import { gh, prEdit } from "./gh";
import { runQa } from "./qa-fn";

const ProviderSchema = z
  .string()
  .refine(
    (v) => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"),
    { message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"' },
  );

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
    model: z.enum(["opus", "sonnet"]).optional(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-qa requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.issueNumber == null) missing.push("issueNumber");
    if (work.branch == null) missing.push("branch");
    if (work.prNumber == null) missing.push("prNumber");
    if (missing.length > 0) {
      throw new Error(
        `phase-qa requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    return runQa(
      input,
      { id: work.id, prNumber: work.prNumber, branch: work.branch, issueNumber: work.issueNumber },
      ctx.state,
      { gh, prEdit },
    );
  },
});
