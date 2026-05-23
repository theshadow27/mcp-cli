/** Core done-phase logic, extracted for testability via dependency injection. */

import type { GhOp, GhResult } from "./phase-types";
export type { GhOp, GhResult };

export interface ProcessHandle {
  kill(signal?: number): void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export type Spawner = (cmd: string[], opts: { stdout: "pipe"; stderr: "pipe" }) => ProcessHandle;

export interface SpawnTimeoutTestDeps {
  spawner?: Spawner;
  sigkillDelayMs?: number;
}

export async function spawnWithTimeout(
  cmd: string[],
  opts?: { timeoutMs?: number },
  _testDeps: SpawnTimeoutTestDeps = {},
): Promise<GhResult> {
  const spawner: Spawner =
    _testDeps.spawner ?? ((c, o) => Bun.spawn(c, o) as unknown as ProcessHandle);
  const sigkillDelayMs = _testDeps.sigkillDelayMs ?? 5_000;
  const proc = spawner(cmd, { stdout: "pipe", stderr: "pipe" });
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = opts?.timeoutMs
    ? setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        sigkillTimer = setTimeout(() => {
          try {
            proc.kill(9);
          } catch {}
        }, sigkillDelayMs);
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (sigkillTimer) clearTimeout(sigkillTimer);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

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
  gh(op: GhOp): Promise<GhResult>;
  prMerge(prNumber: number, flags: string[]): Promise<GhResult>;
  prView(prNumber: number, fields: string, jqExpr?: string): Promise<string>;
  spawn(cmd: string[], opts?: { timeoutMs?: number }): Promise<GhResult>;
}

export async function mergePr(prNumber: number, deps: MergePrDeps): Promise<MergeResult> {
  // Guard 1 + Guard 2 in parallel: fetch labels and CI status concurrently.
  const [labelOut, ciOut] = await Promise.all([
    deps.gh({ op: "pr:labels", prNumber }),
    deps.gh({ op: "pr:checks", prNumber }),
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

  const mergeResult = await deps.prMerge(prNumber, ["--squash", "--delete-branch"]);
  if (mergeResult.exitCode !== 0) {
    const stderr = mergeResult.stderr;
    // Check server state first — prMerge can fail client-side (SIGTERM, network)
    // while the server-side merge already completed. Also guards against concurrent
    // reruns: a second done invocation sees "not mergeable" from GitHub (PR already
    // merged) which would otherwise match the conflicts pattern below and incorrectly
    // spawn a rebase worker. prView is authoritative; pattern matching is only a
    // fallback when the PR is confirmed to not be merged.
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
      /* prView failed — fall through to deterministic error classification */
    }
    // Classify deterministic failures — only after confirming PR is not yet merged.
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
    return {
      ok: false,
      reason: "merge_failed",
      nextAction: "read the gh pr merge stderr and retry",
      detail: stderr,
    };
  }
  return { ok: true, prNumber };
}
