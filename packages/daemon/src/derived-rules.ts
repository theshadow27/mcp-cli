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
    // A PR number does not name a row. Two projects can each have a PR #7 — the unique
    // index is `(domain_id, pr_number)` precisely so they can — and each should advance
    // only when *its own* PR merges. `findByPr` hands back every domain's match on
    // purpose; picking by position out of that list is how a merge in one project used to
    // close another project's work item (#3353). The event's domain is the selector.
    const matches = ctx.workItemDb.findByPr(prNumber);
    const inDomain = matches.filter((m) => m.domainId === e.domainId);
    if (inDomain.length === 0) {
      // Deliberately not "fall back to the only match": the rows this event may not touch
      // are exactly the ones a fallback would reach. Retrying is for the row that has not
      // been created yet; a foreign-domain row is never this event's to advance.
      const elsewhere = matches.length > 0 ? ` (${matches.length} in other domains)` : "";
      const where = e.domain ?? `domain ${e.domainId}`;
      return { pending: true, reason: `no work item for PR #${prNumber} in ${where}${elsewhere}` };
    }
    const wi = inDomain.find((m) => m.phase === "qa");
    if (!wi) return null;
    ctx.workItemDb.forRow(wi).updateWorkItem(wi.id, { phase: "done" });
    return {
      src: "daemon.derived",
      event: PHASE_CHANGED,
      category: "work_item",
      // The item's domain, stated rather than left to the bus to infer from the daemon's cwd.
      domainId: wi.domainId,
      workItemId: wi.id,
      prNumber,
      from: "qa",
      to: "done",
      reason: `pr.merged #${prNumber}`,
    };
  },
};

export const DEFAULT_RULES: DerivedRule[] = [prMergedToDone];
