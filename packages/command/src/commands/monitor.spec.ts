import { describe, expect, test } from "bun:test";
import { cmdMonitor, parseMonitorArgs } from "./monitor";
import type { MonitorDeps } from "./monitor";

// ── parseMonitorArgs ──

describe("parseMonitorArgs", () => {
  test("returns empty object with no args", () => {
    const result = parseMonitorArgs([]);
    expect(result.error).toBeUndefined();
    expect(result.subscribe).toBeUndefined();
    expect(result.session).toBeUndefined();
  });

  test("parses --subscribe", () => {
    const result = parseMonitorArgs(["--subscribe", "session,work_item"]);
    expect(result.subscribe).toBe("session,work_item");
  });

  test("parses --session", () => {
    const result = parseMonitorArgs(["--session", "abc123"]);
    expect(result.session).toBe("abc123");
  });

  test("parses --pr as number", () => {
    const result = parseMonitorArgs(["--pr", "42"]);
    expect(result.pr).toBe(42);
  });

  test("parses --work-item", () => {
    const result = parseMonitorArgs(["--work-item", "#1441"]);
    expect(result.workItem).toBe("#1441");
  });

  test("parses --type", () => {
    const result = parseMonitorArgs(["--type", "pr.*"]);
    expect(result.type).toBe("pr.*");
  });

  test("parses --src", () => {
    const result = parseMonitorArgs(["--src", "daemon.*"]);
    expect(result.src).toBe("daemon.*");
  });

  test("parses --phase", () => {
    const result = parseMonitorArgs(["--phase", "review"]);
    expect(result.phase).toBe("review");
  });

  test("parses --since", () => {
    const result = parseMonitorArgs(["--since", "100"]);
    expect(result.since).toBe(100);
  });

  test("parses --until", () => {
    const result = parseMonitorArgs(["--until", "pr.merged"]);
    expect(result.until).toBe("pr.merged");
  });

  test("parses --timeout", () => {
    const result = parseMonitorArgs(["--timeout", "30"]);
    expect(result.timeout).toBe(30);
  });

  test("parses --max-events", () => {
    const result = parseMonitorArgs(["--max-events", "10"]);
    expect(result.maxEvents).toBe(10);
  });

  test("--json is a no-op flag", () => {
    const result = parseMonitorArgs(["--json"]);
    expect(result.error).toBeUndefined();
  });

  test("returns error for unknown flag", () => {
    const result = parseMonitorArgs(["--unknown"]);
    expect(result.error).toContain("Unknown flag");
  });

  test("returns error for --pr with non-number", () => {
    const result = parseMonitorArgs(["--pr", "notanumber"]);
    expect(result.error).toContain("number");
  });

  test("returns error for missing --session value", () => {
    const result = parseMonitorArgs(["--session"]);
    expect(result.error).toContain("--session");
  });

  test("returns error for --timeout <= 0", () => {
    expect(parseMonitorArgs(["--timeout", "0"]).error).toContain("> 0");
    expect(parseMonitorArgs(["--timeout", "-5"]).error).toContain("> 0");
  });

  test("returns error for --max-events <= 0", () => {
    expect(parseMonitorArgs(["--max-events", "0"]).error).toContain("> 0");
  });

  test("returns error for --since < 0", () => {
    expect(parseMonitorArgs(["--since", "-1"]).error).toContain(">= 0");
  });

  test("parses multiple flags", () => {
    const result = parseMonitorArgs(["--session", "s1", "--type", "pr.*", "--max-events", "5"]);
    expect(result.session).toBe("s1");
    expect(result.type).toBe("pr.*");
    expect(result.maxEvents).toBe(5);
  });
});

// ── cmdMonitor ──

interface TestCtx {
  deps: MonitorDeps;
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}

function makeDeps(events: Record<string, unknown>[]): TestCtx {
  const ctx: TestCtx = {
    stdout: [],
    stderr: [],
    exitCode: undefined,
    deps: {} as MonitorDeps,
  };

  async function* fakeStream() {
    for (const e of events) yield e;
  }

  ctx.deps = {
    openEventStream: () => ({ events: fakeStream(), abort: () => {} }),
    printError: (msg) => {
      ctx.stderr.push(msg);
    },
    writeStdout: (line) => {
      ctx.stdout.push(line);
    },
    writeStderr: (msg) => {
      ctx.stderr.push(msg);
    },
    exit: (code) => {
      ctx.exitCode = code;
      throw new Error(`exit:${code}`);
    },
    onSigint: () => {},
  };

  return ctx;
}

describe("cmdMonitor", () => {
  test("streams events as NDJSON to stdout", async () => {
    const events = [
      { event: "pr.merged", category: "work_item", prNumber: 1 },
      { event: "session.result", category: "session", sessionId: "s1" },
    ];
    const { deps, stdout } = makeDeps(events);

    await cmdMonitor([], deps);

    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({ event: "pr.merged" });
    expect(JSON.parse(stdout[1] as string)).toMatchObject({ event: "session.result" });
  });

  test("skips connected handshake but passes through heartbeat events", async () => {
    const events = [
      { t: "connected", seq: 0 },
      { event: "pr.merged", category: "work_item" },
      { t: "heartbeat", seq: 1 },
    ];
    const { deps, stdout } = makeDeps(events);

    await cmdMonitor([], deps);

    // connected is skipped; heartbeat passes through for liveness detection
    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({ event: "pr.merged" });
    expect(JSON.parse(stdout[1] as string)).toMatchObject({ t: "heartbeat" });
  });

  test("--max-events exits after N events", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ event: `ev.${i}`, seq: i }));
    const ctx = makeDeps(events);

    try {
      await cmdMonitor(["--max-events", "3"], ctx.deps);
    } catch {
      // exit() throws in tests
    }

    expect(ctx.exitCode).toBe(0);
    expect(ctx.stdout).toHaveLength(3);
  });

  test("--until exits when matching event type is seen", async () => {
    const events = [
      { event: "pr.opened", category: "work_item" },
      { event: "pr.merged", category: "work_item" },
      { event: "session.result", category: "session" },
    ];
    const ctx = makeDeps(events);

    try {
      await cmdMonitor(["--until", "pr.merged"], ctx.deps);
    } catch {
      // exit() throws in tests
    }

    expect(ctx.exitCode).toBe(0);
    // should have written pr.opened and pr.merged before exiting
    expect(ctx.stdout).toHaveLength(2);
    expect(JSON.parse(ctx.stdout[1] as string)).toMatchObject({ event: "pr.merged" });
  });

  test("exits with code 1 on parse error", async () => {
    const ctx = makeDeps([]);
    try {
      await cmdMonitor(["--pr", "notanumber"], ctx.deps);
    } catch {
      // exit throws
    }
    expect(ctx.exitCode).toBe(1);
  });
});
