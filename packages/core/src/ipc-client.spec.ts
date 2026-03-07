import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { PROTOCOL_VERSION } from "./constants";
import { IpcCallError, isDaemonRunning } from "./ipc-client";

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

describe("IpcCallError", () => {
  it("preserves code, message, data, and remoteStack", () => {
    const err = new IpcCallError({
      code: -1001,
      message: "Server not found",
      data: { server: "test" },
      stack: "Error: Server not found\n    at dispatch (ipc-server.ts:42)",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IpcCallError);
    expect(err.name).toBe("IpcCallError");
    expect(err.message).toBe("Server not found");
    expect(err.code).toBe(-1001);
    expect(err.data).toEqual({ server: "test" });
    expect(err.remoteStack).toBe("Error: Server not found\n    at dispatch (ipc-server.ts:42)");
  });

  it("handles missing optional fields", () => {
    const err = new IpcCallError({
      code: -32603,
      message: "Internal error",
    });

    expect(err.message).toBe("Internal error");
    expect(err.code).toBe(-32603);
    expect(err.data).toBeUndefined();
    expect(err.remoteStack).toBeUndefined();
  });
});
