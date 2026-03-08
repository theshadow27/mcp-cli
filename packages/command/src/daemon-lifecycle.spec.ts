import { afterEach, describe, expect, it, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PID_MAX_AGE_MS, PROTOCOL_VERSION } from "@mcp-cli/core";
import { DaemonStartCooldownError } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { _resetStartCooldown, isDaemonRunning, isProcessMcpd, resolveDaemonCommand } from "./daemon-lifecycle";

// -- isProcessMcpd --

describe("isProcessMcpd", () => {
  test("returns false for PID 1 (launchd/init)", () => {
    expect(isProcessMcpd(1)).toBe(false);
  });

  test("returns false for non-existent PID", () => {
    expect(isProcessMcpd(4294967)).toBe(false);
  });

  test("returns false for current process (bun test runner)", () => {
    expect(isProcessMcpd(process.pid)).toBe(false);
  });
});

// -- isDaemonRunning --

describe("isDaemonRunning", () => {
  test("returns false when no PID file exists", async () => {
    using opts = testOptions();
    expect(await isDaemonRunning()).toBe(false);
  });

  test("returns false and cleans up for invalid JSON in PID file", async () => {
    using opts = testOptions();
    mkdirSync(dirname(opts.PID_PATH), { recursive: true });
    writeFileSync(opts.PID_PATH, "not valid json{{{");
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(opts.PID_PATH)).toBe(false);
  });

  test("returns false and cleans up for PID file older than max age", async () => {
    using opts = testOptions();
    const staleData = {
      pid: process.pid,
      configHash: "abc123",
      startedAt: Date.now() - PID_MAX_AGE_MS - 1000,
    };
    mkdirSync(dirname(opts.PID_PATH), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(staleData));
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(opts.PID_PATH)).toBe(false);
  });

  test("returns false and cleans up for missing startedAt field", async () => {
    using opts = testOptions();
    const badData = { pid: process.pid, configHash: "abc123" };
    mkdirSync(dirname(opts.PID_PATH), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(badData));
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(opts.PID_PATH)).toBe(false);
  });

  test("returns false and cleans up when process does not exist", async () => {
    using opts = testOptions();
    const data = {
      pid: 4294967, // very unlikely to be a real process
      configHash: "abc123",
      startedAt: Date.now(),
    };
    mkdirSync(dirname(opts.PID_PATH), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(data));
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(opts.PID_PATH)).toBe(false);
  });

  test("returns false when PID belongs to a non-mcpd process", async () => {
    using opts = testOptions();
    const data = {
      pid: process.pid,
      configHash: "abc123",
      startedAt: Date.now(),
    };
    mkdirSync(dirname(opts.PID_PATH), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(data));
    expect(await isDaemonRunning()).toBe(false);
  });

  it("returns false for PID file with mismatched protocolVersion", async () => {
    using opts = testOptions();
    const data = {
      pid: process.pid,
      configHash: "test",
      startedAt: Date.now(),
      protocolVersion: "wrong-version",
    };
    mkdirSync(join(opts.PID_PATH, ".."), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(data));

    // isDaemonRunning will fail at isProcessMcpd (test process isn't mcpd)
    // before reaching the version check, but we can verify it returns false
    const result = await isDaemonRunning();
    expect(result).toBe(false);
  });

  it("returns false for PID file without protocolVersion (old daemon)", async () => {
    using opts = testOptions();
    const data = {
      pid: process.pid,
      configHash: "test",
      startedAt: Date.now(),
      // no protocolVersion — simulates old daemon
    };
    mkdirSync(join(opts.PID_PATH, ".."), { recursive: true });
    writeFileSync(opts.PID_PATH, JSON.stringify(data));

    const result = await isDaemonRunning();
    expect(result).toBe(false);
  });
});

// -- resolveDaemonCommand --

describe("resolveDaemonCommand", () => {
  test("returns array starting with 'bun' in dev mode", () => {
    const cmd = resolveDaemonCommand();
    // In the source tree, dev mode should be detected
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toBe("run");
    expect(cmd.length).toBe(3);
  });

  test("returned dev script path actually exists on disk", () => {
    const cmd = resolveDaemonCommand();
    expect(existsSync(cmd[2])).toBe(true);
  });
});

// -- Startup lock file mechanics --

const TEST_DIR = join(tmpdir(), `mcp-ipc-test-${Date.now()}`);
const LOCK_FILE = join(TEST_DIR, "test.lock");

describe("startup lock file", () => {
  afterEach(() => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  });

  it("O_EXCL prevents two processes from creating the same lock", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const fd = openSync(LOCK_FILE, "wx");
    expect(fd).toBeGreaterThan(0);

    expect(() => openSync(LOCK_FILE, "wx")).toThrow();

    closeSync(fd);
  });

  it("lock is released after unlink", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const fd1 = openSync(LOCK_FILE, "wx");
    closeSync(fd1);
    unlinkSync(LOCK_FILE);

    const fd2 = openSync(LOCK_FILE, "wx");
    expect(fd2).toBeGreaterThan(0);
    closeSync(fd2);
  });

  it("lock file cleanup handles already-deleted file", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const fd = openSync(LOCK_FILE, "wx");
    closeSync(fd);
    unlinkSync(LOCK_FILE);

    expect(() => {
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        /* already gone — this is the expected path */
      }
    }).not.toThrow();
  });
});

describe("concurrent daemon startup simulation", () => {
  afterEach(() => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  });

  it("concurrent O_EXCL opens: exactly one succeeds", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const results = await Promise.allSettled(
      Array.from(
        { length: 5 },
        () =>
          new Promise<number>((resolve, reject) => {
            try {
              resolve(openSync(LOCK_FILE, "wx"));
            } catch (e) {
              reject(e);
            }
          }),
      ),
    );

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);

    closeSync((successes[0] as PromiseFulfilledResult<number>).value);
  });
});

// -- DaemonStartCooldownError --

describe("DaemonStartCooldownError", () => {
  afterEach(() => {
    _resetStartCooldown();
  });

  it("includes remaining time and descriptive message", () => {
    const err = new DaemonStartCooldownError(7500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonStartCooldownError");
    expect(err.remainingMs).toBe(7500);
    expect(err.message).toContain("8s"); // Math.ceil(7500/1000)
    expect(err.message).toContain("cooldown");
  });
});

// -- stderr pipe draining --

describe("stderr pipe draining", () => {
  it("TextDecoder.decode with stream: true handles multi-byte chars across chunks", () => {
    const decoder = new TextDecoder();

    const encoded = new TextEncoder().encode("€");
    expect(encoded.length).toBe(3);

    const chunk1 = encoded.slice(0, 2);
    const chunk2 = encoded.slice(2);

    const part1 = decoder.decode(chunk1, { stream: true });
    const part2 = decoder.decode(chunk2, { stream: true });
    const flush = decoder.decode();

    expect(part1 + part2 + flush).toBe("€");
  });

  it("TextDecoder.decode without stream: true corrupts split multi-byte chars", () => {
    const decoder = new TextDecoder();

    const encoded = new TextEncoder().encode("€");
    const chunk1 = encoded.slice(0, 2);
    const chunk2 = encoded.slice(2);

    const part1 = decoder.decode(chunk1);
    const part2 = decoder.decode(chunk2);

    expect(part1 + part2).not.toBe("€");
  });
});
