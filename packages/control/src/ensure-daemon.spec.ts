import { describe, expect, it } from "bun:test";
import { resolveDaemonCommand } from "@mcp-cli/core";
import { ensureDaemonRunning } from "./ensure-daemon";

/** Create a mock ReadableStream from a string, optionally with a delay */
function mockStream(data: string, delayMs = 0): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(data);
  return new ReadableStream({
    async start(controller) {
      if (delayMs > 0) await Bun.sleep(delayMs);
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

/** Create a mock stream that emits chunks slowly (simulates slow process) */
function slowStream(intervalMs: number, count: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(".");
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < count; i++) {
        await Bun.sleep(intervalMs);
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

describe("resolveDaemonCommand", () => {
  it("returns an array of strings", () => {
    const cmd = resolveDaemonCommand(import.meta.dir);
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.length).toBeGreaterThan(0);
    for (const part of cmd) {
      expect(typeof part).toBe("string");
    }
  });
});

describe("ensureDaemonRunning", () => {
  it("returns true immediately if daemon is already alive", async () => {
    const result = await ensureDaemonRunning({
      ping: async () => true,
    });
    expect(result).toBe(true);
  });

  it("spawns daemon and returns true when ready signal received", async () => {
    let spawned = false;
    let unrefCalled = false;

    const result = await ensureDaemonRunning({
      ping: async () => false,
      spawn: () => {
        spawned = true;
        return {
          stdout: mockStream("starting...\nMCPD_READY\n"),
          stderr: mockStream(""),
          unref: () => {
            unrefCalled = true;
          },
          kill: () => {},
        };
      },
      resolveCmd: () => ["fake-mcpd"],
      readySignal: "MCPD_READY",
      timeoutMs: 1000,
    });

    expect(result).toBe(true);
    expect(spawned).toBe(true);
    expect(unrefCalled).toBe(true);
  });

  it("returns false when process exits without ready signal", async () => {
    const result = await ensureDaemonRunning({
      ping: async () => false,
      spawn: () => ({
        stdout: mockStream("some output but no signal\n"),
        stderr: mockStream(""),
        unref: () => {},
        kill: () => {},
      }),
      resolveCmd: () => ["fake-mcpd"],
      readySignal: "MCPD_READY",
      timeoutMs: 1000,
    });

    expect(result).toBe(false);
  });

  it("falls back to ping after timeout", async () => {
    let pingCount = 0;

    const result = await ensureDaemonRunning({
      ping: async () => {
        pingCount++;
        // Second ping (after timeout) succeeds
        return pingCount > 1;
      },
      spawn: () => ({
        // Emit dots slowly — exceeds timeout without ready signal
        stdout: slowStream(20, 10),
        stderr: mockStream(""),
        unref: () => {},
        kill: () => {},
      }),
      resolveCmd: () => ["fake-mcpd"],
      readySignal: "MCPD_READY",
      timeoutMs: 50, // Short timeout for test
    });

    expect(result).toBe(true);
    expect(pingCount).toBe(2);
  });

  it("returns false when spawn throws", async () => {
    const result = await ensureDaemonRunning({
      ping: async () => false,
      spawn: () => {
        throw new Error("spawn failed");
      },
      resolveCmd: () => ["nonexistent"],
      readySignal: "MCPD_READY",
      timeoutMs: 1000,
    });

    expect(result).toBe(false);
  });

  it("returns false when resolveCmd throws", async () => {
    const result = await ensureDaemonRunning({
      ping: async () => false,
      spawn: () => ({
        stdout: mockStream(""),
        stderr: mockStream(""),
        unref: () => {},
        kill: () => {},
      }),
      resolveCmd: () => {
        throw new Error("no binary found");
      },
      readySignal: "MCPD_READY",
      timeoutMs: 1000,
    });

    expect(result).toBe(false);
  });
});
