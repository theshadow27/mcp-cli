import { describe, expect, test } from "bun:test";
import { AcpProcess } from "./acp-process";

const POLL_MS = 10;

describe("AcpProcess", () => {
  test("spawns a process and receives NDJSON messages", async () => {
    const messages: Record<string, unknown>[] = [];
    let exitCode: number | null | undefined;

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: [
        "bash",
        "-c",
        'echo \'{"jsonrpc":"2.0","method":"test","params":{}}\'; echo \'{"jsonrpc":"2.0","id":1,"result":"ok"}\'',
      ],
      onMessage: (msg) => messages.push(msg),
      onExit: (code) => {
        exitCode = code;
      },
    });

    proc.spawn();
    expect(proc.alive).toBe(true);
    expect(proc.pid).toBeDefined();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "test", params: {} });
    expect(messages[1]).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect(exitCode as number).toBe(0);
    expect(proc.alive).toBe(false);
  });

  test("malformed lines after the first JSON frame go to onError", async () => {
    const errors: string[] = [];
    const preamble: string[] = [];

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", "echo '{\"valid\":true}'; echo 'not json'"],
      onMessage: () => {},
      onExit: () => {},
      onError: (_err, rawLine) => errors.push(rawLine),
      onPreamble: (rawLine) => preamble.push(rawLine),
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(errors).toEqual(["not json"]);
    expect(preamble).toHaveLength(0);
  });

  test("skips a non-JSON preamble banner before the first JSON frame", async () => {
    const messages: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const preamble: string[] = [];

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: [
        "bash",
        "-c",
        'echo \'A new version of Grok Build is available: 0.2.91 -> 0.2.93 [stable]\'; echo \'{"jsonrpc":"2.0","id":1,"result":"ok"}\'',
      ],
      onMessage: (msg) => messages.push(msg),
      onExit: () => {},
      onError: (_err, rawLine) => errors.push(rawLine),
      onPreamble: (rawLine) => preamble.push(rawLine),
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(errors).toHaveLength(0);
    expect(preamble).toEqual(["A new version of Grok Build is available: 0.2.91 -> 0.2.93 [stable]"]);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "ok" }]);
    expect(proc.preambleText).toContain("A new version of Grok Build");
  });

  test("preambleText is empty when stdout leads with a JSON frame", async () => {
    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", 'echo \'{"jsonrpc":"2.0","id":1,"result":"ok"}\''],
      onMessage: () => {},
      onExit: () => {},
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(proc.preambleText).toBe("");
  });

  test("write sends NDJSON to stdin", async () => {
    const messages: Record<string, unknown>[] = [];

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", 'read line && echo "$line"'],
      onMessage: (msg) => messages.push(msg),
      onExit: () => {},
    });

    proc.spawn();
    await proc.write({ jsonrpc: "2.0", method: "test" });

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "test" });
  });

  test("kill sends SIGTERM", async () => {
    let exitCalled = false;

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["sleep", "60"],
      onMessage: () => {},
      onExit: () => {
        exitCalled = true;
      },
    });

    proc.spawn();
    expect(proc.alive).toBe(true);

    proc.kill();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(exitCalled).toBe(true);
    expect(proc.alive).toBe(false);
  });

  test("throws if spawned twice", () => {
    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["true"],
      onMessage: () => {},
      onExit: () => {},
    });

    proc.spawn();
    expect(() => proc.spawn()).toThrow("already spawned");
  });

  test("throws if write called before spawn", async () => {
    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["true"],
      onMessage: () => {},
      onExit: () => {},
    });

    await expect(proc.write({ test: true })).rejects.toThrow("not spawned");
  });

  test("captures stderr when onStderr is provided", async () => {
    const stderrChunks: string[] = [];

    const proc = new AcpProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", "echo error >&2"],
      onMessage: () => {},
      onExit: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }

    expect(stderrChunks.join("")).toContain("error");
  });
});
