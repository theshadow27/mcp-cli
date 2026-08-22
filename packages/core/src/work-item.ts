/**
 * Work item types, state machine, and event definitions.
 *
 * A work item tracks the lifecycle of a branch/PR/CI pipeline as daemon-managed state.
 * Sessions reference work items via issue_number or pr_number — work items have no
 * knowledge of sessions.
 *
 * Phase 1a of #1049.
 */

import { NO_DOMAIN_ID } from "./domain";

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
  /**
   * Primary key — e.g. "#1135" (number-tracked) or "branch:feat/foo" (branch-tracked).
   *
   * Globally unique, and **guessable**: `#42` is the id of issue 42 in every domain that
   * happens to have used it first. That is why {@link WorkItem.domainId} is part of every
   * lookup rather than an attribute read off the row afterwards — an id alone is not an
   * authorization to read the row.
   */
  id: string;
  /**
   * Owning domain (`domains.id`), or `NO_DOMAIN_ID` (0) for rows written before any
   * domain was resolved. Per-domain uniqueness of `issueNumber` / `branch` / `prNumber`
   * is what lets two projects each track issue #42 (#3034).
   *
   * Deliberately absent from {@link WorkItemPatch}: an update can change what a work item
   * *is*, never which domain owns it. Re-homing a row would silently collide with the
   * target domain's own #42.
   */
  domainId: number;
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

/**
 * Qualify a derived work-item id with its owning domain.
 *
 * Work-item ids are *derived* from the thing they track (`#42`, `issue:42`, `pr:7`,
 * `branch:fix/foo`) and are the table's global primary key. Two domains tracking issue 42
 * would therefore derive the same id and collide on the PK — the per-domain UNIQUE indexes
 * from #3034 are not enough on their own, because they constrain `issue_number`, not `id`.
 *
 * `NO_DOMAIN_ID` is returned unchanged. That is the whole migration story: with no domain
 * registered, every id is byte-identical to what this repo has always minted, so nothing
 * that stored a work-item id anywhere (phase state namespaces, orchestrator scripts,
 * `mcx tracked` output) has to know this function exists.
 */
export function domainScopedWorkItemId(domainId: number, baseId: string): string {
  return domainId === NO_DOMAIN_ID ? baseId : `d${domainId}:${baseId}`;
}

/**
 * The candidate ids a lookup inside `domainId` should try, **most-specific first**.
 *
 * A caller inside domain 3 that asks for `#42` means *its own* `#42`, which is stored as
 * `d3:#42`. Both candidates are still filtered by `domain_id` at the query, so this widens
 * the spelling of an id and never the partition it can reach.
 *
 * Order matters twice. The domain-qualified spelling is what rows are actually stored under,
 * so trying it first turns the common case into one query instead of two. It is also the
 * unambiguous answer: an unqualified `#42` is what a caller *typed*, while `d3:#42` is what
 * the table holds, and if some row somehow carried the literal id `#42` inside domain 3 the
 * qualified row is still the one that caller meant.
 */
export function workItemIdCandidates(domainId: number, id: string): string[] {
  const scoped = domainScopedWorkItemId(domainId, id);
  if (scoped === id) return [id];
  // Already qualified for this domain — the phase runner and every tool response hand back
  // stored ids, so this is the common path. Re-qualifying would only add a guaranteed miss
  // to step over before the real hit.
  if (id.startsWith(`d${domainId}:`)) return [id];
  return [scoped, id];
}

/**
 * The `alias_state` namespace holding a work item's phase-scoped key-value store.
 *
 * **`workItemId` must be the canonical stored id** — the `id` off a row the database
 * returned, never the spelling a caller typed. Since ids became domain-qualified, `#42` and
 * `d1:#42` name the same row but are different strings, so building this namespace from the
 * raw argument writes to a different namespace than the phase runner reads from, and both
 * sides succeed silently. That is a split state store, not an error anyone would see.
 *
 * This function exists so the namespace is spelled once rather than in the nine places that
 * previously hand-built it across four files. Callers that hold only a caller-supplied id
 * must resolve it through the database first.
 */
export function workItemStateNamespace(workItemId: string): string {
  return `workitem:${workItemId}`;
}

/**
 * Updatable subset of WorkItem — excludes server-managed fields.
 *
 * `domainId` is excluded on purpose and not by oversight: there is no patch, no MCP tool
 * argument, and no IPC parameter that moves a work item between domains. A caller holding
 * a domain-scoped handle can only write inside its own partition.
 */
export type WorkItemPatch = Partial<Omit<WorkItem, "id" | "domainId" | "createdAt" | "updatedAt" | "version">>;

/**
 * Create a new in-memory WorkItem with sensible defaults.
 *
 * `domainId` is **required and comes first**, ahead of the optional `phase`. A partition key
 * with a default is the shape this whole epic exists to remove: the caller never has to
 * decide, so the sentinel becomes what you get by not thinking about it, and the mistake is
 * invisible at the call site. Required, `tsc` names every caller that has to choose.
 *
 * Pass `NO_DOMAIN_ID` explicitly for an item that genuinely belongs to no domain — that is a
 * decision, and it should read like one.
 */
export function createWorkItem(id: string, domainId: number, phase?: WorkItemPhase): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    domainId,
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
