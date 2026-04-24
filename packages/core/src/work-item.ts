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
  phase: WorkItemPhase;
  createdAt: string;
  updatedAt: string;
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
  | { type: "phase:changed"; itemId: string; from: WorkItemPhase; to: WorkItemPhase };

/**
 * Valid phase transitions. Each key maps to the set of phases reachable from it.
 *
 * The graph is intentionally permissive — repair can loop back to review,
 * and any active phase can jump to done (e.g. issue dropped or PR merged).
 */
const VALID_TRANSITIONS: Record<WorkItemPhase, ReadonlySet<WorkItemPhase>> = {
  impl: new Set(["review", "qa", "done"]),
  review: new Set(["repair", "qa", "done"]),
  repair: new Set(["review", "done"]),
  qa: new Set(["repair", "done"]),
  done: new Set(), // terminal
};

/** Check whether a phase transition is allowed. */
export function canTransition(from: WorkItemPhase, to: WorkItemPhase): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all phases reachable from the given phase. */
export function reachablePhases(from: WorkItemPhase): readonly WorkItemPhase[] {
  return [...VALID_TRANSITIONS[from]] as WorkItemPhase[];
}

/** All work item phases in pipeline order. */
export const WORK_ITEM_PHASES: readonly WorkItemPhase[] = ["impl", "review", "repair", "qa", "done"];

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
    phase: phase ?? "impl",
    createdAt: now,
    updatedAt: now,
  };
}
