import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { PHASE_CHANGED } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import type { EventBus } from "./event-bus";

export interface DerivedCtx {
  workItemDb: WorkItemDb;
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
    const wi = ctx.workItemDb.getWorkItemByPr(prNumber);
    if (!wi) return { pending: true, reason: `no work item for PR #${prNumber}` };
    if (wi.phase !== "qa") return null;
    ctx.workItemDb.updateWorkItem(wi.id, { phase: "done" });
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
