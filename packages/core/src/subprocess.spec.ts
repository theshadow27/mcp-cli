import { describe, expect, it } from "bun:test";
import { spawnCapture, spawnCaptureSync } from "./subprocess";

describe("spawnCapture", () => {
  it("captures stdout from a successful command", async () => {
    const r = await spawnCapture("echo", ["hello"]);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.signal).toBeNull();
  });

  it("reports failure with non-zero exit code", async () => {
    const r = await spawnCapture("false", []);
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("captures stderr from a failing command", async () => {
    const r = await spawnCapture("ls", ["--no-such-flag-xyzzy"]);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("handles missing binary without throwing", async () => {
    const r = await spawnCapture("nonexistent-binary-xyzzy-42", []);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("enforces timeout with SIGTERM escalation", async () => {
    const r = await spawnCapture("sleep", ["30"], { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("passes input to stdin", async () => {
    const r = await spawnCapture("cat", [], { input: "piped-data" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("piped-data");
  });

  it("respects cwd option", async () => {
    const r = await spawnCapture("pwd", [], { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/\/tmp/);
  });

  it("truncates stdout when output exceeds maxBuffer", async () => {
    const r = await spawnCapture("echo", ["x".repeat(200)], { maxBuffer: 50 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(50);
  });
});

describe("spawnCaptureSync", () => {
  it("captures stdout from a successful command", () => {
    const r = spawnCaptureSync("echo", ["hello"]);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("reports failure with non-zero exit code", () => {
    const r = spawnCaptureSync("false", []);
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("handles missing binary without throwing", () => {
    const r = spawnCaptureSync("nonexistent-binary-xyzzy-42", []);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("enforces timeout via Bun.spawnSync", () => {
    const r = spawnCaptureSync("sleep", ["30"], { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("does not set timedOut when process fails without signal (timeoutMs=50 edge case)", () => {
    // old elapsed-heuristic: elapsed≈1ms >= 50-50=0ms → incorrectly true
    // new signalCode check: signalCode is undefined (not SIGTERM) → correctly false
    const r = spawnCaptureSync("false", [], { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("respects cwd option", () => {
    const r = spawnCaptureSync("pwd", [], { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/\/tmp/);
  });

  it("truncates stdout when output exceeds maxBuffer", () => {
    const r = spawnCaptureSync("echo", ["x".repeat(200)], { maxBuffer: 50 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(50);
  });
});
