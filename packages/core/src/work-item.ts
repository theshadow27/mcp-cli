/**
 * Work item types, state machine, and event definitions.
 *
 * A work item tracks the lifecycle of a branch/PR/CI pipeline as daemon-managed state.
 * Sessions reference work items via issue_number or pr_number — work items have no
 * knowledge of sessions.
 *
 * Phase 1a of #1049.
 */

/** Pipeline phase for a work item. */
export type WorkItemPhase = "impl" | "review" | "repair" | "qa" | "done";

/** CI check status. */
export type CiStatus = "none" | "pending" | "running" | "passed" | "failed";

/** Pull request state. */
export type PrState = "draft" | "open" | "merged" | "closed";

/** GitHub merge state status for a pull request. */
export type MergeStateStatus = "CLEAN" | "BEHIND" | "DIRTY" | "BLOCKED" | "HAS_HOOKS" | "UNSTABLE" | "UNKNOWN";

/** Code review status. */
export type ReviewStatus = "none" | "pending" | "approved" | "changes_requested";

/** A tracked work item matching the SQLite schema from #1049. */
export interface WorkItem {
  /** Primary key — e.g. "#1135" (number-tracked) or "branch:feat/foo" (branch-tracked). */
  id: string;
  issueNumber: number | null;
  branch: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  ciStatus: CiStatus;
  ciRunId: number | null;
  ciSummary: string | null;
  reviewStatus: ReviewStatus;
  mergeStateStatus: MergeStateStatus | null;
  phase: WorkItemPhase;
  automationOverrides: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Discriminated union of work item lifecycle events. */
export type WorkItemEvent =
  | {
      type: "pr:opened";
      prNumber: number;
      branch: string;
      base: string;
      commits: number;
      srcChurn: number;
      filesTruncated?: boolean;
    }
  | {
      type: "pr:pushed";
      prNumber: number;
      branch: string;
      base: string;
      commits: number;
      srcChurn: number;
      filesTruncated?: boolean;
    }
  | { type: "pr:merged"; prNumber: number; mergeSha: string | null }
  | { type: "pr:closed"; prNumber: number }
  | { type: "checks:started"; prNumber: number; runId?: number }
  | { type: "checks:passed"; prNumber: number }
  | { type: "checks:failed"; prNumber: number; failedJob: string }
  | { type: "review:approved"; prNumber: number }
  | { type: "review:changes_requested"; prNumber: number; reviewer: string }
  | { type: "phase:changed"; itemId: string; from: WorkItemPhase; to: WorkItemPhase }
  | {
      type: "pr:merge_state_changed";
      prNumber: number;
      from: MergeStateStatus | null;
      to: MergeStateStatus;
      cascadeHead: number | null;
    };

/**
 * Valid phase transitions. Each key maps to the set of phases reachable from it.
 *
 * The graph is intentionally permissive — repair can loop back to review,
 * and any active phase can jump to done (e.g. issue dropped or PR merged).
 */
const VALID_TRANSITIONS: Record<WorkItemPhase, ReadonlySet<WorkItemPhase>> = {
  impl: new Set(["review", "qa", "done"]),
  review: new Set(["repair", "qa", "done"]),
  repair: new Set(["review", "qa", "done"]),
  qa: new Set(["repair", "done"]),
  done: new Set(), // terminal
};

/** Check whether a phase transition is allowed. Returns false for unknown phases. */
export function canTransition(from: WorkItemPhase, to: WorkItemPhase): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/** Return all phases reachable from the given phase. Empty for unknown phases. */
export function reachablePhases(from: WorkItemPhase): readonly WorkItemPhase[] {
  const transitions = VALID_TRANSITIONS[from];
  return transitions ? ([...transitions] as WorkItemPhase[]) : [];
}

/** All work item phases in pipeline order. */
export const WORK_ITEM_PHASES: readonly WorkItemPhase[] = ["impl", "review", "repair", "qa", "done"];

const WORK_ITEM_PHASE_SET: ReadonlySet<string> = new Set(WORK_ITEM_PHASES);

/** Check whether a phase string is one of the hardcoded standard phases. */
export function isStandardPhase(phase: string): phase is WorkItemPhase {
  return WORK_ITEM_PHASE_SET.has(phase);
}

/**
 * Phase-runner-owned state keys that drive merge-gate security and loop-bound
 * integrity decisions. These are written exclusively by the daemon-controlled
 * phase runner (`mcx phase run` → ctx.state → IPC aliasStateSet), never by a
 * session or the orchestrator through the `phase_state_set` MCP tool.
 *
 * The session-facing `phase_state_set` / `phase_state_delete` tools MUST refuse
 * to write or delete a reserved key (#2682): both the phase runner and the MCP
 * tool write the same `workitem:<id>` namespace, so without this guard any
 * session with Bash can shell out to `mcx call _work_items phase_state_set` and
 * forge a sentinel — e.g. setting `review_spawned_at` to epoch-start makes any
 * stale verdict label pass the #2652 freshness guard, or zeroing a `*_round`
 * counter bypasses the "two reviews max" / QA fail-cap loop bounds.
 *
 * Reserved patterns:
 *   - `*_spawned_at`   — session-spawn timestamp; load-bearing for verdict freshness
 *   - `*_round`        — round-cap counters (review_round, repair_round, qa_fail_round)
 *   - `previous_phase` — transition provenance
 *
 * NOT reserved: the `*_session_id` family (session_id, review_session_id,
 * repair_session_id, qa_session_id). The orchestrator legitimately writes those
 * via the MCP tool to replace the phase runner's `pending:*` sentinel with the
 * real session id, and deletes them between rounds.
 */
export function isReservedPhaseStateKey(key: string): boolean {
  return key.endsWith("_spawned_at") || key.endsWith("_round") || key === "previous_phase";
}

/** Updatable subset of WorkItem — excludes server-managed fields. */
export type WorkItemPatch = Partial<Omit<WorkItem, "id" | "createdAt" | "updatedAt" | "version">>;

/** Create a new WorkItem with sensible defaults. */
export function createWorkItem(id: string, phase?: WorkItemPhase): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    issueNumber: null,
    branch: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    ciStatus: "none",
    ciRunId: null,
    ciSummary: null,
    reviewStatus: "none",
    mergeStateStatus: null,
    phase: phase ?? "impl",
    automationOverrides: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
