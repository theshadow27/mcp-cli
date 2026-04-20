import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";

function sessionEvent(event = "session.result", sessionId = "s1"): MonitorEventInput {
  return { src: "daemon.claude-server", event, category: "session", sessionId };
}

function workItemEvent(event = "pr.merged", prNumber = 42): MonitorEventInput {
  return { src: "daemon.work-item-poller", event, category: "work_item", prNumber };
}

function mailEvent(mailId = 1): MonitorEventInput {
  return { src: "daemon.mail", event: "mail.received", category: "mail", mailId };
}

describe("EventBus", () => {
  test("publish stamps seq and ts", () => {
    const bus = new EventBus();
    const result = bus.publish(sessionEvent());
    expect(result.seq).toBe(1);
    expect(typeof result.ts).toBe("string");
    expect(new Date(result.ts).getTime()).toBeGreaterThan(0);
  });

  test("seq is monotonically increasing across sources", () => {
    const bus = new EventBus();
    const e1 = bus.publish(sessionEvent());
    const e2 = bus.publish(workItemEvent());
    const e3 = bus.publish(mailEvent());
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  test("subscriber receives all published events", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish(sessionEvent());
    bus.publish(workItemEvent());
    bus.publish(mailEvent());

    expect(received).toHaveLength(3);
    expect(received[0].event).toBe("session.result");
    expect(received[1].event).toBe("pr.merged");
    expect(received[2].event).toBe("mail.received");
  });

  test("multiple subscribers all receive events", () => {
    const bus = new EventBus();
    const a: MonitorEvent[] = [];
    const b: MonitorEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(sessionEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("filter predicate limits which events a subscriber sees", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe(
      (e) => received.push(e),
      (e) => e.category === "session",
    );

    bus.publish(sessionEvent());
    bus.publish(workItemEvent());
    bus.publish(mailEvent());
    bus.publish(sessionEvent("session.ended"));

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("session.result");
    expect(received[1].event).toBe("session.ended");
  });

  test("filter by src field", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe(
      (e) => received.push(e),
      (e) => e.src === "daemon.mail",
    );

    bus.publish(sessionEvent());
    bus.publish(mailEvent());
    bus.publish(workItemEvent());

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("mail.received");
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    const id = bus.subscribe((e) => received.push(e));

    bus.publish(sessionEvent());
    expect(received).toHaveLength(1);

    bus.unsubscribe(id);
    bus.publish(sessionEvent());
    expect(received).toHaveLength(1);
  });

  test("unsubscribe returns true for existing, false for unknown", () => {
    const bus = new EventBus();
    const id = bus.subscribe(() => {});
    expect(bus.unsubscribe(id)).toBe(true);
    expect(bus.unsubscribe(id)).toBe(false);
    expect(bus.unsubscribe(999)).toBe(false);
  });

  test("subscriberCount tracks active subscribers", () => {
    const bus = new EventBus();
    expect(bus.subscriberCount).toBe(0);
    const id1 = bus.subscribe(() => {});
    const id2 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);
    bus.unsubscribe(id1);
    expect(bus.subscriberCount).toBe(1);
    bus.unsubscribe(id2);
    expect(bus.subscriberCount).toBe(0);
  });

  test("published event preserves extra fields from input", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({
      src: "daemon.claude-server",
      event: "session.result",
      category: "session",
      sessionId: "s1",
      cost: 0.05,
      tokens: 1234,
    });

    expect(received[0].cost).toBe(0.05);
    expect(received[0].tokens).toBe(1234);
    expect(received[0].sessionId).toBe("s1");
  });

  test("publish returns the stamped event", () => {
    const bus = new EventBus();
    const result = bus.publish(workItemEvent("pr.opened", 99));
    expect(result.seq).toBe(1);
    expect(result.event).toBe("pr.opened");
    expect(result.prNumber).toBe(99);
    expect(result.src).toBe("daemon.work-item-poller");
  });

  test("events from multiple sources arrive in seq order", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish(sessionEvent("session.result"));
    bus.publish(workItemEvent("pr.merged"));
    bus.publish(mailEvent(1));
    bus.publish(sessionEvent("session.ended"));
    bus.publish(workItemEvent("checks.passed"));

    for (let i = 1; i < received.length; i++) {
      expect(received[i].seq).toBe(received[i - 1].seq + 1);
    }
    expect(received[0].seq).toBe(1);
    expect(received[4].seq).toBe(5);
  });

  test("subscriber added after publish does not see past events", () => {
    const bus = new EventBus();
    bus.publish(sessionEvent());

    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish(workItemEvent());
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe("pr.merged");
  });
});

function freshLog(): EventLog {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  return new EventLog(db);
}

describe("EventBus with EventLog", () => {
  test("seq comes from SQLite when EventLog is provided", () => {
    const log = freshLog();
    const bus = new EventBus(log);
    const e1 = bus.publish(sessionEvent());
    const e2 = bus.publish(workItemEvent());
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  test("events are persisted and retrievable from the log", () => {
    const log = freshLog();
    const bus = new EventBus(log);
    bus.publish(sessionEvent("session.result"));
    bus.publish(workItemEvent("pr.merged"));

    const events = log.getSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("session.result");
    expect(events[1].event).toBe("pr.merged");
  });

  test("seq continuity survives simulated restart", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    const log1 = new EventLog(db);

    const bus1 = new EventBus(log1);
    bus1.publish(sessionEvent());
    bus1.publish(sessionEvent());
    bus1.publish(sessionEvent());
    expect(bus1.currentSeq).toBe(3);

    // Simulate daemon restart — new EventLog + EventBus on same db
    const log2 = new EventLog(db);
    const bus2 = new EventBus(log2);
    expect(bus2.currentSeq).toBe(3);

    const e4 = bus2.publish(workItemEvent());
    expect(e4.seq).toBe(4);
  });

  test("subscribers still receive events with EventLog", () => {
    const log = freshLog();
    const bus = new EventBus(log);
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish(sessionEvent());
    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(1);
  });

  test("eventLog getter returns the log instance", () => {
    const log = freshLog();
    const bus = new EventBus(log);
    expect(bus.eventLog).toBe(log);
  });

  test("eventLog getter returns null without log", () => {
    const bus = new EventBus();
    expect(bus.eventLog).toBeNull();
  });
});
