/** Core done-phase logic, extracted for testability via dependency injection. */

import type { GhResult } from "./gh";

export type MergeResult =
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

export interface MergePrDeps {
  gh(args: string[]): Promise<GhResult>;
  prMerge(prNumber: number, flags: string[]): Promise<GhResult>;
  prView(prNumber: number, fields: string, jqExpr?: string): Promise<string>;
  spawn(cmd: string[], opts?: { timeoutMs?: number }): Promise<GhResult>;
}

export async function mergePr(prNumber: number, deps: MergePrDeps): Promise<MergeResult> {
  // Guard 1 + Guard 2 in parallel: fetch labels and CI status concurrently.
  const [labelOut, ciOut] = await Promise.all([
    deps.gh(["pr", "view", String(prNumber), "--json", "labels", "-q", ".labels[].name"]),
    deps.gh([
      "pr", "view", String(prNumber),
      "--json", "statusCheckRollup",
      "-q", '[.statusCheckRollup[] | select(.conclusion != "SUCCESS")] | length',
    ]),
  ]);

  if (labelOut.exitCode !== 0) {
    return {
      ok: false,
      reason: "merge_failed",
      nextAction: `gh pr view labels failed for PR #${prNumber}; check gh auth and retry`,
      detail: labelOut.stderr,
    };
  }
  if (ciOut.exitCode !== 0) {
    return {
      ok: false,
      reason: "merge_failed",
      nextAction: `gh pr view statusCheckRollup failed for PR #${prNumber}; check gh auth and retry`,
      detail: ciOut.stderr,
    };
  }

  const labels = labelOut.stdout.split(/\r?\n/).map((l) => l.trim());
  if (!labels.includes("qa:pass")) {
    return {
      ok: false,
      reason: "missing_qa_pass",
      nextAction: `spawn qa for PR #${prNumber}; do not transition to done until qa:pass is set`,
    };
  }
  if (labels.includes("qa:fail")) {
    return {
      ok: false,
      reason: "missing_qa_pass",
      nextAction: `PR #${prNumber} has both qa:pass and qa:fail; remove the stale label before merge`,
    };
  }

  const ungreen = Number.parseInt(ciOut.stdout, 10);
  if (!Number.isFinite(ungreen) || ungreen > 0) {
    return {
      ok: false,
      reason: "ci_not_green",
      nextAction: `wait for CI to go green on PR #${prNumber}; rerun failing checks if flaky, otherwise send repair`,
    };
  }

  await deps.spawn(["git", "config", "core.bare", "false"]);

  const mergeResult = await deps.prMerge(prNumber, ["--squash", "--delete-branch"]);
  if (mergeResult.exitCode !== 0) {
    const stderr = mergeResult.stderr;
    // Classify deterministic failures first — no API round-trip needed.
    if (/not mergeable|conflict/i.test(stderr)) {
      return {
        ok: false,
        reason: "conflicts",
        nextAction: "spawn one-shot rebase worker for branch; do not rebase from orchestrator cwd",
        detail: stderr,
      };
    }
    if (/required check|required status/i.test(stderr)) {
      return {
        ok: false,
        reason: "missing_required_check",
        nextAction: "inspect branch-protection required checks; re-run the missing check",
        detail: stderr,
      };
    }
    // Outcome unknown — poll state. gh (Go binary) may exit 1 after SIGTERM
    // when the HTTP request already completed server-side. In all interrupt
    // cases --delete-branch never finishes client-side, so always signal that
    // cleanup is incomplete regardless of the specific error.
    try {
      const stateOut = await deps.prView(prNumber, "state", ".state");
      if (stateOut === "MERGED") {
        const worktreeHeld = /used by worktree|cannot delete branch.*checked out/i.test(stderr);
        return {
          ok: true,
          prNumber,
          localCleanup: worktreeHeld
            ? "skipped: worktree holds branch (bye impl session to prune)"
            : "branch delete incomplete: gh interrupted before client-side cleanup; prune impl branch manually",
        };
      }
    } catch {
      /* prView failed — fall through to merge_failed */
    }
    return {
      ok: false,
      reason: "merge_failed",
      nextAction: "read the gh pr merge stderr and retry",
      detail: stderr,
    };
  }
  return { ok: true, prNumber };
}
