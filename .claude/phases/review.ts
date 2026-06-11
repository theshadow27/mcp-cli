/**
 * Phase: review — adversarial review for high-scrutiny PRs.
 *
 * On first entry: emits the spawn plan for the reviewer.
 * On re-entry (review_session_id already set): reads the typed verdict LABEL
 *   the reviewer set (`review:pass` / `review:changes`) and decides the
 *   transition. The sticky comment body is NEVER scraped for the verdict —
 *   prose is attacker-influenced free text, so trusting it is a merge-gate
 *   prompt-injection vector (#2575). The label is the only control signal.
 *     - no verdict label yet   → { action: "wait" }
 *     - review:changes         → { action: "goto", target: "repair" } (with round cap)
 *     - review:pass            → { action: "goto", target: "qa" }
 *
 * Round cap: review_round >= 2 and issues remain → prefer qa (matches
 * run.md's "two reviews max" rule).
 *
 * Model resolution order (first match wins):
 *   1. `input.model` — explicit override from the orchestrator
 *   2. Sprint plan table — Model column for this issue (mirrors impl.ts)
 *   3. Default `sonnet` — sonnet adversarial bandwidth is the baseline
 *
 * State writes (this handler): review_session_id sentinel, review_round, previous_phase.
 * Orchestrator responsibility: replace review_session_id "pending:*" with real
 * session ID after spawn; delete review_session_id before re-entering review
 * for a new round (so the handler spawns a fresh reviewer rather than reading
 * the previous reviewer's verdict label).
 */
import { NO_REPO_ROOT, findModelInSprintPlan } from "@mcp-cli/core";
import { defineAlias, z } from "mcp-cli";
import { parsePrEditFlags } from "./phase-types";
import { runReview } from "./review-fn";

const ProviderSchema = z
  .string()
  .refine((v) => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"), {
    message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"',
  });

defineAlias({
  name: "phase-review",
  description: "Sprint phase: spawn adversarial reviewer or act on its review:pass/review:changes verdict label.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
    model: z.enum(["opus", "sonnet"]).optional(),
  }),
  output: z.object({
    action: z.enum(["spawn", "wait", "goto"]),
    target: z.enum(["repair", "qa", "needs-attention"]).optional(),
    reason: z.string(),
    round: z.number(),
    command: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
    model: z.enum(["opus", "sonnet"]).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-review requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.prNumber == null) missing.push("prNumber");
    if (work.branch == null) missing.push("branch");
    if (missing.length > 0) {
      throw new Error(
        `phase-review requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    return runReview(
      input,
      { id: work.id, prNumber: work.prNumber, branch: work.branch, issueNumber: work.issueNumber ?? null },
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
        findModelInSprintPlan,
      },
      ctx.repoRoot ?? NO_REPO_ROOT,
    );
  },
});
