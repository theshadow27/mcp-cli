import { describe, expect, mock, test } from "bun:test";
import { silentLogger } from "@mcp-cli/core";
import type { Logger } from "@mcp-cli/core";
import { findProcessesByCwd, killPid, reapWorktreeProcesses } from "./process-util";

const POLL_MS = 10;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
    // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
  } catch {
    return false;
  }
}

/** Poll until process is dead or deadline reached. */
async function awaitDeath(pid: number, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await Bun.sleep(POLL_MS);
  }
}

/** Force-kill a PID if still alive (test cleanup safety net). */
function forceKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
    // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
  } catch {
    // already dead
  }
}

/** Logger that captures messages for assertion. */
function capturingLogger(): Logger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    info: () => {},
    warn: (...args: unknown[]) => warns.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
    debug: () => {},
    warns,
    errors,
  };
}

describe("killPid", () => {
  test("kills a live process via SIGTERM", async () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    try {
      expect(isAlive(pid)).toBe(true);
      await killPid(pid, silentLogger);
      await awaitDeath(pid);
      expect(isAlive(pid)).toBe(false);
    } finally {
      forceKill(pid);
    }
  });

  test("does not throw for already-dead process (ESRCH)", async () => {
    const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited; // wait for it to die
    // Should not throw
    await killPid(proc.pid, silentLogger);
  });

  test("logs EPERM warning when not permitted to kill", async () => {
    // PID 1 (launchd/init) is not killable by a regular user
    const logger = capturingLogger();
    await killPid(1, logger);
    expect(logger.warns.some((w) => w.includes("EPERM"))).toBe(true);
  });

  test("skips kill when PID has been recycled (pidStartTime mismatch)", async () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    try {
      const logger = capturingLogger();
      // Use a start time far in the past — will not match
      await killPid(pid, logger, { pidStartTime: 1_000_000 });
      // Process should still be alive — kill was skipped
      expect(isAlive(pid)).toBe(true);
      expect(logger.warns.some((w) => w.includes("recycled"))).toBe(true);
    } finally {
      forceKill(pid);
    }
  });

  test("escalates to SIGKILL when process ignores SIGTERM", async () => {
    // Spawn a process that traps SIGTERM and refuses to die.
    // The perl process prints "ready" to stdout after setting up the trap,
    // so we can wait for the signal handler before sending SIGTERM.
    const proc = Bun.spawn(["perl", "-e", '$|=1; $SIG{TERM}="IGNORE"; print "ready\n"; sleep 60'], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const pid = proc.pid;
    try {
      // Wait for perl to finish setting up its signal handler
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value).trim()).toBe("ready");
      reader.releaseLock();

      expect(isAlive(pid)).toBe(true);
      const logger = capturingLogger();
      // Use a very short SIGTERM timeout so we quickly escalate to SIGKILL
      await killPid(pid, logger, { killTimeoutMs: 200 });
      await awaitDeath(pid);
      expect(isAlive(pid)).toBe(false);
      expect(logger.errors.some((e) => e.includes("SIGKILL"))).toBe(true);
    } finally {
      forceKill(pid);
    }
  });

  test("skips ownership check when cachedAtMs is fresh (#2437)", async () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    try {
      // pidStartTime is wrong (would trigger recycled-PID skip), but cachedAtMs is fresh
      await killPid(pid, silentLogger, { pidStartTime: 1_000_000, cachedAtMs: Date.now() });
      await awaitDeath(pid);
      expect(isAlive(pid)).toBe(false);
    } finally {
      forceKill(pid);
    }
  });

  test("still checks ownership when cachedAtMs is stale (#2437)", async () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    try {
      const logger = capturingLogger();
      // pidStartTime is wrong AND cachedAtMs is >30s ago — should skip kill
      await killPid(pid, logger, { pidStartTime: 1_000_000, cachedAtMs: Date.now() - 60_000 });
      expect(isAlive(pid)).toBe(true);
      expect(logger.warns.some((w) => w.includes("recycled"))).toBe(true);
    } finally {
      forceKill(pid);
    }
  });

  test("proceeds without ownership check when pidStartTime is null", async () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    try {
      await killPid(pid, silentLogger, { pidStartTime: null });
      await awaitDeath(pid);
      expect(isAlive(pid)).toBe(false);
    } finally {
      forceKill(pid);
    }
  });
});

describe("findProcessesByCwd", () => {
  test("finds a process whose cwd is under the given directory", () => {
    const tmpDir = `${import.meta.dir}/__test-cwd-${process.pid}`;
    const { mkdirSync, rmdirSync } = require("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", cwd: tmpDir });
    try {
      // lsof needs a moment to see the new process
      Bun.sleepSync(200);
      const pids = findProcessesByCwd(tmpDir, silentLogger);
      expect(pids).toContain(proc.pid);
    } finally {
      forceKill(proc.pid);
      try {
        rmdirSync(tmpDir);
        // dotw-ignore test-empty-catch: best-effort cleanup — dir may already be gone
      } catch {
        /* noop */
      }
    }
  });

  test("excludes current process from results", () => {
    const pids = findProcessesByCwd(import.meta.dir, silentLogger);
    expect(pids).not.toContain(process.pid);
  });

  test("returns empty array for nonexistent directory", () => {
    const pids = findProcessesByCwd("/tmp/__nonexistent-dir-test-2493", silentLogger);
    expect(pids).toEqual([]);
  });
});

describe("reapWorktreeProcesses", () => {
  test("kills processes under the given directory and returns count", async () => {
    const tmpDir = `${import.meta.dir}/__test-reap-${process.pid}`;
    const { mkdirSync, rmdirSync } = require("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const proc1 = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", cwd: tmpDir });
    const proc2 = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", cwd: tmpDir });
    try {
      Bun.sleepSync(200);
      const logger = capturingLogger();
      const killed = reapWorktreeProcesses(tmpDir, logger);
      expect(killed).toBeGreaterThanOrEqual(2);
      await awaitDeath(proc1.pid);
      await awaitDeath(proc2.pid);
      expect(isAlive(proc1.pid)).toBe(false);
      expect(isAlive(proc2.pid)).toBe(false);
    } finally {
      forceKill(proc1.pid);
      forceKill(proc2.pid);
      try {
        rmdirSync(tmpDir);
        // dotw-ignore test-empty-catch: best-effort cleanup — dir may already be gone
      } catch {
        /* noop */
      }
    }
  });

  test("returns 0 when no processes found", () => {
    const killed = reapWorktreeProcesses("/tmp/__nonexistent-dir-test-2493", silentLogger);
    expect(killed).toBe(0);
  });
});
