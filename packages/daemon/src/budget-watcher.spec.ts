import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import {
  COST_SESSION_OVER_BUDGET,
  COST_SPRINT_OVER_BUDGET,
  QUOTA_UTILIZATION_THRESHOLD,
  SESSION_ENDED,
  SESSION_IDLE,
  SESSION_RESULT,
} from "@mcp-cli/core";
import { BudgetWatcher } from "./budget-watcher";
import { StateDb } from "./db/state";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import type { QuotaPoller, QuotaStatus } from "./quota";

const dbPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `mcp-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  return p;
}

function cleanupDbs(): void {
  for (const p of dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
  dbPaths.length = 0;
}

function makeDb(): StateDb {
  return new StateDb(tmpDbPath());
}

interface FakeQuotaPoller {
  status: QuotaStatus | null;
}

function fakeQuotaPoller(status: QuotaStatus | null = null): FakeQuotaPoller & QuotaPoller {
  return { status, start() {}, stop() {} } as unknown as FakeQuotaPoller & QuotaPoller;
}

function sessionResultEvent(sessionId: string, cost: number, workItemId?: string): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_RESULT,
    category: "session",
    sessionId,
    cost,
    numTurns: 1,
    tokens: 1000,
    ...(workItemId ? { workItemId } : {}),
  };
}

function sessionIdleEvent(sessionId: string, cost: number): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_IDLE,
    category: "session",
    sessionId,
    cost,
  };
}

function sessionEndedEvent(sessionId: string): MonitorEventInput {
  return {
    src: "daemon.claude-server",
    event: SESSION_ENDED,
    category: "session",
    sessionId,
  };
}

function collectEvents(bus: EventBus, eventName: string): MonitorEvent[] {
  const events: MonitorEvent[] = [];
  bus.subscribe((e) => {
    if (e.event === eventName) events.push(e);
  });
  return events;
}

// ── Session cost tests ──

describe("BudgetWatcher — session cost", () => {
  let watcher: BudgetWatcher;

  afterEach(() => {
    watcher?.dispose();
    cleanupDbs();
  });

  test("fires cost.session_over_budget exactly once when cost crosses threshold", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 2.0 });

    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 1.5));
    expect(events).toHaveLength(0);

    bus.publish(sessionResultEvent("s1", 2.0));
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("s1");
    expect(events[0].cost).toBe(2.0);
    expect(events[0].limit).toBe(2.0);

    bus.publish(sessionResultEvent("s1", 3.5));
    expect(events).toHaveLength(1);
  });

  test("different sessions get independent threshold tracking", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 1.0 });

    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 1.5));
    bus.publish(sessionResultEvent("s2", 0.5));
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("s1");

    bus.publish(sessionResultEvent("s2", 1.5));
    expect(events).toHaveLength(2);
    expect(events[1].sessionId).toBe("s2");
  });

  test("session.ended cleans up tracking state", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 2.0 });

    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 2.5));
    expect(events).toHaveLength(1);

    bus.publish(sessionEndedEvent("s1"));

    bus.publish(sessionResultEvent("s1", 2.5));
    expect(events).toHaveLength(2);
  });

  test("includes workItemId in emitted event", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 1.0 });

    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 2.0, "#1441"));
    expect(events).toHaveLength(1);
    expect(events[0].workItemId).toBe("#1441");
  });

  test("uses default config when none set", () => {
    const bus = new EventBus();
    const db = makeDb();
    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 3.0));
    expect(events).toHaveLength(1);
    expect(events[0].limit).toBe(3.0);
  });

  test("SESSION_IDLE triggers session budget check", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 2.0 });

    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionIdleEvent("s1", 1.0));
    expect(events).toHaveLength(0);

    bus.publish(sessionIdleEvent("s1", 2.5));
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("s1");
    expect(events[0].cost).toBe(2.5);
    expect(events[0].limit).toBe(2.0);
  });
});

// ── Sprint cost tests ──

describe("BudgetWatcher — sprint cost", () => {
  let watcher: BudgetWatcher;

  afterEach(() => {
    watcher?.dispose();
    cleanupDbs();
  });

  test("fires cost.sprint_over_budget based on active session costs", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sprintCap: 5.0 });

    db.upsertSession({ sessionId: "s1", state: "active" });
    db.updateSessionCost("s1", 3.0, 1000);
    db.upsertSession({ sessionId: "s2", state: "active" });
    db.updateSessionCost("s2", 2.5, 500);

    const events = collectEvents(bus, COST_SPRINT_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 3.0));
    expect(events).toHaveLength(1);
    expect(events[0].totalCost).toBeGreaterThanOrEqual(5.0);
    expect(events[0].limit).toBe(5.0);
    expect(events[0].sessionCount).toBeGreaterThanOrEqual(2);
  });

  test("fires only once per crossing", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sprintCap: 5.0 });

    db.upsertSession({ sessionId: "s1", state: "active" });
    db.updateSessionCost("s1", 6.0, 1000);

    const events = collectEvents(bus, COST_SPRINT_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 6.0));
    bus.publish(sessionResultEvent("s1", 7.0));
    expect(events).toHaveLength(1);
  });

  test("re-arms when total drops below threshold", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ sprintCap: 5.0 });

    db.upsertSession({ sessionId: "s1", state: "active" });
    db.updateSessionCost("s1", 6.0, 1000);

    const events = collectEvents(bus, COST_SPRINT_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    bus.publish(sessionResultEvent("s1", 6.0));
    expect(events).toHaveLength(1);

    db.updateSessionCost("s1", 2.0, 500);
    bus.publish(sessionResultEvent("s1", 2.0));

    db.updateSessionCost("s1", 6.0, 1500);
    bus.publish(sessionResultEvent("s1", 6.0));
    expect(events).toHaveLength(2);
  });
});

// ── Quota hysteresis tests ──

describe("BudgetWatcher — quota hysteresis", () => {
  let watcher: BudgetWatcher;

  afterEach(() => {
    watcher?.dispose();
    cleanupDbs();
  });

  test("fires at threshold, no re-fire mid-band, re-arms below deadband", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ quotaThresholds: [80], quotaDeadband: 5 });

    const poller = fakeQuotaPoller();
    const events = collectEvents(bus, QUOTA_UTILIZATION_THRESHOLD);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: poller, quotaPollIntervalMs: 999_999 });

    const setUtil = (u: number) => {
      poller.status = {
        fiveHour: { utilization: u, resetsAt: "2026-04-19T01:00:00Z" },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        fetchedAt: Date.now(),
      } as QuotaStatus;
    };

    setUtil(79);
    watcher.checkQuota();
    expect(events).toHaveLength(0);

    setUtil(81);
    watcher.checkQuota();
    expect(events).toHaveLength(1);
    expect(events[0].utilization).toBe(81);
    expect(events[0].threshold).toBe(80);
    expect(events[0].provider).toBe("anthropic");

    setUtil(85);
    watcher.checkQuota();
    expect(events).toHaveLength(1);

    setUtil(82);
    watcher.checkQuota();
    expect(events).toHaveLength(1);

    setUtil(78);
    watcher.checkQuota();
    expect(events).toHaveLength(1);

    setUtil(74);
    watcher.checkQuota();
    expect(events).toHaveLength(1);

    setUtil(81);
    watcher.checkQuota();
    expect(events).toHaveLength(2);
  });

  test("supports multiple thresholds independently", () => {
    const bus = new EventBus();
    const db = makeDb();
    db.setBudgetConfig({ quotaThresholds: [80, 95], quotaDeadband: 5 });

    const poller = fakeQuotaPoller();
    const events = collectEvents(bus, QUOTA_UTILIZATION_THRESHOLD);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: poller, quotaPollIntervalMs: 999_999 });

    const setUtil = (u: number) => {
      poller.status = {
        fiveHour: { utilization: u, resetsAt: "2026-04-19T01:00:00Z" },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        fetchedAt: Date.now(),
      } as QuotaStatus;
    };

    setUtil(82);
    watcher.checkQuota();
    expect(events).toHaveLength(1);
    expect(events[0].threshold).toBe(80);

    setUtil(96);
    watcher.checkQuota();
    expect(events).toHaveLength(2);
    expect(events[1].threshold).toBe(95);
  });

  test("no events when quota poller has no status", () => {
    const bus = new EventBus();
    const db = makeDb();
    const events = collectEvents(bus, QUOTA_UTILIZATION_THRESHOLD);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    watcher.checkQuota();
    expect(events).toHaveLength(0);
  });
});

// ── Config from DB ──

describe("BudgetWatcher — config", () => {
  afterEach(() => cleanupDbs());

  test("reads defaults when no config stored", () => {
    const db = makeDb();
    const config = db.getBudgetConfig();
    expect(config.sessionCap).toBe(3.0);
    expect(config.sprintCap).toBe(30.0);
    expect(config.sprintWindowMs).toBe(4 * 60 * 60 * 1000);
    expect(config.quotaThresholds).toEqual([80, 95]);
    expect(config.quotaDeadband).toBe(5);
  });

  test("merges partial config with defaults", () => {
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 5.0 });
    const config = db.getBudgetConfig();
    expect(config.sessionCap).toBe(5.0);
    expect(config.sprintCap).toBe(30.0);
  });

  test("persists full config after set", () => {
    const db = makeDb();
    db.setBudgetConfig({ sessionCap: 5.0, quotaThresholds: [50, 75, 90] });
    const config = db.getBudgetConfig();
    expect(config.sessionCap).toBe(5.0);
    expect(config.quotaThresholds).toEqual([50, 75, 90]);
  });
});

// ── Dispose ──

describe("BudgetWatcher — dispose", () => {
  afterEach(() => cleanupDbs());

  test("unsubscribes from bus on dispose", () => {
    const bus = new EventBus();
    const db = makeDb();
    const events = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    const watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });

    watcher.dispose();

    bus.publish(sessionResultEvent("s1", 5.0));
    expect(events).toHaveLength(0);
  });
});

// ── Reconcile (daemon restart state restoration) ──

function makeDbWithLog(): { db: StateDb; eventLog: EventLog } {
  const db = makeDb();
  const eventLog = new EventLog(db.database);
  return { db, eventLog };
}

function loggedEvent(partial: Partial<MonitorEvent> & { event: string; category: string }): MonitorEvent {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    src: "daemon.budget-watcher",
    ...partial,
  } as MonitorEvent;
}

describe("BudgetWatcher — reconcile", () => {
  let watcher: BudgetWatcher | null = null;

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    cleanupDbs();
  });

  test("returns 0 when no eventLog provided", () => {
    const db = makeDb();
    const bus = new EventBus();
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999 });
    expect(watcher.reconcile()).toBe(0);
  });

  test("returns 0 on empty event log", () => {
    const { db, eventLog } = makeDbWithLog();
    const bus = new EventBus();
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    expect(watcher.reconcile()).toBe(0);
  });

  test("returns count of events replayed", () => {
    const { db, eventLog } = makeDbWithLog();
    eventLog.append(loggedEvent({ event: COST_SESSION_OVER_BUDGET, category: "cost", sessionId: "s1", cost: 2.5 }));
    eventLog.append(loggedEvent({ event: COST_SPRINT_OVER_BUDGET, category: "cost" }));
    const bus = new EventBus();
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    expect(watcher.reconcile()).toBe(2);
  });

  test("session budget not re-fired after restart when COST_SESSION_OVER_BUDGET is in the log", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ sessionCap: 2.0 });
    eventLog.append(loggedEvent({ event: COST_SESSION_OVER_BUDGET, category: "cost", sessionId: "s1", cost: 2.5 }));

    const bus = new EventBus();
    const fired = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    bus.publish(sessionResultEvent("s1", 3.0));
    expect(fired).toHaveLength(0);
  });

  test("session budget fires normally for sessions not seen in the log", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ sessionCap: 2.0 });
    eventLog.append(loggedEvent({ event: COST_SESSION_OVER_BUDGET, category: "cost", sessionId: "s1", cost: 2.5 }));

    const bus = new EventBus();
    const fired = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    // s2 has no prior log entry — should fire normally
    bus.publish(sessionResultEvent("s2", 3.0));
    expect(fired).toHaveLength(1);
    expect(fired[0].sessionId).toBe("s2");
  });

  test("SESSION_ENDED in log clears session state so it re-fires on restart", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ sessionCap: 2.0 });
    eventLog.append(loggedEvent({ event: COST_SESSION_OVER_BUDGET, category: "cost", sessionId: "s1", cost: 2.5 }));
    eventLog.append(loggedEvent({ event: SESSION_ENDED, category: "session", sessionId: "s1" }));

    const bus = new EventBus();
    const fired = collectEvents(bus, COST_SESSION_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    // s1 ended before restart — re-fires on new crossing
    bus.publish(sessionResultEvent("s1", 3.0));
    expect(fired).toHaveLength(1);
  });

  test("sprint budget not re-fired after restart when COST_SPRINT_OVER_BUDGET is in the log", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ sprintCap: 5.0 });

    db.upsertSession({ sessionId: "s1", state: "active" });
    db.updateSessionCost("s1", 6.0, 1000);

    eventLog.append(loggedEvent({ event: COST_SPRINT_OVER_BUDGET, category: "cost" }));

    const bus = new EventBus();
    const fired = collectEvents(bus, COST_SPRINT_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    bus.publish(sessionResultEvent("s1", 6.0));
    expect(fired).toHaveLength(0);
  });

  test("sprint budget re-arms during reconcile if current cost has since dropped below cap", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ sprintCap: 5.0 });

    // Costs are now below the cap
    db.upsertSession({ sessionId: "s1", state: "active" });
    db.updateSessionCost("s1", 2.0, 500);

    eventLog.append(loggedEvent({ event: COST_SPRINT_OVER_BUDGET, category: "cost" }));

    const bus = new EventBus();
    const fired = collectEvents(bus, COST_SPRINT_OVER_BUDGET);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: fakeQuotaPoller(), quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    // Cost was re-armed (current cost < cap), so crossing fires again
    db.updateSessionCost("s1", 6.0, 1500);
    bus.publish(sessionResultEvent("s1", 6.0));
    expect(fired).toHaveLength(1);
  });

  test("quota threshold not re-fired after restart when QUOTA_UTILIZATION_THRESHOLD is in the log", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ quotaThresholds: [80], quotaDeadband: 5 });
    eventLog.append(loggedEvent({ event: QUOTA_UTILIZATION_THRESHOLD, category: "quota", threshold: 80 }));

    const poller = fakeQuotaPoller();
    const bus = new EventBus();
    const fired = collectEvents(bus, QUOTA_UTILIZATION_THRESHOLD);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: poller, quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    poller.status = {
      fiveHour: { utilization: 85, resetsAt: "2026-04-29T01:00:00Z" },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
      fetchedAt: Date.now(),
    } as QuotaStatus;

    watcher.checkQuota();
    expect(fired).toHaveLength(0);
  });

  test("quota threshold re-arms after reconcile if utilization drops below deadband", () => {
    const { db, eventLog } = makeDbWithLog();
    db.setBudgetConfig({ quotaThresholds: [80], quotaDeadband: 5 });
    eventLog.append(loggedEvent({ event: QUOTA_UTILIZATION_THRESHOLD, category: "quota", threshold: 80 }));

    const poller = fakeQuotaPoller();
    const bus = new EventBus();
    const fired = collectEvents(bus, QUOTA_UTILIZATION_THRESHOLD);
    watcher = new BudgetWatcher({ bus, db, quotaPoller: poller, quotaPollIntervalMs: 999_999, eventLog });
    watcher.reconcile();

    // Utilization drops below deadband — re-arms
    poller.status = {
      fiveHour: { utilization: 70, resetsAt: "2026-04-29T01:00:00Z" },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
      fetchedAt: Date.now(),
    } as QuotaStatus;
    watcher.checkQuota();

    // Now fires again at 85
    poller.status = {
      fiveHour: { utilization: 85, resetsAt: "2026-04-29T01:00:00Z" },
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
      fetchedAt: Date.now(),
    } as QuotaStatus;
    watcher.checkQuota();
    expect(fired).toHaveLength(1);
  });
});
