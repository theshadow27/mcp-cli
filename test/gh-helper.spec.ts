import { describe, expect, test } from "bun:test";
import { spawn } from "../.claude/phases/gh";

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
