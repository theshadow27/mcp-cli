/**
 * Stress tests — exercises real-world reliability scenarios.
 *
 * Unlike daemon-integration.spec.ts (which talks directly to the daemon socket),
 * these tests spawn actual `mcx` CLI processes to exercise the full path:
 *   CLI arg parsing → ensureDaemon() → lock contention → IPC → daemon → server
 *
 * Each test group runs in an isolated temp directory via MCP_CLI_DIR.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestDaemon } from "./harness";
import { createTestDir, echoServerConfig, rpc, startTestDaemon } from "./harness";

// These tests involve real process spawning and network I/O
setDefaultTimeout(60_000);

const MCX_SCRIPT = resolve("packages/command/src/main.ts");

/** Run `mcx` as a child process with isolated MCP_CLI_DIR */
async function mcx(
  dir: string,
  args: string[],
  opts?: { timeout?: number; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", MCX_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MCP_CLI_DIR: dir, ...opts?.env },
  });

  const timeout = opts?.timeout ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr: timedOut ? `[TIMEOUT after ${timeout}ms] ${stderr}` : stderr,
  };
}

// ---------------------------------------------------------------------------
// S1: Concurrent auto-start race
// ---------------------------------------------------------------------------
describe("S1: Concurrent auto-start", () => {
  let dir: string;

  afterEach(() => {
    // Kill any daemon left behind (best-effort)
    try {
      const pidFile = join(dir, "mcpd.pid");
      const data = JSON.parse(readFileSync(pidFile, "utf-8"));
      process.kill(data.pid, "SIGTERM");
    } catch {
      // no daemon running, fine
    }
  });

  test("5 simultaneous mcx commands all succeed, exactly one daemon starts", async () => {
    dir = createTestDir();

    // No daemon running. Fire 5 `mcx ls` commands at once.
    // They should all race to auto-start the daemon, exactly one wins the lock,
    // and all 5 should eventually get a response.
    const results = await Promise.all(Array.from({ length: 5 }, () => mcx(dir, ["ls"])));

    // All should exit 0
    const exitCodes = results.map((r) => r.exitCode);
    expect(exitCodes).toEqual([0, 0, 0, 0, 0]);

    // Exactly one daemon should be running
    const pidFile = join(dir, "mcpd.pid");
    const pidData = JSON.parse(readFileSync(pidFile, "utf-8"));
    expect(pidData.pid).toBeGreaterThan(0);

    // Verify it's actually alive
    expect(() => process.kill(pidData.pid, 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// S2: Concurrent tool calls through CLI
// ---------------------------------------------------------------------------
describe("S2: Concurrent CLI tool calls", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("20 concurrent mcx call requests return correct results", async () => {
    const count = 20;

    // Use a generous timeout — spawning 20 concurrent bun processes is CPU-heavy
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        mcx(daemon.dir, ["call", "echo", "add", JSON.stringify({ a: i, b: 1000 })], { timeout: 60_000 }),
      ),
    );

    for (let i = 0; i < count; i++) {
      const r = results[i];
      expect(r.exitCode, `call ${i} failed (stderr: ${r.stderr.slice(0, 200)})`).toBe(0);
      expect(r.stdout.trim()).toContain(String(i + 1000));
    }
  });

  test("rapid sequential calls don't wedge the daemon", async () => {
    // 10 calls in quick succession (not parallel — sequential)
    for (let i = 0; i < 10; i++) {
      const result = await mcx(daemon.dir, ["call", "echo", "echo", JSON.stringify({ message: `seq-${i}` })]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`seq-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// S3: Slow server doesn't block fast server
// ---------------------------------------------------------------------------
describe("S3: Slow server isolation", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({
      echo: echoServerConfig(),
      slow: {
        command: "bun",
        args: [resolve("test/slow-echo-server.ts")],
        env: { SLOW_MS: "3000" },
      },
    });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("fast server responds while slow server is busy", async () => {
    // Fire a slow call and a fast call concurrently, timing each independently
    const fastStart = Date.now();
    const [slowResult, fastResult] = await Promise.all([
      mcx(daemon.dir, ["call", "slow", "slow_echo", JSON.stringify({ message: "slow" })], { timeout: 15_000 }),
      mcx(daemon.dir, ["call", "echo", "echo", JSON.stringify({ message: "fast" })]).then((r) => {
        (r as Record<string, unknown>).elapsed = Date.now() - fastStart;
        return r;
      }),
    ]);

    const fastElapsed = (fastResult as Record<string, unknown>).elapsed as number;

    // Fast should complete successfully — and well before the slow server's 3s delay
    expect(fastResult.stdout).toContain("fast");
    expect(fastResult.exitCode).toBe(0);
    expect(fastElapsed).toBeLessThan(3_000);

    // Slow should also complete (just takes longer)
    expect(slowResult.stdout).toContain("slow");
    expect(slowResult.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S4: Daemon health after errors
// ---------------------------------------------------------------------------
describe("S4: Resilience after errors", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("daemon stays healthy after a burst of error calls", async () => {
    // Fire 5 calls to non-existent servers concurrently
    const errorResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mcx(daemon.dir, ["call", `ghost-${i}`, "anything", "{}"], { timeout: 15_000 }),
      ),
    );

    // All should fail (non-zero exit)
    for (const r of errorResults) {
      expect(r.exitCode).not.toBe(0);
    }

    // Daemon should still respond to valid requests
    const okResult = await mcx(daemon.dir, ["call", "echo", "echo", JSON.stringify({ message: "still alive" })]);
    expect(okResult.exitCode).toBe(0);
    expect(okResult.stdout).toContain("still alive");
  });

  test("interleaved success and failure calls all resolve correctly", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        if (i % 3 === 0) {
          // Every 3rd call targets a non-existent server
          return mcx(daemon.dir, ["call", "ghost", "nope", "{}"], { timeout: 15_000 });
        }
        return mcx(daemon.dir, ["call", "echo", "add", JSON.stringify({ a: i, b: i })], { timeout: 15_000 });
      }),
    );

    for (let i = 0; i < 10; i++) {
      const r = results[i];
      if (i % 3 === 0) {
        expect(r.exitCode).not.toBe(0);
      } else {
        expect(r.exitCode, `call ${i} failed (stderr: ${r.stderr.slice(0, 200)})`).toBe(0);
        expect(r.stdout).toContain(String(i + i));
      }
    }
  });
});
