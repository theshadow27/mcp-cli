import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { PHASE_CHANGED } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import type { EventBus } from "./event-bus";

export interface DerivedCtx {
  workItemDb: WorkItemDb;
  bus: EventBus;
}

export interface DerivedRule {
  name: string;
  match: (event: MonitorEvent) => boolean;
  /** Mutates DB state and returns the event to emit, or null to skip. Publisher stamps src and causedBy. */
  apply: (event: MonitorEvent, ctx: DerivedCtx) => MonitorEventInput | null;
}

export const prMergedToDone: DerivedRule = {
  name: "pr-merged-to-done",
  match: (e) => e.event === "pr.merged" && typeof e.prNumber === "number",
  apply: (e, ctx) => {
    const prNumber = e.prNumber as number;
    const wi = ctx.workItemDb.getWorkItemByPr(prNumber);
    if (!wi || wi.phase !== "qa") return null;
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
