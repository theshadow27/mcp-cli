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
import { mergePr, spawnWithTimeout } from "./done-fn";

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
        blockingLabels: z.array(z.string()).optional(),
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

    // Best-effort: resolve any open review threads before merge so the PR is visually clean.
    try {
      const prHandle = ctx.gh.pr(work.prNumber);
      const threads = await prHandle.reviewThreads();
      for (const t of threads.filter((t) => !t.isResolved)) {
        try {
          await prHandle.resolveReviewThread(t.id);
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* non-fatal — thread resolution is cosmetic; merge proceeds regardless */
    }

    const result = await mergePr(work.prNumber, {
      async gh(op) {
        try {
          if (op.op === "pr:labels") {
            const pr = await ctx.gh.pr(op.prNumber).body();
            return { stdout: pr.labels.join("\n"), stderr: "", exitCode: 0 };
          }
          if (op.op === "pr:checks") {
            const checks = await ctx.gh.pr(op.prNumber).checks();
            // Merge check-runs and legacy commit statuses; null (pending) counts as non-SUCCESS.
            const all = [...checks.check_runs, ...checks.commit_statuses];
            const failing = all.filter((c) => c.conclusion !== "SUCCESS");
            return { stdout: String(failing.length), stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
        } catch (err) {
          return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
        }
      },
      async prMerge(prNumber, flags) {
        try {
          const method = flags.includes("--squash")
            ? ("squash" as const)
            : flags.includes("--rebase")
              ? ("rebase" as const)
              : ("merge" as const);
          const deleteBranch = flags.includes("--delete-branch");
          await ctx.gh.pr(prNumber).merge({ method, deleteBranch });
          return { stdout: "", stderr: "", exitCode: 0 };
        } catch (err) {
          return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
        }
      },
      async prView(prNumber, _fields, _jqExpr?) {
        const pr = await ctx.gh.pr(prNumber).body();
        if (pr.merged) return "MERGED";
        return pr.state.toUpperCase();
      },
      async spawn(cmd, opts) {
        return spawnWithTimeout(cmd, opts);
      },
    });
    if (!result.ok) {
      // Surface blocking verdict labels to work-item state so the orchestrator
      // sees them without re-reading the PR (#2804).
      if (result.reason === "inconsistent_labels" && result.blockingLabels) {
        try {
          await ctx.state.set("merge_block_labels", result.blockingLabels.join(","));
        } catch {
          /* non-fatal — the error payload also carries the labels */
        }
      }
      return {
        merged: false,
        prNumber: work.prNumber,
        issueNumber: work.issueNumber,
        error: {
          reason: result.reason,
          nextAction: result.nextAction,
          detail: result.detail,
          ...(result.reason === "inconsistent_labels" && result.blockingLabels
            ? { blockingLabels: result.blockingLabels }
            : {}),
        },
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
      "artifact_check",
      "merge_block_labels",
    ]) {
      await ctx.state.delete(key);
    }

    const pullProc = Bun.spawn(["git", "pull"], { stdout: "pipe", stderr: "pipe" });
    const pullTimer = setTimeout(() => {
      try {
        pullProc.kill();
      } catch {}
    }, 60_000);
    const [_pullOut, pullStderr, pullExitCode] = await Promise.all([
      new Response(pullProc.stdout).text(),
      new Response(pullProc.stderr).text(),
      pullProc.exited,
    ]);
    clearTimeout(pullTimer);
    const pullWarning = pullExitCode !== 0 ? `git pull failed (exit ${pullExitCode}): ${pullStderr.trim()}` : undefined;
    const localCleanup = [result.localCleanup, pullWarning].filter(Boolean).join("; ") || undefined;

    return {
      merged: true,
      prNumber: work.prNumber,
      issueNumber: work.issueNumber,
      ...(localCleanup ? { localCleanup } : {}),
    };
  },
});
