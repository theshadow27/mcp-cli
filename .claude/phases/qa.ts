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
import { parsePrEditFlags } from "./phase-types";
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
      {
        async gh(op) {
          try {
            if (op.op === "pr:labels") {
              const pr = await ctx.gh.pr(op.prNumber).body();
              return { stdout: pr.labels.join("\n"), stderr: "", exitCode: 0 };
            }
            if (op.op === "pr:label-events") {
              const events = await ctx.gh.pr(op.prNumber).labelEvents();
              return { stdout: JSON.stringify(events), stderr: "", exitCode: 0 };
            }
            if (op.op === "pr:head-date") {
              const date = await ctx.gh.pr(op.prNumber).headCommitDate();
              return { stdout: date, stderr: "", exitCode: 0 };
            }
            if (op.op === "pr:author") {
              const pr = await ctx.gh.pr(op.prNumber).body();
              return { stdout: pr.user, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
          } catch (err) {
            return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
          }
        },
        async prEdit(prNumber, flags) {
          const { addLabels, removeLabels } = parsePrEditFlags(flags);
          await ctx.gh.pr(prNumber).edit({ addLabels, removeLabels });
        },
      },
    );
  },
});
