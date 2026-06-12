import { describe, expect, it } from "bun:test";
import { spawnCapture, spawnCaptureSync, spawnManaged } from "./subprocess";

const POLL_INTERVAL_MS = 10;

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

  it("passes input to stdin", () => {
    const r = spawnCaptureSync("cat", [], { input: "piped-sync-data" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("piped-sync-data");
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

describe("spawnManaged", () => {
  it("spawns a process and reports exit status", async () => {
    const r = spawnManaged("echo", ["managed"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.handle.pid).toBeGreaterThan(0);
    const status = await r.handle.exited;
    expect(status.exitCode).toBe(0);
    expect(status.signal).toBeNull();
  });

  it("returns ok:false for missing binary without throwing", () => {
    const r = spawnManaged("nonexistent-binary-xyzzy-42", []);
    expect(r.ok).toBe(false);
  });

  it("captures stdout as a readable stream", async () => {
    const r = spawnManaged("echo", ["stream-test"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.handle.stdout).not.toBeNull();
    const text = await new Response(r.handle.stdout as ReadableStream).text();
    expect(text.trim()).toBe("stream-test");
    await r.handle.exited;
  });

  it("auto-drains stderr into ring buffer", async () => {
    const r = spawnManaged("sh", ["-c", "echo err-output >&2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await r.handle.exited;
    const deadline = Date.now() + 2000;
    while (!r.handle.stderrTail().includes("err-output") && Date.now() < deadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(r.handle.stderrTail()).toContain("err-output");
  });

  it("calls onStderr callback with chunks", async () => {
    const chunks: string[] = [];
    const r = spawnManaged("sh", ["-c", "echo callback-test >&2"], {
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await r.handle.exited;
    const deadline = Date.now() + 2000;
    while (!chunks.join("").includes("callback-test") && Date.now() < deadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(chunks.join("")).toContain("callback-test");
  });

  it("calls onStderrEnd once after the stderr stream drains, following the final chunk", async () => {
    const order: string[] = [];
    const r = spawnManaged("sh", ["-c", "printf 'no-newline-tail' >&2"], {
      onStderr: () => order.push("chunk"),
      onStderrEnd: () => order.push("end"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await r.handle.exited;
    const deadline = Date.now() + 2000;
    while (!order.includes("end") && Date.now() < deadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    // The trailing chunk (which had no newline) is delivered before EOF is signalled.
    expect(order).toContain("chunk");
    expect(order[order.length - 1]).toBe("end");
    expect(order.filter((o) => o === "end")).toHaveLength(1);
  });

  it("truncates stderr ring buffer to stderrMaxBytes", async () => {
    const r = spawnManaged("sh", ["-c", "dd if=/dev/zero bs=1024 count=128 2>/dev/null | tr '\\0' 'A' >&2"], {
      stderrMaxBytes: 1024,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await r.handle.exited;
    const deadline = Date.now() + 2000;
    while (r.handle.stderrTail().length === 0 && Date.now() < deadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(r.handle.stderrTail().length).toBeLessThanOrEqual(1024);
  });

  it("kill() sends SIGTERM then SIGKILL after grace period", async () => {
    const r = spawnManaged("sleep", ["30"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const status = await r.handle.kill(100);
    expect(status.exitCode).not.toBe(0);
    expect(status.signal).toBeTruthy();
  });

  it("killNow() bypasses grace and SIGKILLs immediately", async () => {
    const r = spawnManaged("sleep", ["30"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const start = Date.now();
    r.handle.killNow();
    const status = await r.handle.exited;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1_000);
    expect(status.signal).toBe("SIGKILL");
  });

  it("kill() does not leak the SIGKILL timer into the event loop after exit", async () => {
    // Spawn a bun child that itself calls spawnManaged + kill + await exited,
    // then exits promptly. If the SIGKILL timer is not cleared, the child's
    // event loop is held alive for graceMs (5s default) — observable as wall
    // time of the parent's await.
    const child = process.execPath;
    const script = `
      import { spawnManaged } from "${import.meta.dir.replace(/\\\\/g, "/")}/subprocess";
      const r = spawnManaged("sleep", ["30"]);
      if (!r.ok) process.exit(2);
      // SIGKILL grace 10s — if the timer leaks, this process hangs ~10s after exit.
      await r.handle.kill(10_000);
    `;
    const start = Date.now();
    const result = await spawnCapture(child, ["-e", script], { timeoutMs: 8_000 });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("reports non-zero exit code honestly", async () => {
    const r = spawnManaged("false", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const status = await r.handle.exited;
    expect(status.exitCode).not.toBe(0);
  });

  it("exposes stdin as a writable sink", async () => {
    const r = spawnManaged("cat", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.handle.stdin).not.toBeNull();
    const stdin = r.handle.stdin as import("bun").FileSink;
    stdin.write("hello-stdin\n");
    await stdin.end();

    const text = await new Response(r.handle.stdout as ReadableStream).text();
    expect(text.trim()).toBe("hello-stdin");
    await r.handle.exited;
  });

  it("respects cwd option", async () => {
    const r = spawnManaged("pwd", [], { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const text = await new Response(r.handle.stdout as ReadableStream).text();
    expect(text.trim()).toMatch(/\/tmp/);
    await r.handle.exited;
  });

  it("returns null stdin/stdout when configured as ignore", () => {
    const r = spawnManaged("true", [], { stdin: "ignore", stdout: "ignore" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.handle.stdin).toBeNull();
    expect(r.handle.stdout).toBeNull();
  });

  it("stderrTail returns empty string when stderr is inherit", async () => {
    const r = spawnManaged("true", [], { stderr: "inherit" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await r.handle.exited;
    expect(r.handle.stderrTail()).toBe("");
  });
});
