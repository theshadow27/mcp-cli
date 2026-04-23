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

type MergeResult =
  | { ok: true; prNumber: number; localCleanup?: string }
  | {
      ok: false;
      reason:
        | "ci_not_green"
        | "missing_qa_pass"
        | "conflicts"
        | "missing_required_check"
        | "merge_failed";
      nextAction: string;
      detail?: string;
    };

function mergePr(prNumber: number): MergeResult {
  // Guard 1: qa:pass label must exist.
  const labelProc = Bun.spawnSync({
    cmd: ["gh", "pr", "view", String(prNumber), "--json", "labels", "-q", ".labels[].name"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const labels = new TextDecoder().decode(labelProc.stdout).split(/\r?\n/).map((l) => l.trim());
  if (!labels.includes("qa:pass")) {
    return {
      ok: false,
      reason: "missing_qa_pass",
      nextAction: `spawn qa for PR #${prNumber}; do not transition to done until qa:pass is set`,
    };
  }
  // Guard 1b: qa:fail must not also be present. Stale qa:fail from an
  // earlier round means label hygiene failed upstream (see #1303) — block
  // merge so operator can investigate which verdict is authoritative.
  if (labels.includes("qa:fail")) {
    return {
      ok: false,
      reason: "missing_qa_pass",
      nextAction: `PR #${prNumber} has both qa:pass and qa:fail; remove the stale label before merge`,
    };
  }

  // Guard 2: CI must be green (belt + suspenders — branch protection also enforces).
  const ciProc = Bun.spawnSync({
    cmd: [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--json",
      "statusCheckRollup",
      "-q",
      "[.statusCheckRollup[] | select(.conclusion != \"SUCCESS\")] | length",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const ungreen = Number.parseInt(new TextDecoder().decode(ciProc.stdout).trim(), 10);
  // Default-deny: treat unparseable output (NaN) as "not green" — empty
  // stdout means checks are pending or gh hiccuped; either way, block merge.
  if (!Number.isFinite(ungreen) || ungreen > 0) {
    return {
      ok: false,
      reason: "ci_not_green",
      nextAction: `wait for CI to go green on PR #${prNumber}; rerun failing checks if flaky, otherwise send repair`,
    };
  }

  // Belt: clear core.bare flip before git ops (#1330 recurrence).
  Bun.spawnSync({ cmd: ["git", "config", "core.bare", "false"] });

  const mergeProc = Bun.spawnSync({
    cmd: ["gh", "pr", "merge", String(prNumber), "--squash", "--delete-branch"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (mergeProc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(mergeProc.stderr);
    // Local branch delete fails when an impl worktree holds the branch open.
    // The GitHub merge may have already succeeded — check before reporting failure.
    if (/used by worktree|cannot delete branch.*checked out/i.test(stderr)) {
      const viewProc = Bun.spawnSync({
        cmd: ["gh", "pr", "view", String(prNumber), "--json", "state", "-q", ".state"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (new TextDecoder().decode(viewProc.stdout).trim() === "MERGED") {
        return {
          ok: true,
          prNumber,
          localCleanup: "skipped: worktree holds branch (bye impl session to prune)",
        };
      }
    }
    if (/not mergeable|conflict/i.test(stderr)) {
      return {
        ok: false,
        reason: "conflicts",
        nextAction: `spawn one-shot rebase worker for branch; do not rebase from orchestrator cwd`,
        detail: stderr.trim(),
      };
    }
    if (/required check|required status/i.test(stderr)) {
      return {
        ok: false,
        reason: "missing_required_check",
        nextAction: "inspect branch-protection required checks; re-run the missing check",
        detail: stderr.trim(),
      };
    }
    return {
      ok: false,
      reason: "merge_failed",
      nextAction: "read the gh pr merge stderr and retry",
      detail: stderr.trim(),
    };
  }
  return { ok: true, prNumber };
}

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

    const result = mergePr(work.prNumber);
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
      "qa_fail_round",
      "previous_phase",
      "provider",
      "labels",
      "model",
    ]) {
      await ctx.state.delete(key);
    }

    Bun.spawnSync({ cmd: ["git", "config", "core.bare", "false"] });
    Bun.spawnSync({ cmd: ["git", "pull"] });

    return {
      merged: true,
      prNumber: work.prNumber,
      issueNumber: work.issueNumber,
      ...(result.localCleanup ? { localCleanup: result.localCleanup } : {}),
    };
  },
});
