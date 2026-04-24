import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { PHASE_CHANGED } from "@mcp-cli/core";
import { WorkItemDb } from "./db/work-items";
import { DerivedEventPublisher } from "./derived-events";
import { DEFAULT_RULES, isDerivedPending, prMergedToDone } from "./derived-rules";
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

  test("applies phase.changed for QA work item", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const bus = new EventBus();
    const ctx: DerivedCtx = { workItemDb, bus };

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    const result = prMergedToDone.apply(stampEvent(prMergedInput(), 5), ctx);

    if (!result || isDerivedPending(result)) throw new Error("expected non-null, non-pending result");
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
    prMergedToDone.apply(stampEvent(prMergedInput(), 5), ctx);

    expect(workItemDb.getWorkItem(wi.id)?.phase).toBe("done");
  });

  test("returns null for non-QA phase (idempotent)", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    workItemDb.createWorkItem({ prNumber: 42, phase: "impl" });
    expect(prMergedToDone.apply(stampEvent(prMergedInput(), 5), ctx)).toBeNull();
  });

  test("returns pending when no work item for PR", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    const result = prMergedToDone.apply(stampEvent(prMergedInput(999), 5), ctx);
    if (!isDerivedPending(result)) throw new Error("expected pending result");
    expect(result.reason).toContain("999");
  });

  test("second invocation is a no-op after phase transitions to done", () => {
    const db = freshDb();
    const workItemDb = new WorkItemDb(db);
    const ctx: DerivedCtx = { workItemDb, bus: new EventBus() };

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    const event = stampEvent(prMergedInput(), 5);

    expect(prMergedToDone.apply(event, ctx)).not.toBeNull();
    expect(prMergedToDone.apply(event, ctx)).toBeNull();
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
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));
    pub.dispose();

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
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "impl" });
    bus.publish(prMergedInput(42));
    pub.dispose();

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });

  test("schedules retry when no work item exists (pending)", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db, retryBaseMs: 10 });

    bus.publish(prMergedInput(42));

    // Work item created after event fires — the retry should pick it up
    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });

    // Poll until the derived event appears (retry fires at ~10ms)
    const deadline = Date.now() + 2000;
    while (received.length < 2 && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    pub.dispose();

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("pr.merged");
    expect(received[1].event).toBe(PHASE_CHANGED);
    expect(received[1].to).toBe("done");
  });

  test("retry succeeds and updates DB", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db, retryBaseMs: 10 });

    bus.publish(prMergedInput(42));
    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });

    const deadline = Date.now() + 2000;
    while (workItemDb.getWorkItem(wi.id)?.phase !== "done" && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    pub.dispose();

    expect(workItemDb.getWorkItem(wi.id)?.phase).toBe("done");
  });

  test("retry exhaustion: drops event after max retries", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db, retryBaseMs: 10 });

    // Fire pr.merged with no work item — never create one
    bus.publish(prMergedInput(999));

    // Wait long enough for all 3 retries to exhaust (10 + 20 + 40 = 70ms, give margin)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await Bun.sleep(10);
      // Break early once we're well past all retries
      if (Date.now() > deadline - 1500) break;
    }

    pub.dispose();

    // Only the original pr.merged event — no derived event produced
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });

  test("dispose cancels pending retries", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    // Use long retry delay so we can dispose before it fires
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db, retryBaseMs: 5000 });

    bus.publish(prMergedInput(42));
    pub.dispose();

    // Create work item after dispose — retry should never fire
    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });

  test("updates work item phase in DB", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));
    pub.dispose();

    expect(workItemDb.getWorkItem(wi.id)?.phase).toBe("done");
  });

  test("derived event is persisted to EventLog", () => {
    const db = freshDb();
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    const workItemDb = new WorkItemDb(db);

    bus.subscribe(() => {});
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));
    pub.dispose();

    const events = eventLog.getSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("pr.merged");
    expect(events[1].event).toBe(PHASE_CHANGED);
    expect(events[1].causedBy).toEqual([events[0].seq]);
  });

  test("DB update and derived event are both persisted", () => {
    const db = freshDb();
    const eventLog = new EventLog(db);
    const bus = new EventBus(eventLog);
    const workItemDb = new WorkItemDb(db);

    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    const wi = workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));
    pub.dispose();

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
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));
    pub.dispose();

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("pr.merged");
    expect(received[1].event).toBe(PHASE_CHANGED);
  });

  test("depth cap: events at max depth are not processed", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    let applyCalled = false;
    const alwaysMatch: DerivedRule = {
      name: "always",
      match: () => true,
      apply: () => {
        applyCalled = true;
        return { src: "daemon.derived", event: "test.derived", category: "work_item" };
      },
    };

    const pub = new DerivedEventPublisher({ bus, rules: [alwaysMatch], workItemDb, db });

    bus.publish({ src: "test", event: "deep", category: "work_item", causedBy: [1, 2, 3, 4] });
    pub.dispose();

    expect(applyCalled).toBe(false);
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
      apply: () => {
        if (++calls > 10) return null;
        return { src: "daemon.derived", event: "chain.step", category: "work_item" };
      },
    };

    const pub = new DerivedEventPublisher({ bus, rules: [chainingRule], workItemDb, db });

    bus.publish({ src: "test", event: "chain.start", category: "work_item" });
    pub.dispose();

    // chain.start(seq=1) → 4 derived chain.step events, then depth cap stops
    expect(received).toHaveLength(5);
    expect(received[1].causedBy).toHaveLength(1);
    expect(received[2].causedBy).toHaveLength(2);
    expect(received[3].causedBy).toHaveLength(3);
    expect(received[4].causedBy).toHaveLength(4);
  });

  test("rules run in registration order", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const order: string[] = [];

    const ruleA: DerivedRule = {
      name: "a",
      match: (e) => e.event === "test.order",
      apply: () => {
        order.push("a");
        return null;
      },
    };

    const ruleB: DerivedRule = {
      name: "b",
      match: (e) => e.event === "test.order",
      apply: () => {
        order.push("b");
        return null;
      },
    };

    const pub = new DerivedEventPublisher({ bus, rules: [ruleA, ruleB], workItemDb, db });

    bus.publish({ src: "test", event: "test.order", category: "work_item" });
    pub.dispose();

    expect(order).toEqual(["a", "b"]);
  });

  test("dispose unsubscribes: rule does not fire after dispose", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });
    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    pub.dispose();

    bus.publish(prMergedInput(42));

    // Only the pr.merged event — publisher is no longer subscribed
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });

  test("two publishers on same bus fire rule exactly once each", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const pubA = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });
    const pubB = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db });

    workItemDb.createWorkItem({ prNumber: 42, phase: "qa" });
    bus.publish(prMergedInput(42));

    pubA.dispose();
    pubB.dispose();

    // pubA fires → phase.changed (wi now done); pubB fires on same pr.merged → wi already done → no-op
    // Result: pr.merged + one phase.changed, not two
    expect(received.filter((e) => e.event === PHASE_CHANGED)).toHaveLength(1);
  });

  test("publisher stamps src:daemon.derived regardless of rule return value", () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const spoofRule: DerivedRule = {
      name: "spoof",
      match: (e) => e.event === "trigger",
      apply: () => ({ src: "attacker.src", event: "test.derived", category: "work_item" }),
    };

    const pub = new DerivedEventPublisher({ bus, rules: [spoofRule], workItemDb, db });

    bus.publish({ src: "test", event: "trigger", category: "work_item" });
    pub.dispose();

    const derived = received.find((e) => e.event === "test.derived");
    expect(derived?.src).toBe("daemon.derived");
  });

  // ── Retry-specific integration tests ──

  test("retry does not re-derive if work item created with non-QA phase", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const pub = new DerivedEventPublisher({ bus, rules: DEFAULT_RULES, workItemDb, db, retryBaseMs: 10 });

    bus.publish(prMergedInput(42));

    // Create work item in "done" phase — retry should find it but skip (null, not pending)
    workItemDb.createWorkItem({ prNumber: 42, phase: "done" });

    await Bun.sleep(100);
    pub.dispose();

    // Only the original pr.merged — no derived event
    expect(received).toHaveLength(1);
  });

  test("retry catches rule exceptions instead of crashing", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    let applyCalls = 0;
    const failOnRetry: DerivedRule = {
      name: "fail-on-retry",
      match: (e) => e.event === "pr.merged",
      apply: () => {
        applyCalls++;
        if (applyCalls === 1) return { pending: true, reason: "not ready" };
        throw new Error("kaboom in retry");
      },
    };

    const pub = new DerivedEventPublisher({ bus, rules: [failOnRetry], workItemDb, db, retryBaseMs: 10 });

    bus.publish(prMergedInput(42));

    await Bun.sleep(200);
    pub.dispose();

    expect(applyCalls).toBe(2);
    expect(received).toHaveLength(1);
  });

  test("pending rule does not cause infinite loop via depth cap on retried events", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const workItemDb = new WorkItemDb(db);

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    let retryCount = 0;
    const alwaysPending: DerivedRule = {
      name: "always-pending",
      match: (e) => e.event === "pr.merged",
      apply: () => {
        retryCount++;
        return { pending: true, reason: "always pending" };
      },
    };

    const pub = new DerivedEventPublisher({ bus, rules: [alwaysPending], workItemDb, db, retryBaseMs: 10 });

    bus.publish(prMergedInput(42));

    // Wait for all retries to exhaust
    await Bun.sleep(200);
    pub.dispose();

    // 1 initial + 3 retries = 4 total apply calls
    expect(retryCount).toBe(4);
    // Only the original event — no derived events
    expect(received).toHaveLength(1);
  });
});
