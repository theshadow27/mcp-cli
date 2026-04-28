import {
  COST_SESSION_OVER_BUDGET,
  COST_SPRINT_OVER_BUDGET,
  QUOTA_UTILIZATION_THRESHOLD,
  SESSION_ENDED,
  SESSION_IDLE,
  SESSION_RESULT,
} from "@mcp-cli/core";
import type { BudgetConfig, MonitorEvent } from "@mcp-cli/core";
import type { StateDb } from "./db/state";
import type { EventBus } from "./event-bus";
import type { QuotaPoller } from "./quota";

interface SessionCostState {
  cost: number;
  fired: boolean;
  workItemId?: string;
}

const SESSION_EVENTS: ReadonlySet<string> = new Set([SESSION_RESULT, SESSION_IDLE, SESSION_ENDED]);

const DEFAULT_QUOTA_POLL_MS = 60_000;

export class BudgetWatcher {
  private readonly bus: EventBus;
  private readonly db: StateDb;
  private readonly quotaPoller: QuotaPoller;
  private readonly subId: number;
  private readonly sessionCosts = new Map<string, SessionCostState>();
  private sprintFired = false;
  private readonly quotaArmed = new Map<number, boolean>();
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: {
    bus: EventBus;
    db: StateDb;
    quotaPoller: QuotaPoller;
    quotaPollIntervalMs?: number;
  }) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.quotaPoller = opts.quotaPoller;

    const config = this.db.getBudgetConfig();
    for (const t of config.quotaThresholds) {
      this.quotaArmed.set(t, true);
    }

    this.subId = this.bus.subscribe((event) => this.handleEvent(event));

    const pollMs = opts.quotaPollIntervalMs ?? DEFAULT_QUOTA_POLL_MS;
    this.quotaTimer = setInterval(() => this.checkQuota(), pollMs);
    this.quotaTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.bus.unsubscribe(this.subId);
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  private handleEvent(event: MonitorEvent): void {
    if (!SESSION_EVENTS.has(event.event)) return;
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    if (!sessionId) return;

    if (event.event === SESSION_ENDED) {
      this.sessionCosts.delete(sessionId);
      return;
    }

    const cost = typeof event.cost === "number" ? event.cost : 0;
    if (cost <= 0) return;

    const workItemId = typeof event.workItemId === "string" ? event.workItemId : undefined;
    const config = this.db.getBudgetConfig();
    this.checkSessionBudget(config, sessionId, cost, workItemId);
    this.checkSprintBudget(config);
  }

  private checkSessionBudget(config: BudgetConfig, sessionId: string, cost: number, workItemId?: string): void {
    let state = this.sessionCosts.get(sessionId);
    if (!state) {
      state = { cost: 0, fired: false, workItemId };
      this.sessionCosts.set(sessionId, state);
    }

    state.cost = cost;
    if (workItemId) state.workItemId = workItemId;

    if (cost >= config.sessionCap && !state.fired) {
      state.fired = true;
      this.bus.publish({
        src: "daemon.budget-watcher",
        event: COST_SESSION_OVER_BUDGET,
        category: "cost",
        sessionId,
        workItemId: state.workItemId,
        cost,
        limit: config.sessionCap,
      });
    }
  }

  private checkSprintBudget(config: BudgetConfig): void {
    const cutoffMs = Date.now() - config.sprintWindowMs;
    const { totalCost, sessionCount } = this.db.sprintCostSince(cutoffMs);

    if (totalCost >= config.sprintCap && !this.sprintFired) {
      this.sprintFired = true;
      this.bus.publish({
        src: "daemon.budget-watcher",
        event: COST_SPRINT_OVER_BUDGET,
        category: "cost",
        totalCost,
        limit: config.sprintCap,
        sessionCount,
      });
    } else if (totalCost < config.sprintCap && this.sprintFired) {
      this.sprintFired = false;
    }
  }

  checkQuota(): void {
    if (this.disposed) return;
    const status = this.quotaPoller.status;
    if (!status?.fiveHour) return;

    const utilization = status.fiveHour.utilization;
    const config = this.db.getBudgetConfig();

    for (const t of config.quotaThresholds) {
      if (!this.quotaArmed.has(t)) this.quotaArmed.set(t, true);
    }

    for (const threshold of config.quotaThresholds) {
      const armed = this.quotaArmed.get(threshold) ?? true;

      if (utilization >= threshold && armed) {
        this.quotaArmed.set(threshold, false);
        this.bus.publish({
          src: "daemon.budget-watcher",
          event: QUOTA_UTILIZATION_THRESHOLD,
          category: "quota",
          provider: "anthropic",
          utilization,
          threshold,
          windowEnd: status.fiveHour.resetsAt,
        });
      } else if (utilization < threshold - config.quotaDeadband && !armed) {
        this.quotaArmed.set(threshold, true);
      }
    }
  }
}
