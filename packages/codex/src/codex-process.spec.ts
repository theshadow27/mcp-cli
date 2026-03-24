import { describe, expect, test } from "bun:test";
import { CodexProcess } from "./codex-process";

describe("CodexProcess", () => {
  test("spawns a process and receives JSONL messages", async () => {
    const messages: Record<string, unknown>[] = [];
    let exitCode: number | null | undefined;

    const proc = new CodexProcess({
      cwd: process.cwd(),
      // Use a simple command that outputs JSON lines
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

    // Wait for process to complete
    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "test", params: {} });
    expect(messages[1]).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    expect(exitCode as number).toBe(0);
    expect(proc.alive).toBe(false);
  });

  test("handles malformed JSONL lines via onError", async () => {
    const errors: string[] = [];

    const proc = new CodexProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", "echo 'not json'; echo '{\"valid\":true}'"],
      onMessage: () => {},
      onExit: () => {},
      onError: (_err, rawLine) => errors.push(rawLine),
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("not json");
  });

  test("write sends JSONL to stdin", async () => {
    // Use a script that reads one line, echoes it back, then exits
    const messages: Record<string, unknown>[] = [];

    const proc = new CodexProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", 'read line && echo "$line"'],
      onMessage: (msg) => messages.push(msg),
      onExit: () => {},
    });

    proc.spawn();
    await proc.write({ jsonrpc: "2.0", method: "test" });

    // Wait for process to exit naturally after echoing
    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "test" });
  });

  test("kill sends SIGTERM", async () => {
    let exitCalled = false;

    const proc = new CodexProcess({
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
      await Bun.sleep(10);
    }

    expect(exitCalled).toBe(true);
    expect(proc.alive).toBe(false);
  });

  test("throws if spawned twice", () => {
    const proc = new CodexProcess({
      cwd: process.cwd(),
      command: ["true"],
      onMessage: () => {},
      onExit: () => {},
    });

    proc.spawn();
    expect(() => proc.spawn()).toThrow("already spawned");
  });

  test("throws if write called before spawn", async () => {
    const proc = new CodexProcess({
      cwd: process.cwd(),
      command: ["true"],
      onMessage: () => {},
      onExit: () => {},
    });

    await expect(proc.write({ test: true })).rejects.toThrow("not spawned");
  });

  test("captures stderr when onStderr is provided", async () => {
    const stderrChunks: string[] = [];

    const proc = new CodexProcess({
      cwd: process.cwd(),
      command: ["bash", "-c", "echo error >&2"],
      onMessage: () => {},
      onExit: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    proc.spawn();

    const deadline = Date.now() + 5000;
    while (!proc.exited && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(stderrChunks.join("")).toContain("error");
  });
});
