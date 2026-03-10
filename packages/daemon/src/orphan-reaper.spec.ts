import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "./db/state";
import { reapOrphanedSessions } from "./orphan-reaper";

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // ignore
    }
  }
}

describe("reapOrphanedSessions", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) cleanup(p);
    paths.length = 0;
    mock.restore();
  });

  function createDb(): StateDb {
    const p = tmpDb();
    paths.push(p);
    return new StateDb(p);
  }

  test("returns 0 when no active sessions", () => {
    const db = createDb();
    const result = reapOrphanedSessions(db);
    expect(result).toBe(0);
  });

  test("marks sessions as ended even if pid is null", () => {
    const db = createDb();
    db.upsertSession({ sessionId: "sess-no-pid", state: "connecting", pid: undefined });

    const result = reapOrphanedSessions(db);
    expect(result).toBe(0);

    // Session should be ended in DB
    const sessions = db.listSessions(true);
    expect(sessions).toHaveLength(0);
    const ended = db.listSessions(false);
    expect(ended.find((s) => s.sessionId === "sess-no-pid")).toBeTruthy();
  });

  test("kills alive process and marks session ended", () => {
    const db = createDb();
    const fakePid = 99999;
    db.upsertSession({ sessionId: "sess-alive", state: "running", pid: fakePid });

    const killCalls: Array<[number, number | string | undefined]> = [];
    const origKill = process.kill.bind(process);
    process.kill = (pid: number, signal?: number | string): true => {
      killCalls.push([pid, signal]);
      return true;
    };

    const result = reapOrphanedSessions(db);
    process.kill = origKill;

    expect(result).toBe(1);
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]).toEqual([fakePid, "SIGTERM"]);

    // Session should be ended
    const active = db.listSessions(true);
    expect(active).toHaveLength(0);
  });

  test("skips kill for already-dead process, still marks session ended", () => {
    const db = createDb();
    const deadPid = 88888;
    db.upsertSession({ sessionId: "sess-dead", state: "running", pid: deadPid });

    const origKill = process.kill.bind(process);
    // Mock process.kill: SIGTERM throws ESRCH (process not found)
    process.kill = (_pid: number, _signal?: number | string): true => {
      throw new Error("ESRCH");
    };

    const result = reapOrphanedSessions(db);
    process.kill = origKill;

    expect(result).toBe(0);

    // Session should still be ended in DB
    const active = db.listSessions(true);
    expect(active).toHaveLength(0);
  });

  test("handles multiple sessions: kills alive, skips dead", () => {
    const db = createDb();
    const alivePid = 77777;
    const deadPid = 66666;

    db.upsertSession({ sessionId: "sess-1", state: "running", pid: alivePid });
    db.upsertSession({ sessionId: "sess-2", state: "running", pid: deadPid });
    db.upsertSession({ sessionId: "sess-3", state: "connecting", pid: undefined });

    const origKill = process.kill.bind(process);
    process.kill = (pid: number, _signal?: number | string): true => {
      if (pid === deadPid) throw new Error("ESRCH");
      return true;
    };

    const result = reapOrphanedSessions(db);
    process.kill = origKill;

    expect(result).toBe(1);
    // All sessions should be ended
    expect(db.listSessions(true)).toHaveLength(0);
    expect(db.listSessions(false)).toHaveLength(3);
  });

  test("already-ended sessions are not touched", () => {
    const db = createDb();
    db.upsertSession({ sessionId: "sess-old", state: "ended", pid: 55555 });
    db.endSession("sess-old");

    const origKill = process.kill.bind(process);
    let killCalled = false;
    process.kill = (): true => {
      killCalled = true;
      return true;
    };

    const result = reapOrphanedSessions(db);
    process.kill = origKill;

    expect(result).toBe(0);
    expect(killCalled).toBe(false);
  });
});
