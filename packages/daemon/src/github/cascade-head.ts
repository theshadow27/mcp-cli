/**
 * Cascade head selection for auto-merge serialization.
 *
 * When branch protection requires PRs to be up-to-date before merging,
 * only one PR should have its branch updated at a time to avoid N² CI cost.
 * This module selects the single best PR to update next (the "cascade head").
 *
 * Algorithm (#1581):
 *   1. Consider only open PRs with auto-merge armed.
 *   2. Prefer CLEAN PRs (already up-to-date) — earliest updatedAt wins (FIFO).
 *   3. Else prefer BEHIND PRs (need an update) — earliest updatedAt wins.
 *   4. Else null — no actionable PR.
 */

import type { MergeStateStatus } from "@mcp-cli/core";

export interface MergeStatePR {
  prNumber: number;
  mergeStateStatus: MergeStateStatus;
  autoMergeEnabled: boolean;
  /** ISO 8601 timestamp used for FIFO tiebreak. */
  updatedAt: string;
}

/**
 * Compute the cascade head: the PR number the orchestrator should update-branch next.
 * Returns null if no PR qualifies (no auto-merge armed, or all are DIRTY/BLOCKED/etc.).
 */
export function computeCascadeHead(prs: readonly MergeStatePR[]): number | null {
  const armed = prs.filter((p) => p.autoMergeEnabled);
  if (armed.length === 0) return null;

  const clean = armed.filter((p) => p.mergeStateStatus === "CLEAN");
  if (clean.length > 0) return earliest(clean).prNumber;

  const behind = armed.filter((p) => p.mergeStateStatus === "BEHIND");
  if (behind.length > 0) return earliest(behind).prNumber;

  return null;
}

function earliest(prs: MergeStatePR[]): MergeStatePR {
  return prs.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
}
