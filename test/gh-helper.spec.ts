import { describe, expect, test } from "bun:test";
import { _inflightSize, gh, spawn } from "../.claude/phases/gh";

describe("spawn — async subprocess wrapper", () => {
  test("captures stdout from a simple command", async () => {
    const result = await spawn(["echo", "hello"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("captures stderr and non-zero exit code", async () => {
    const result = await spawn(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(result.stderr).toBe("oops");
    expect(result.exitCode).toBe(3);
  });

  test("kills process on timeout", async () => {
    const result = await spawn(["sleep", "30"], { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("gh — dedup", () => {
  test("concurrent identical calls share one promise", async () => {
    const p1 = gh(["version"]);
    expect(_inflightSize()).toBe(1);
    const p2 = gh(["version"]);
    expect(_inflightSize()).toBe(1);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(r1.exitCode).toBe(0);
    expect(_inflightSize()).toBe(0);
  });

  test("skipDedup bypasses dedup", async () => {
    const p1 = gh(["version"], { skipDedup: true });
    const p2 = gh(["version"], { skipDedup: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });

  test("inflight map clears after resolution", async () => {
    await gh(["version"]);
    expect(_inflightSize()).toBe(0);
  });
});
