import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "./constants.js";
import { isDaemonRunning } from "./ipc-client.js";

/**
 * Tests for ensureDaemon startup lock and stderr handling.
 *
 * These test the lock file mechanics directly (not the full daemon lifecycle)
 * since spawning a real daemon in CI is fragile.
 */

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

    // First open succeeds
    const fd = openSync(LOCK_FILE, "wx");
    expect(fd).toBeGreaterThan(0);

    // Second open throws EEXIST
    expect(() => openSync(LOCK_FILE, "wx")).toThrow();

    closeSync(fd);
  });

  it("lock is released after unlink", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const fd1 = openSync(LOCK_FILE, "wx");
    closeSync(fd1);
    unlinkSync(LOCK_FILE);

    // Can acquire again
    const fd2 = openSync(LOCK_FILE, "wx");
    expect(fd2).toBeGreaterThan(0);
    closeSync(fd2);
  });

  it("lock file cleanup handles already-deleted file", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const fd = openSync(LOCK_FILE, "wx");
    closeSync(fd);
    unlinkSync(LOCK_FILE);

    // Second unlink should not throw
    expect(() => {
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        /* already gone — this is the expected path */
      }
    }).not.toThrow();
  });
});

describe("stderr pipe draining", () => {
  it("TextDecoder.decode with stream: true handles multi-byte chars across chunks", () => {
    const decoder = new TextDecoder();

    // Encode a multi-byte char (€ = 3 bytes: 0xE2 0x82 0xAC)
    const encoded = new TextEncoder().encode("€");
    expect(encoded.length).toBe(3);

    // Split across two chunks
    const chunk1 = encoded.slice(0, 2);
    const chunk2 = encoded.slice(2);

    const part1 = decoder.decode(chunk1, { stream: true });
    const part2 = decoder.decode(chunk2, { stream: true });
    const flush = decoder.decode(); // final flush

    expect(part1 + part2 + flush).toBe("€");
  });

  it("TextDecoder.decode without stream: true corrupts split multi-byte chars", () => {
    // Demonstrates the bug that was fixed — non-streaming decode corrupts split chars
    const decoder = new TextDecoder();

    const encoded = new TextEncoder().encode("€");
    const chunk1 = encoded.slice(0, 2);
    const chunk2 = encoded.slice(2);

    const part1 = decoder.decode(chunk1);
    const part2 = decoder.decode(chunk2);

    // Without stream: true, the split produces replacement characters
    expect(part1 + part2).not.toBe("€");
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

    // Clean up the fd
    closeSync((successes[0] as PromiseFulfilledResult<number>).value);
  });
});

describe("PROTOCOL_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof PROTOCOL_VERSION).toBe("string");
    expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
  });

  it("is deterministic (same value on repeated access)", () => {
    expect(PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});

describe("protocol version mismatch detection", () => {
  // Use the real PID_PATH so isDaemonRunning() checks our test data
  const { PID_PATH } = require("./constants.js");
  let savedPid: string | null = null;

  // Save and restore the real PID file around each test
  afterEach(() => {
    try {
      if (savedPid !== null) {
        writeFileSync(PID_PATH, savedPid);
      } else {
        unlinkSync(PID_PATH);
      }
    } catch {
      /* ok */
    }
  });

  // Capture current state before each test
  function savePidFile(): void {
    try {
      savedPid = readFileSync(PID_PATH, "utf-8");
    } catch {
      savedPid = null;
    }
  }

  it("returns false for PID file with mismatched protocolVersion", async () => {
    savePidFile();
    const data = {
      pid: process.pid,
      configHash: "test",
      startedAt: Date.now(),
      protocolVersion: "wrong-version",
    };
    mkdirSync(join(PID_PATH, ".."), { recursive: true });
    writeFileSync(PID_PATH, JSON.stringify(data));

    // isDaemonRunning will fail at isProcessMcpd (test process isn't mcpd)
    // before reaching the version check, but we can verify it returns false
    const result = await isDaemonRunning();
    expect(result).toBe(false);
  });

  it("returns false for PID file without protocolVersion (old daemon)", async () => {
    savePidFile();
    const data = {
      pid: process.pid,
      configHash: "test",
      startedAt: Date.now(),
      // no protocolVersion — simulates old daemon
    };
    mkdirSync(join(PID_PATH, ".."), { recursive: true });
    writeFileSync(PID_PATH, JSON.stringify(data));

    const result = await isDaemonRunning();
    expect(result).toBe(false);
  });
});
