/**
 * Phase: done — terminal. Merge the PR, mark the work item done.
 *
 * Named failure modes (per #1284 spec): on any pre-merge guard failure,
 * return a structured error describing the single next action the operator
 * should take instead of transitioning.
 *
 * Success side effects: squash-merge (delete branch), update work item
 * phase=done, git pull on main (safe — runsOn=main guarantees cwd), clear
 * per-work-item scratchpad. The orchestrator handles untracking via the
 * work_items MCP once phase=done is observed — this handler does not call
 * untrack directly.
 */
import { defineAlias, z } from "mcp-cli";
import { gh, prMerge, prView, spawn } from "./gh";
import { mergePr } from "./done-fn";

defineAlias({
  name: "phase-done",
  description: "Sprint phase: terminal. Merge PR, close out work item.",
  input: z.object({}).default({}),
  output: z.object({
    merged: z.boolean(),
    prNumber: z.number(),
    issueNumber: z.number(),
    localCleanup: z.string().optional(),
    error: z
      .object({
        reason: z.string(),
        nextAction: z.string(),
        detail: z.string().optional(),
      })
      .optional(),
  }),
  fn: async (_input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-done requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.prNumber == null) missing.push("prNumber");
    if (work.issueNumber == null) missing.push("issueNumber");
    if (missing.length > 0) {
      throw new Error(
        `phase-done requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    const result = await mergePr(work.prNumber, { gh, prMerge, prView, spawn });
    if (!result.ok) {
      return {
        merged: false,
        prNumber: work.prNumber,
        issueNumber: work.issueNumber,
        error: { reason: result.reason, nextAction: result.nextAction, detail: result.detail },
      };
    }

    try {
      await ctx.mcp._work_items.work_items_update({ id: work.id, phase: "done" });
    } catch {
      /* non-fatal — orchestrator retries via CLI */
    }

    // Clean scratchpad — work item is closed.
    for (const key of [
      "session_id",
      "review_session_id",
      "repair_session_id",
      "qa_session_id",
      "worktree_path",
      "triage_scrutiny",
      "triage_reasons",
      "review_round",
      "repair_round",
      "repair_prompt",
      "qa_fail_round",
      "previous_phase",
      "provider",
      "labels",
      "model",
      "review_model",
    ]) {
      await ctx.state.delete(key);
    }

    const pull = await spawn(["git", "pull"], { timeoutMs: 60_000 });
    const pullWarning = pull.exitCode !== 0 ? `git pull failed (exit ${pull.exitCode}): ${pull.stderr}` : undefined;
    const localCleanup = [result.localCleanup, pullWarning].filter(Boolean).join("; ") || undefined;

    return {
      merged: true,
      prNumber: work.prNumber,
      issueNumber: work.issueNumber,
      ...(localCleanup ? { localCleanup } : {}),
    };
  },
});
