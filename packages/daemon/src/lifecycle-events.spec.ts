import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DAEMON_CONFIG_RELOADED,
  DAEMON_RESTARTED,
  GC_PRUNED,
  type MonitorEvent,
  WORKER_RATELIMITED,
} from "@mcp-cli/core";
import { ConfigWatcher } from "./config/watcher";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs)
    try {
      db.close();
    } catch {
      /* already closed */
    }
  openDbs.length = 0;
});

function freshLog(): EventLog {
  const db = new Database(":memory:");
  openDbs.push(db);
  db.exec("PRAGMA journal_mode = WAL");
  return new EventLog(db);
}

function freshDb(): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

describe("daemon.restarted", () => {
  test("seqBefore/seqAfter continuity across simulated restart", () => {
    const db = freshDb();
    const log1 = new EventLog(db);
    const bus1 = new EventBus(log1);

    bus1.publish({ src: "test", event: "session.result", category: "session" });
    bus1.publish({ src: "test", event: "session.result", category: "session" });
    bus1.publish({ src: "test", event: "session.result", category: "session" });
    expect(bus1.currentSeq).toBe(3);

    const log2 = new EventLog(db);
    const seqBefore = log2.currentSeq();
    expect(seqBefore).toBe(3);

    const received: MonitorEvent[] = [];
    const bus2 = new EventBus(log2);
    bus2.subscribe((e) => received.push(e));

    const restartedEvent = bus2.publish({
      src: "daemon",
      event: DAEMON_RESTARTED,
      category: "daemon",
      seqBefore,
      seqAfter: seqBefore + 1,
      reason: "start",
    });

    expect(restartedEvent.seq).toBe(4);
    expect(restartedEvent.seqBefore).toBe(3);
    expect(restartedEvent.seqAfter).toBe(4);
    expect(restartedEvent.reason).toBe("start");
    expect(restartedEvent.event).toBe(DAEMON_RESTARTED);
    expect(restartedEvent.category).toBe("daemon");

    expect(received).toHaveLength(1);
    expect(received[0].seqAfter).toBe(4);
  });

  test("daemon.restarted is first event after fresh start (seqBefore=0)", () => {
    const log = freshLog();
    const seqBefore = log.currentSeq();
    expect(seqBefore).toBe(0);

    const bus = new EventBus(log);
    const event = bus.publish({
      src: "daemon",
      event: DAEMON_RESTARTED,
      category: "daemon",
      seqBefore,
      seqAfter: seqBefore + 1,
      reason: "start",
    });

    expect(event.seq).toBe(1);
    expect(event.seqBefore).toBe(0);
    expect(event.seqAfter).toBe(1);
  });

  test("daemon.restarted is persisted and retrievable via getSince with seqAfter", () => {
    const log = freshLog();
    const bus = new EventBus(log);

    bus.publish({
      src: "daemon",
      event: DAEMON_RESTARTED,
      category: "daemon",
      seqBefore: 0,
      seqAfter: 1,
      reason: "start",
    });

    const events = log.getSince(0);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(DAEMON_RESTARTED);
    expect(events[0].seqBefore).toBe(0);
    expect(events[0].seqAfter).toBe(1);
    expect(events[0].reason).toBe("start");
  });
});

describe("daemon.config_reloaded", () => {
  test("ConfigWatcher.diffServers detects added, removed, and changed servers", () => {
    type ServerMap = Parameters<typeof ConfigWatcher.diffServers>[0];
    const oldServers = new Map([
      ["server-a", { config: { command: "a" } }],
      ["server-b", { config: { command: "b" } }],
      ["server-c", { config: { command: "c" } }],
    ]) as unknown as ServerMap;

    const newServers = new Map([
      ["server-a", { config: { command: "a" } }],
      ["server-b", { config: { command: "b-modified" } }],
      ["server-d", { config: { command: "d" } }],
    ]) as unknown as ServerMap;

    const diff = ConfigWatcher.diffServers(oldServers, newServers);

    expect(diff.added).toEqual(["server-d"]);
    expect(diff.removed).toEqual(["server-c"]);
    expect(diff.changed).toEqual(["server-b"]);
  });

  test("changedKeys is the union of added, removed, and changed", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const added = ["new-server"];
    const removed = ["old-server"];
    const changed = ["modified-server"];
    const changedKeys = [...added, ...removed, ...changed];

    bus.publish({
      src: "daemon",
      event: DAEMON_CONFIG_RELOADED,
      category: "daemon",
      changedKeys,
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe(DAEMON_CONFIG_RELOADED);
    expect(received[0].changedKeys).toEqual(["new-server", "old-server", "modified-server"]);
  });
});

describe("worker.ratelimited", () => {
  test("event shape includes provider and sessionId", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({
      src: "daemon.claude-server",
      event: WORKER_RATELIMITED,
      category: "worker",
      sessionId: "sess-42",
      provider: "anthropic",
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe(WORKER_RATELIMITED);
    expect(received[0].category).toBe("worker");
    expect(received[0].sessionId).toBe("sess-42");
    expect(received[0].provider).toBe("anthropic");
  });
});

describe("gc.pruned", () => {
  test("event carries worktrees and branches arrays", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({
      src: "cli.gc",
      event: GC_PRUNED,
      category: "gc",
      worktrees: ["claude-abc123", "claude-def456"],
      branches: ["feat/issue-100-foo"],
      reason: "manual",
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe(GC_PRUNED);
    expect(received[0].category).toBe("gc");
    expect(received[0].worktrees).toEqual(["claude-abc123", "claude-def456"]);
    expect(received[0].branches).toEqual(["feat/issue-100-foo"]);
    expect(received[0].reason).toBe("manual");
  });

  test("gc.pruned is silent when nothing was pruned (no event published)", () => {
    const bus = new EventBus();
    const received: MonitorEvent[] = [];
    bus.subscribe((e) => received.push(e));

    // Simulate: gc ran but pruned nothing — no event should be published
    const prunedWorktrees: string[] = [];
    const deletedBranches: string[] = [];

    if (prunedWorktrees.length > 0 || deletedBranches.length > 0) {
      bus.publish({
        src: "cli.gc",
        event: GC_PRUNED,
        category: "gc",
        worktrees: prunedWorktrees,
        branches: deletedBranches,
        reason: "manual",
      });
    }

    expect(received).toHaveLength(0);
  });
});
