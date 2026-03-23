import { describe, expect, mock, test } from "bun:test";
import { silentLogger } from "@mcp-cli/core";
import type { Logger } from "@mcp-cli/core";
import { killPid } from "./process-util";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until process is dead or deadline reached. */
async function awaitDeath(pid: number, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await Bun.sleep(50);
  }
}

/** Force-kill a PID if still alive (test cleanup safety net). */
function forceKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
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
    const proc = Bun.spawn(
      ["perl", "-e", '$|=1; $SIG{TERM}="IGNORE"; print "ready\n"; sleep 60'],
      { stdout: "pipe", stderr: "ignore" },
    );
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
