import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { PHASE_CHANGED } from "@mcp-cli/core";
import type { CrossDomainWorkItems } from "./db/work-items";
import type { EventBus } from "./event-bus";

export interface DerivedCtx {
  /**
   * **Ring-0 work-item access, spanning every domain** (see `WorkItemDb.acrossDomains`).
   * Derived rules react to events from every project the daemon serves.
   */
  workItemDb: CrossDomainWorkItems;
  bus: EventBus;
}

/** Signal that the rule cannot apply yet but should be retried (e.g. work item not yet created). */
export interface DerivedPending {
  pending: true;
  reason: string;
}

export type DeriveResult = MonitorEventInput | DerivedPending | null;

export function isDerivedPending(r: DeriveResult): r is DerivedPending {
  return r !== null && "pending" in r && r.pending === true;
}

export interface DerivedRule {
  name: string;
  match: (event: MonitorEvent) => boolean;
  /** Mutates DB state and returns the event to emit, pending to retry, or null to skip. Publisher stamps src and causedBy. A rule returning `pending` must be safe to retry: either perform no side effects before returning pending, or ensure all mutations are idempotent. */
  apply: (event: MonitorEvent, ctx: DerivedCtx) => DeriveResult;
}

export const prMergedToDone: DerivedRule = {
  name: "pr-merged-to-done",
  match: (e) => e.event === "pr.merged" && typeof e.prNumber === "number",
  apply: (e, ctx) => {
    const prNumber = e.prNumber as number;
    // Every domain's item for this PR, not an arbitrary one: two projects can each have a
    // PR #7, and both should advance when theirs merges.
    const matches = ctx.workItemDb.findByPr(prNumber);
    if (matches.length === 0) return { pending: true, reason: `no work item for PR #${prNumber}` };
    const wi = matches.find((m) => m.phase === "qa");
    if (!wi) return null;
    ctx.workItemDb.forRow(wi).updateWorkItem(wi.id, { phase: "done" });
    return {
      src: "daemon.derived",
      event: PHASE_CHANGED,
      category: "work_item",
      workItemId: wi.id,
      prNumber,
      from: "qa",
      to: "done",
      reason: `pr.merged #${prNumber}`,
    };
  },
};

export const DEFAULT_RULES: DerivedRule[] = [prMergedToDone];
