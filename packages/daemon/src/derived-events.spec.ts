import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { PHASE_CHANGED } from "@mcp-cli/core";
import { WorkItemDb } from "./db/work-items";
import { DerivedEventPublisher } from "./derived-events";
import { DEFAULT_RULES, prMergedToDone } from "./derived-rules";
import type { DerivedCtx, DerivedRule } from "./derived-rules";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function prMergedInput(prNumber = 42): MonitorEventInput {
  return { src: "daemon.work-item-poller", event: "pr.merged", category: "work_item", prNumber };
}

function stampEvent(input: MonitorEventInput, seq = 1): MonitorEvent {
  return { ...input, seq, ts: new Date().toISOString() };
}

// ── Rule unit tests ──

describe("prMergedToDone rule", () => {
  test("matches pr.merged with prNumber", () => {
    expect(prMergedToDone.match(stampEvent(prMergedInput()))).toBe(true);
  });

  test("rejects non-pr.merged events", () => {
    const input: MonitorEventInput = { src: "test", event: "pr.opened", category: "work_item", prNumber: 1 };
    expect(prMergedToDone.match(stampEvent(input))).toBe(false);
  });

  test("rejects pr.merged without prNumber", () => {
    const input: MonitorEventInput = { src: "test", event: "pr.merged", category: "work_item" };
    expect(prMergedToDone.match(stampEvent(input))).toBe(false);
  });

  test("derives phase.changed for QA work item", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const bus = new EventBus();
    const ctx: DerivedCtx = { workItemDb, bus };

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    const result = prMergedToDone.derive(stampEvent(prMergedInput(), 5), ctx);

    if (!result) throw new Error("expected non-null result");
    expect(result.src).toBe("daemon.derived");
    expect(result.event).toBe(PHASE_CHANGED);
    expect(result.category).toBe("work_item");
    expect(result.workItemId).toBe(wi.id);
    expect(result.prNumber).toBe(42);
    expect(result.from).toBe("qa");
    expect(result.to).toBe("done");
    expect(result.reason).toBe("pr.merged #42");
  });

  test("updates work item phase to done in DB", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    prMergedToDone.derive(stampEvent(prMergedInput(), 5), ctx);

    expect(workItemDb.getWorkItem(wi.id)?.phase).toBe("done");
  });

  test("returns null for non-QA phase (idempotent)", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    workItemDb.createWorkItem({ prNumber: 42, phase: "impl" });
    expect(prMergedToDone.derive(stampEvent(prMergedInput(), 5), ctx)).toBeNull();
  });

  test("returns null when no work item for PR", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    expect(prMergedToDone.derive(stampEvent(prMergedInput(999), 5), ctx)).toBeNull();
  });

  test("second invocation is a no-op after phase transitions to done", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    const event = stampEvent(prMergedInput(), 5);

    expect(prMergedToDone.derive(event, ctx)).not.toBeNull();
    expect(prMergedToDone.derive(event, ctx)).toBeNull();
  });
});

// ── Publisher integration tests ──

describe("DerivedEventPublisher", () => {
  test("publishes phase.changed for pr.merged on QA work item", () => {
    const db = freshDb();
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("pr.merged");
    expect(received[1].event).toBe(PHASE_CHANGED);
    expect(received[1].src).toBe("daemon.derived");
    expect(received[1].causedBy).toEqual([received[0].seq]);
    expect(received[1].from).toBe("qa");
    expect(received[1].to).toBe("done");
  });

  test("does not publish for non-QA work item", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "impl" });
    bus.publish(prMergedInput(42));

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });

  test("does not publish when no work item exists", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    bus.publish(prMergedInput(999));

    expect(received).toHaveLength(1);
  });

  test("updates work item phase in DB", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    expect(workItemDb.getWorkItem(wi.id)?.phase).toBe("done");
  });

  test("derived event is persisted to EventLog", () => {
    const db = freshDb();
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    const workItemDb = new WorkItemDb(db);

    bus.subscribe(() => {});
    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    const events = eventLog.getSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("pr.merged");
    expect(events[1].event).toBe(PHASE_CHANGED);
    expect(events[1].causedBy).toEqual([events[0].seq]);
  });

  test("DB update + event persist are atomic (transaction)", () => {
    const db = freshDb();
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    const workItemDb = new WorkItemDb(db);

    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    const updated = workItemDb.getWorkItem(wi.id);
    const events = eventLog.getSince(0);
    expect(updated?.phase).toBe("done");
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe(PHASE_CHANGED);
  });

  test("no infinite loop: derived phase.changed does not re-trigger", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("pr.merged");
    expect(received[1].event).toBe(PHASE_CHANGED);
  });

  test("depth cap: events at max depth are not processed", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    let deriveCalled = false;
    const alwaysMatch: DerivedRule = {
      name: "always",
      match: () => true,
      derive: () => {
        deriveCalled = true;
        return { src: "daemon.derived", event: "test.derived", category: "work_item" };
      },
    };

    new DerivedEventPublisher({ bus, rules: [alwaysMatch], workItemDb, db });

    bus.publish({ src: "test", event: "deep", category: "work_item", causedBy: [1, 2, 3, 4] });

    expect(deriveCalled).toBe(false);
  });

  test("causedBy chain grows with derivation depth", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    let calls = 0;
    const chainingRule: DerivedRule = {
      name: "chain",
      match: (e) => e.event === "chain.start" || e.event === "chain.step",
      derive: () => {
        if (++calls > 10) return null;
        return { src: "daemon.derived", event: "chain.step", category: "work_item" };
      },
    };

    new DerivedEventPublisher({ bus, rules: [chainingRule], workItemDb, db });

    bus.publish({ src: "test", event: "chain.start", category: "work_item" });

    // chain.start(seq=1) → 4 derived chain.step events, then depth cap stops
    expect(received).toHaveLength(5);
    expect(received[1].causedBy as number[]).toHaveLength(1);
    expect(received[2].causedBy as number[]).toHaveLength(2);
    expect(received[3].causedBy as number[]).toHaveLength(3);
    expect(received[4].causedBy as number[]).toHaveLength(4);
  });

  test("rules run in registration order", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const order: string[] = [];

    const ruleA: DerivedRule = {
      name: "a",
      match: (e) => e.event === "test.order",
      derive: () => {
        order.push("a");
        return null;
      },
    };

    const ruleB: DerivedRule = {
      name: "b",
      match: (e) => e.event === "test.order",
      derive: () => {
        order.push("b");
        return null;
      },
    };

    new DerivedEventPublisher({ bus, rules: [ruleA, ruleB], workItemDb, db });

    bus.publish({ src: "test", event: "test.order", category: "work_item" });

    expect(order).toEqual(["a", "b"]);
  });
});
