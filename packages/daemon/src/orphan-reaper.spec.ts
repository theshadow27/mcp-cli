import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturingLogger, silentLogger } from "@mcp-cli/core";
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
    const result = reapOrphanedSessions(db, silentLogger);
    expect(result).toBe(0);
  });

  test("marks sessions as ended when pid is null", () => {
    const db = createDb();
    db.upsertSession({ sessionId: "sess-no-pid", state: "connecting", pid: undefined });

    const result = reapOrphanedSessions(db, silentLogger);
    expect(result).toBe(1);

    // Session should be ended in DB
    const sessions = db.listSessions(true);
    expect(sessions).toHaveLength(0);
    const ended = db.listSessions(false);
    expect(ended.find((s) => s.sessionId === "sess-no-pid")).toBeTruthy();
  });

  test("preserves alive process — does NOT end session", () => {
    const db = createDb();
    // Use current process PID so it's definitely alive
    const alivePid = process.pid;
    db.upsertSession({ sessionId: "sess-alive", state: "running", pid: alivePid });

    const { logger, messages } = capturingLogger();
    const result = reapOrphanedSessions(db, logger);

    // Should NOT have ended the session — it has a live process
    expect(result).toBe(0);

    // Session should still be active in DB
    const active = db.listSessions(true);
    expect(active).toHaveLength(1);
    expect(active[0]?.sessionId).toBe("sess-alive");

    // Should log that it's preserving the session
    expect(messages.some((m) => m.level === "info" && String(m.args[0]).includes("Preserving"))).toBe(true);
  });

  test("cleans up dead process — marks session ended", () => {
    const db = createDb();
    const deadPid = 88888;
    db.upsertSession({ sessionId: "sess-dead", state: "running", pid: deadPid });

    const result = reapOrphanedSessions(db, silentLogger);

    expect(result).toBe(1);

    // Session should be ended in DB
    const active = db.listSessions(true);
    expect(active).toHaveLength(0);
  });

  test("handles multiple sessions: preserves alive, cleans dead", () => {
    const db = createDb();
    const alivePid = process.pid; // definitely alive
    const deadPid = 88888; // definitely dead

    db.upsertSession({ sessionId: "sess-alive", state: "running", pid: alivePid });
    db.upsertSession({ sessionId: "sess-dead", state: "running", pid: deadPid });
    db.upsertSession({ sessionId: "sess-no-pid", state: "connecting", pid: undefined });

    const result = reapOrphanedSessions(db, silentLogger);

    // Only dead + no-pid sessions should be cleaned
    expect(result).toBe(2);
    // Alive session should still be active
    const active = db.listSessions(true);
    expect(active).toHaveLength(1);
    expect(active[0]?.sessionId).toBe("sess-alive");
    // Dead + no-pid sessions should be ended
    const ended = db.listSessions(false);
    expect(ended).toHaveLength(2);
  });

  test("cleans up session when PID has been recycled (pidStartTime mismatch)", () => {
    const db = createDb();
    const recycledPid = 44444;
    const storedStartTime = 1000000;
    db.upsertSession({ sessionId: "sess-recycled", state: "running", pid: recycledPid, pidStartTime: storedStartTime });

    const { logger, messages } = capturingLogger();
    // Inject isOurProcess that always returns false — simulates PID recycled
    const result = reapOrphanedSessions(db, logger, {
      isOurProcess: () => false,
    });

    // Should have cleaned up the stale session
    expect(result).toBe(1);

    // Should have logged a warning about dead/recycled PID
    expect(messages.some((m) => m.level === "warn" && String(m.args[0]).includes("dead or recycled"))).toBe(true);

    // Session should be ended in DB
    expect(db.listSessions(true)).toHaveLength(0);
  });

  test("preserves alive process with matching pidStartTime", () => {
    const db = createDb();
    const pid = process.pid;
    const storedStartTime = 1000000;
    db.upsertSession({ sessionId: "sess-verified", state: "running", pid, pidStartTime: storedStartTime });

    const { logger, messages } = capturingLogger();
    // Inject isOurProcess that returns true — deterministic, no timing dependency
    const result = reapOrphanedSessions(db, logger, {
      isOurProcess: () => true,
    });

    // Should preserve the session
    expect(result).toBe(0);
    expect(db.listSessions(true)).toHaveLength(1);
    expect(messages.some((m) => m.level === "info" && String(m.args[0]).includes("Preserving"))).toBe(true);
  });

  test("already-ended sessions are not touched", () => {
    const db = createDb();
    db.upsertSession({ sessionId: "sess-old", state: "ended", pid: 55555 });
    db.endSession("sess-old");

    const result = reapOrphanedSessions(db, silentLogger);

    expect(result).toBe(0);
  });
});
