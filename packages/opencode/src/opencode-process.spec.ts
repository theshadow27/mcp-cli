import { describe, expect, test } from "bun:test";
import { OpenCodeProcess, type SpawnFn, type SpawnResult, discoverUrl } from "./opencode-process";

// ── Helper: create a mock spawn function ──

function mockSpawn(opts?: {
  stdout?: ReadableStream<Uint8Array> | null;
  pid?: number;
  exitCode?: number;
  /** If true, the exited promise never resolves. */
  hang?: boolean;
}): { spawnFn: SpawnFn; result: SpawnResult; killSignals: Array<number | NodeJS.Signals> } {
  const encoder = new TextEncoder();
  const killSignals: Array<number | NodeJS.Signals> = [];

  const stdout =
    opts?.stdout !== undefined
      ? opts.stdout
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("listening on http://127.0.0.1:8888\n"));
            controller.close();
          },
        });

  let resolveExited: (code: number | undefined) => void;
  const exitedPromise = opts?.hang
    ? new Promise<number | undefined>(() => {}) // never resolves
    : new Promise<number | undefined>((resolve) => {
        resolveExited = resolve;
        if (opts?.exitCode !== undefined) {
          // Resolve after a tick to simulate async exit
          queueMicrotask(() => resolve(opts.exitCode));
        }
      });

  const result: SpawnResult = {
    pid: opts?.pid ?? 12345,
    stdout,
    exited: exitedPromise,
    kill(signal?: number | NodeJS.Signals) {
      killSignals.push(signal ?? "SIGTERM");
    },
  };

  const spawnFn: SpawnFn = () => result;
  return { spawnFn, result, killSignals };
}

// ── discoverUrl (pure function tests, carried over from original) ──

describe("discoverUrl", () => {
  test("discovers URL from stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("Starting server...\n"));
        controller.enqueue(encoder.encode("opencode server listening on http://127.0.0.1:54321\n"));
        controller.close();
      },
    });

    const url = await discoverUrl(stream, 5000);
    expect(url).toBe("http://127.0.0.1:54321");
  });

  test("discovers URL from partial line (no trailing newline)", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("listening on http://127.0.0.1:9999"));
        // Don't close — the URL should be found in the buffer
      },
    });

    const url = await discoverUrl(stream, 5000);
    expect(url).toBe("http://127.0.0.1:9999");
  });

  test("throws on null stdout", async () => {
    await expect(discoverUrl(null, 100)).rejects.toThrow("No stdout stream available");
  });

  test("throws when stream closes without URL", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("no url here\n"));
        controller.close();
      },
    });

    await expect(discoverUrl(stream, 5000)).rejects.toThrow("Process stdout closed before URL was discovered");
  });

  test("throws on timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue anything — will timeout
      },
    });

    await expect(discoverUrl(stream, 50)).rejects.toThrow("URL discovery timeout");
  });
});

// ── OpenCodeProcess class tests ──

describe("OpenCodeProcess", () => {
  test("spawn() discovers URL and sets baseUrl", async () => {
    const { spawnFn } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    const url = await proc.spawn();
    expect(url).toBe("http://127.0.0.1:8888");
    expect(proc.baseUrl).toBe("http://127.0.0.1:8888");
  });

  test("spawn() exposes pid", async () => {
    const { spawnFn } = mockSpawn({ pid: 42, hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    await proc.spawn();
    expect(proc.pid).toBe(42);
  });

  test("spawn() sets alive=true before exit", async () => {
    const { spawnFn } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    await proc.spawn();
    expect(proc.alive).toBe(true);
    expect(proc.exited).toBe(false);
  });

  test("spawn() throws on double call", async () => {
    const { spawnFn } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    await proc.spawn();
    await expect(proc.spawn()).rejects.toThrow("OpenCodeProcess already spawned");
  });

  test("spawn() throws when stdout is null", async () => {
    const { spawnFn } = mockSpawn({ stdout: null, hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    await expect(proc.spawn()).rejects.toThrow("stdout not available");
  });

  test("kill() sends SIGTERM", async () => {
    const { spawnFn, killSignals } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    await proc.spawn();
    proc.kill();
    expect(killSignals).toContain("SIGTERM");
  });

  test("kill() is a no-op before spawn", () => {
    const { spawnFn, killSignals } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    proc.kill(); // should not throw
    expect(killSignals).toEqual([]);
  });

  test("onExit callback fires when process exits", async () => {
    let exitCode: unknown = null;
    const { spawnFn, result } = mockSpawn({ exitCode: 0 });
    const proc = new OpenCodeProcess({
      cwd: "/tmp",
      spawnFn,
      onExit: (code) => {
        exitCode = code;
      },
    });

    await proc.spawn();
    // Await the same promise the process monitors so our continuation is enqueued
    // after the .then() reaction in spawn() — deterministic regardless of microtask depth.
    await result.exited;
    expect(exitCode).toBe(0);
    expect(proc.exited).toBe(true);
    expect(proc.alive).toBe(false);
  });

  test("onExit is not called twice if already exited", async () => {
    let callCount = 0;
    const encoder = new TextEncoder();
    let resolveExited!: (code: number | undefined) => void;
    const exitedPromise = new Promise<number | undefined>((r) => {
      resolveExited = r;
    });

    const result: SpawnResult = {
      pid: 1,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("http://127.0.0.1:1111\n"));
          controller.close();
        },
      }),
      exited: exitedPromise,
      kill() {},
    };

    const proc = new OpenCodeProcess({
      cwd: "/tmp",
      spawnFn: () => result,
      onExit: () => {
        callCount++;
      },
    });

    await proc.spawn();

    // Trigger exit
    resolveExited(0);
    // Await the same promise the process monitors so our continuation is enqueued
    // after the .then() reaction in spawn() — deterministic regardless of microtask depth.
    await exitedPromise;
    // Promise only resolves once, so verify the guard works
    expect(callCount).toBe(1);
  });

  test("getters return defaults before spawn", () => {
    const { spawnFn } = mockSpawn({ hang: true });
    const proc = new OpenCodeProcess({ cwd: "/tmp", spawnFn });

    expect(proc.baseUrl).toBeNull();
    expect(proc.pid).toBeUndefined();
    expect(proc.alive).toBe(false);
    expect(proc.exited).toBe(false);
  });

  test("passes cwd and env to spawn function", async () => {
    let capturedCmd: string[] = [];
    let capturedOpts: Record<string, unknown> = {};
    const encoder = new TextEncoder();

    const spawnFn: SpawnFn = (cmd, opts) => {
      capturedCmd = cmd;
      capturedOpts = opts;
      return {
        pid: 1,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("http://127.0.0.1:5555\n"));
            controller.close();
          },
        }),
        exited: new Promise(() => {}),
        kill() {},
      };
    };

    const proc = new OpenCodeProcess({
      cwd: "/my/project",
      env: { OPENCODE_TOKEN: "secret" },
      spawnFn,
    });

    await proc.spawn();
    expect(capturedCmd).toEqual(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"]);
    expect(capturedOpts.cwd).toBe("/my/project");
    expect((capturedOpts.env as Record<string, string>).OPENCODE_TOKEN).toBe("secret");
  });
});
