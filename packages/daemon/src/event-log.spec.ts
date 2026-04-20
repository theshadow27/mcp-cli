import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import { EventLog } from "./event-log";

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    src: "daemon.test",
    event: "session.result",
    category: "session",
    sessionId: "s1",
    ...overrides,
  };
}

function freshLog(): EventLog {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  return new EventLog(db);
}

describe("EventLog", () => {
  test("append returns monotonically increasing seq", () => {
    const log = freshLog();
    const s1 = log.append(makeEvent());
    const s2 = log.append(makeEvent());
    const s3 = log.append(makeEvent());
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
  });

  test("getSince returns events after the given seq", () => {
    const log = freshLog();
    log.append(makeEvent({ event: "a" }));
    log.append(makeEvent({ event: "b" }));
    log.append(makeEvent({ event: "c" }));

    const events = log.getSince(1);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("b");
    expect(events[1].event).toBe("c");
  });

  test("getSince(0) returns all events", () => {
    const log = freshLog();
    log.append(makeEvent({ event: "a" }));
    log.append(makeEvent({ event: "b" }));

    const events = log.getSince(0);
    expect(events).toHaveLength(2);
  });

  test("getSince respects limit", () => {
    const log = freshLog();
    for (let i = 0; i < 10; i++) {
      log.append(makeEvent({ event: `e${i}` }));
    }

    const events = log.getSince(0, 3);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("e0");
    expect(events[2].event).toBe("e2");
  });

  test("getSince returns empty array when no events after cursor", () => {
    const log = freshLog();
    log.append(makeEvent());
    expect(log.getSince(1)).toHaveLength(0);
    expect(log.getSince(999)).toHaveLength(0);
  });

  test("append + getSince round-trip preserves full payload", () => {
    const log = freshLog();
    const original = makeEvent({
      event: "session.result",
      sessionId: "s42",
      cost: 0.05,
      tokens: 1234,
    });
    log.append(original);

    const [restored] = log.getSince(0);
    expect(restored.event).toBe("session.result");
    expect(restored.sessionId).toBe("s42");
    expect(restored.cost).toBe(0.05);
    expect(restored.tokens).toBe(1234);
  });

  test("prune removes old events and preserves recent ones", () => {
    const log = freshLog();
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentTs = new Date().toISOString();

    log.append(makeEvent({ ts: oldTs, event: "old" }));
    log.append(makeEvent({ ts: oldTs, event: "old2" }));
    log.append(makeEvent({ ts: recentTs, event: "recent" }));

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pruned = log.prune(cutoff);
    expect(pruned).toBe(2);

    const remaining = log.getSince(0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event).toBe("recent");
  });

  test("currentSeq returns 0 for empty log", () => {
    const log = freshLog();
    expect(log.currentSeq()).toBe(0);
  });

  test("currentSeq returns highest seq after appends", () => {
    const log = freshLog();
    log.append(makeEvent());
    log.append(makeEvent());
    log.append(makeEvent());
    expect(log.currentSeq()).toBe(3);
  });

  test("seq is never reused after deletion (AUTOINCREMENT)", () => {
    const log = freshLog();
    log.append(makeEvent());
    log.append(makeEvent());
    log.append(makeEvent());

    // Prune all events
    log.prune(new Date(Date.now() + 1000));
    expect(log.getSince(0)).toHaveLength(0);

    // New event must have seq > 3
    const seq = log.append(makeEvent());
    expect(seq).toBeGreaterThan(3);
  });

  test("migrate is idempotent", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    const log1 = new EventLog(db);
    log1.append(makeEvent({ event: "before" }));

    // Creating a second EventLog on same db should not lose data
    const log2 = new EventLog(db);
    const events = log2.getSince(0);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("before");
  });

  test("persists indexed fields for filtering", () => {
    const log = freshLog();
    log.append(
      makeEvent({
        event: "pr.merged",
        category: "work_item",
        workItemId: "wi-1",
        prNumber: 42,
      }),
    );

    const events = log.getSince(0);
    expect(events[0].category).toBe("work_item");
    expect(events[0].workItemId).toBe("wi-1");
    expect(events[0].prNumber).toBe(42);
  });

  test("getSince returns authoritative seq from DB, not placeholder 0", () => {
    const log = freshLog();
    log.append(makeEvent({ event: "a" }));
    log.append(makeEvent({ event: "b" }));
    log.append(makeEvent({ event: "c" }));

    const events = log.getSince(0);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
    expect(events[2].seq).toBe(3);
  });

  test("currentSeq returns correct value after prune empties table", () => {
    const log = freshLog();
    log.append(makeEvent());
    log.append(makeEvent());
    log.append(makeEvent());

    log.prune(new Date(Date.now() + 1000));
    expect(log.getSince(0)).toHaveLength(0);

    // AUTOINCREMENT counter in sqlite_sequence must still reflect 3
    expect(log.currentSeq()).toBe(3);

    // Next append must get seq > 3
    const seq = log.append(makeEvent());
    expect(seq).toBe(4);
  });

  test("startPruning and stopPruning lifecycle", () => {
    const log = freshLog();
    // Should not throw when called multiple times
    log.startPruning();
    log.startPruning(); // idempotent
    log.stopPruning();
    log.stopPruning(); // idempotent
  });
});
