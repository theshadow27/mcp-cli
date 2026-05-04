/**
 * Phase: review — adversarial review for high-scrutiny PRs.
 *
 * On first entry: emits the spawn plan for the reviewer.
 * On re-entry (review_session_id already set): scans the PR for the sticky
 *   `## Adversarial Review` comment and decides the transition.
 *     - no comment yet         → { action: "wait" }
 *     - 🔴 or 🟡 present       → { action: "goto", target: "repair" } (with round cap)
 *     - all ✅ / no blockers    → { action: "goto", target: "qa" }
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
 * the previous reviewer's comment).
 */
import { NO_REPO_ROOT, findModelInSprintPlan } from "@mcp-cli/core";
import { defineAlias, z } from "mcp-cli";
import { gh } from "./gh";
import { runReview } from "./review-fn";

const ProviderSchema = z
  .string()
  .refine(
    (v) => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"),
    { message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"' },
  );

defineAlias({
  name: "phase-review",
  description: "Sprint phase: spawn adversarial reviewer or act on its sticky comment.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
    model: z.enum(["opus", "sonnet"]).optional(),
  }),
  output: z.object({
    action: z.enum(["spawn", "wait", "goto"]),
    target: z.enum(["repair", "qa"]).optional(),
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
      { gh, findModelInSprintPlan },
      ctx.repoRoot ?? NO_REPO_ROOT,
    );
  },
});
