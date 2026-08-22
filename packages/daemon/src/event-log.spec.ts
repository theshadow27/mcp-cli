import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { EventLog } from "./event-log";

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    domainId: NO_DOMAIN_ID,
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

// ── Domain partitioning (#3040) ──

function freshLogWithDb(): { log: EventLog; db: Database } {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  return { log: new EventLog(db), db };
}

describe("EventLog domain partitioning", () => {
  test("append writes the event's domainId into the column, not the sentinel", () => {
    const { log, db } = freshLogWithDb();
    log.append(makeEvent({ domainId: 3, event: "a" }));
    log.append(makeEvent({ domainId: 7, event: "b" }));
    log.append(makeEvent({ event: "c" })); // NO_DOMAIN_ID

    const rows = db
      .query<{ event: string; domain_id: number }, []>("SELECT event, domain_id FROM monitor_events ORDER BY seq")
      .all();
    expect(rows).toEqual([
      { event: "a", domain_id: 3 },
      { event: "b", domain_id: 7 },
      { event: "c", domain_id: NO_DOMAIN_ID },
    ]);
  });

  test("getSince({ domainId }) returns only that domain; omitting it returns every domain", () => {
    const { log } = freshLogWithDb();
    log.append(makeEvent({ domainId: 3, event: "phoenix.1" }));
    log.append(makeEvent({ domainId: 7, event: "clrg.1" }));
    log.append(makeEvent({ domainId: 3, event: "phoenix.2" }));
    log.append(makeEvent({ event: "daemon-wide" }));

    expect(log.getSince(0, 100, { domainId: 3 }).map((e) => e.event)).toEqual(["phoenix.1", "phoenix.2"]);
    expect(log.getSince(0, 100, { domainId: 7 }).map((e) => e.event)).toEqual(["clrg.1"]);
    expect(log.getSince(0, 100, { domainId: NO_DOMAIN_ID }).map((e) => e.event)).toEqual(["daemon-wide"]);
    expect(log.getSince(0, 100).map((e) => e.event)).toEqual(["phoenix.1", "clrg.1", "phoenix.2", "daemon-wide"]);
  });

  test("the domain filter composes with the event-name filter", () => {
    const { log } = freshLogWithDb();
    log.append(makeEvent({ domainId: 3, event: "pr.merged" }));
    log.append(makeEvent({ domainId: 3, event: "pr.opened" }));
    log.append(makeEvent({ domainId: 7, event: "pr.merged" }));

    const got = log.getSince(0, 100, { domainId: 3, events: ["pr.merged"] });
    expect(got).toHaveLength(1);
    expect(got[0]?.domainId).toBe(3);
    expect(got[0]?.event).toBe("pr.merged");
  });

  test("replayed events carry their domain — the column is authoritative over the payload", () => {
    const { log, db } = freshLogWithDb();
    log.append(makeEvent({ domainId: 3, domain: "phoenix", event: "pr.merged" }));

    // A row written before #3040: no domainId in the payload JSON at all. getSince must
    // report the column rather than leaving the replayed envelope without a domain.
    db.run("INSERT INTO monitor_events (ts, src, event, category, domain_id, payload) VALUES (?, ?, ?, ?, ?, ?)", [
      new Date().toISOString(),
      "daemon.legacy",
      "legacy.event",
      "daemon",
      7,
      JSON.stringify({
        seq: 0,
        ts: new Date().toISOString(),
        src: "daemon.legacy",
        event: "legacy.event",
        category: "daemon",
      }),
    ]);

    const replayed = log.getSince(0);
    expect(replayed[0]?.domainId).toBe(3);
    expect(replayed[0]?.domain).toBe("phoenix");
    expect(replayed[1]?.domainId).toBe(7);
  });

  // The whole point of #3040's half of the index: #3034 shipped the index with no writer,
  // so it indexed a column that was always 0 and no query used. Assert the query planner
  // actually reaches for it, not just that the index exists.
  test("the domain index is usable by the domain-scoped replay query", () => {
    const { db } = freshLogWithDb();
    const plan = db
      .query<{ detail: string }, [number, number, number]>(
        "EXPLAIN QUERY PLAN SELECT seq, domain_id, payload FROM monitor_events WHERE seq > ? AND domain_id = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(0, 3, 100)
      .map((r) => r.detail)
      .join(" | ");

    expect(plan).toContain("idx_monitor_events_domain");
    // Index order (domain_id, seq) serves the ORDER BY too — no sort step.
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("a v1 database gains the domain index on open", () => {
    const db = new Database(":memory:");
    // Reproduce the #3034 v1 schema exactly: domain_id column, no domain index.
    db.exec(`
      CREATE TABLE schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE monitor_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, src TEXT NOT NULL,
        event TEXT NOT NULL, category TEXT NOT NULL, work_item_id TEXT, session_id TEXT,
        pr_number INTEGER, domain_id INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
      );
      CREATE INDEX idx_monitor_events_ts ON monitor_events(ts);
      INSERT INTO schema_versions (name, version) VALUES ('event_log', 1);
    `);

    new EventLog(db);

    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_monitor_events_domain'",
      )
      .get();
    expect(idx?.name).toBe("idx_monitor_events_domain");
    expect(
      db.query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?").get("event_log")
        ?.version,
    ).toBe(2);
  });
});
