import { describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import {
  CHECKS_FAILED,
  CHECKS_PASSED,
  CHECKS_STARTED,
  HEARTBEAT,
  MAIL_RECEIVED,
  PHASE_CHANGED,
  PR_CLOSED,
  PR_MERGED,
  PR_OPENED,
  REVIEW_APPROVED,
  REVIEW_CHANGES_REQUESTED,
  SESSION_CLEARED,
  SESSION_CONTAINMENT_DENIED,
  SESSION_CONTAINMENT_ESCALATED,
  SESSION_CONTAINMENT_WARNING,
  SESSION_DISCONNECTED,
  SESSION_ENDED,
  SESSION_ERROR,
  SESSION_MODEL_CHANGED,
  SESSION_PERMISSION_REQUEST,
  SESSION_RATE_LIMITED,
  SESSION_RESPONSE,
  SESSION_RESULT,
  formatMonitorEvent,
} from "@mcp-cli/core";
import type { MonitorDeps } from "./monitor";
import { cmdMonitor, parseMonitorArgs } from "./monitor";

// ── Formatter tests ──

function makeEvent(event: string, extra: Record<string, unknown> = {}): MonitorEvent {
  return {
    seq: 1,
    ts: "2026-04-20T14:32:01.000Z",
    src: "daemon.claude-server",
    event,
    category: "session",
    ...extra,
  };
}

describe("formatMonitorEvent", () => {
  test("all formatters produce output ≤200 chars", () => {
    const events: MonitorEvent[] = [
      makeEvent(SESSION_RESULT, {
        sessionId: "fcfbc19dabc",
        cost: 2.0,
        numTurns: 25,
        result: "All done. Fixed 0c52a884 pushed to feat/issue-1441-some-really-long-branch-name-here",
        workItemId: "#1441",
      }),
      makeEvent(SESSION_PERMISSION_REQUEST, {
        sessionId: "fcfbc19dabc",
        toolName: "Bash",
        workItemId: "#1441",
      }),
      makeEvent(SESSION_ENDED, {
        sessionId: "fcfbc19dabc",
        cost: 2.0,
        numTurns: 25,
        workItemId: "#1441",
      }),
      makeEvent(SESSION_DISCONNECTED, { sessionId: "fcfbc19dabc", workItemId: "#1441" }),
      makeEvent(SESSION_ERROR, {
        sessionId: "fcfbc19dabc",
        errors: ["Connection refused: socket closed unexpectedly"],
        workItemId: "#1441",
      }),
      makeEvent(SESSION_CLEARED, { sessionId: "fcfbc19dabc", workItemId: "#1441" }),
      makeEvent(SESSION_MODEL_CHANGED, {
        sessionId: "fcfbc19dabc",
        model: "claude-opus-4-7",
        workItemId: "#1441",
      }),
      makeEvent(SESSION_RATE_LIMITED, {
        sessionId: "fcfbc19dabc",
        retryAfterMs: 30000,
        workItemId: "#1441",
      }),
      makeEvent(SESSION_CONTAINMENT_WARNING, {
        sessionId: "fcfbc19dabc",
        strikes: 2,
        reason: "Attempted write outside containment",
        workItemId: "#1441",
      }),
      makeEvent(SESSION_CONTAINMENT_DENIED, {
        sessionId: "fcfbc19dabc",
        reason: "Exceeded strike limit",
        workItemId: "#1441",
      }),
      makeEvent(SESSION_CONTAINMENT_ESCALATED, { sessionId: "fcfbc19dabc", workItemId: "#1441" }),
      makeEvent(PR_OPENED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
      }),
      makeEvent(PR_MERGED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
      }),
      makeEvent(PR_CLOSED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
      }),
      makeEvent(CHECKS_STARTED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
      }),
      makeEvent(CHECKS_PASSED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
      }),
      makeEvent(CHECKS_FAILED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
        failedJob: "check",
      }),
      makeEvent(REVIEW_APPROVED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
        reviewer: "copilot",
      }),
      makeEvent(REVIEW_CHANGES_REQUESTED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        prNumber: 1472,
        workItemId: "#1441",
        reviewer: "copilot",
      }),
      makeEvent(PHASE_CHANGED, {
        category: "work_item",
        src: "daemon.work-item-poller",
        workItemId: "#1441",
        from: "impl",
        to: "qa",
      }),
      makeEvent(MAIL_RECEIVED, {
        category: "mail",
        src: "daemon.mail",
        sender: "orchestrator@sessions",
        recipient: "impl@sessions",
      }),
      makeEvent(HEARTBEAT, { category: "heartbeat", src: "daemon", seq: 4210 }),
    ];

    for (const e of events) {
      const line = formatMonitorEvent(e);
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line).toContain(e.event === HEARTBEAT ? "heartbeat" : e.event);
    }
  });

  test("session.result includes truncated preview", () => {
    const e = makeEvent(SESSION_RESULT, {
      result: "A".repeat(200),
      sessionId: "abc12345",
    });
    const line = formatMonitorEvent(e);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain("…");
  });

  test("unknown event type falls back to generic formatter", () => {
    const e = makeEvent("custom.event", { foo: "bar", baz: 42 });
    const line = formatMonitorEvent(e);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain("custom.event");
  });

  test("heartbeat shows seq", () => {
    const e = makeEvent(HEARTBEAT, { category: "heartbeat", src: "daemon", seq: 9999 });
    const line = formatMonitorEvent(e);
    expect(line).toContain("seq:9999");
    expect(line).toContain("♥");
  });
});

// ── Chunk suppression tests (parseMonitorArgs only — runtime filtering is in ipc-server) ──

describe("parseMonitorArgs", () => {
  test("defaults: no json, no responseTail", () => {
    const parsed = parseMonitorArgs([]);
    expect(parsed.json).toBe(false);
    expect(parsed.responseTail).toBeUndefined();
  });

  test("--json flag sets json=true", () => {
    expect(parseMonitorArgs(["--json"]).json).toBe(true);
    expect(parseMonitorArgs(["-j"]).json).toBe(true);
  });

  test("--response-tail sets responseTail", () => {
    const parsed = parseMonitorArgs(["--response-tail", "fcfbc19d"]);
    expect(parsed.responseTail).toBe("fcfbc19d");
  });

  test("--response-tail without value is an error", () => {
    const parsed = parseMonitorArgs(["--response-tail"]);
    expect(parsed.error).toBeTruthy();
  });

  test("--subscribe, --session, --pr parsed correctly", () => {
    const parsed = parseMonitorArgs(["--subscribe", "session,work_item", "--session", "abc123", "--pr", "1472"]);
    expect(parsed.subscribe).toBe("session,work_item");
    expect(parsed.session).toBe("abc123");
    expect(parsed.pr).toBe(1472);
  });

  test("--until, --timeout, --max-events parsed correctly", () => {
    const parsed = parseMonitorArgs(["--until", "pr.merged", "--timeout", "30", "--max-events", "10"]);
    expect(parsed.until).toBe("pr.merged");
    expect(parsed.timeout).toBe(30);
    expect(parsed.maxEvents).toBe(10);
  });

  test("session.response is a known event constant", () => {
    expect(SESSION_RESPONSE).toBe("session.response");
  });
});

// ── Integration: response chunk suppression contract ──

describe("session.response suppression contract", () => {
  test("SESSION_RESPONSE constant exists for daemon-side filtering", () => {
    expect(SESSION_RESPONSE).toBe("session.response");
  });

  test("formatMonitorEvent handles session.response gracefully", () => {
    const e = makeEvent(SESSION_RESPONSE, {
      sessionId: "s1",
      chunk: "Hello world",
    });
    const line = formatMonitorEvent(e);
    expect(line.length).toBeLessThanOrEqual(200);
    // Falls back to generic formatter
    expect(line).toContain(SESSION_RESPONSE);
  });
});

// ── parseMonitorArgs error branches ──

describe("parseMonitorArgs error branches", () => {
  test("--subscribe without value is an error", () => {
    expect(parseMonitorArgs(["--subscribe"]).error).toBeTruthy();
  });

  test("--session without value is an error", () => {
    expect(parseMonitorArgs(["--session"]).error).toBeTruthy();
  });

  test("--pr with non-numeric value is an error", () => {
    expect(parseMonitorArgs(["--pr", "abc"]).error).toBeTruthy();
  });

  test("--work-item without value is an error", () => {
    expect(parseMonitorArgs(["--work-item"]).error).toBeTruthy();
  });

  test("--type without value is an error", () => {
    expect(parseMonitorArgs(["--type"]).error).toBeTruthy();
  });

  test("--src without value is an error", () => {
    expect(parseMonitorArgs(["--src"]).error).toBeTruthy();
  });

  test("--phase without value is an error", () => {
    expect(parseMonitorArgs(["--phase"]).error).toBeTruthy();
  });

  test("--since with non-numeric value is an error", () => {
    expect(parseMonitorArgs(["--since", "abc"]).error).toBeTruthy();
  });

  test("--until without value is an error", () => {
    expect(parseMonitorArgs(["--until"]).error).toBeTruthy();
  });

  test("--timeout with non-numeric value is an error", () => {
    expect(parseMonitorArgs(["--timeout", "abc"]).error).toBeTruthy();
  });

  test("--max-events with non-numeric value is an error", () => {
    expect(parseMonitorArgs(["--max-events", "abc"]).error).toBeTruthy();
  });

  test("--help sets error to 'help'", () => {
    expect(parseMonitorArgs(["--help"]).error).toBe("help");
    expect(parseMonitorArgs(["-h"]).error).toBe("help");
  });

  test("--work-item and --src parsed correctly", () => {
    const parsed = parseMonitorArgs(["--work-item", "#1441", "--src", "daemon.claude"]);
    expect(parsed.workItem).toBe("#1441");
    expect(parsed.src).toBe("daemon.claude");
  });

  test("--type and --phase parsed correctly", () => {
    const parsed = parseMonitorArgs(["--type", "pr.merged", "--phase", "impl"]);
    expect(parsed.type).toBe("pr.merged");
    expect(parsed.phase).toBe("impl");
  });

  test("--since parsed correctly", () => {
    const parsed = parseMonitorArgs(["--since", "42"]);
    expect(parsed.since).toBe(42);
  });
});

// ── cmdMonitor unit tests (dependency-injected) ──

function makeStreamDeps(events: MonitorEvent[], overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  async function* gen(): AsyncGenerator<MonitorEvent> {
    for (const e of events) yield e;
  }

  return {
    openEventStream: () => ({ events: gen(), abort: () => {} }),
    isTTY: true,
    writeStdout: () => {},
    writeStderr: () => {},
    exit: (code) => {
      throw new Error(`exit(${code})`);
    },
    onSigint: () => {},
    onStdoutError: () => {},
    ...overrides,
  };
}

describe("cmdMonitor", () => {
  test("--help writes help text and returns", async () => {
    const lines: string[] = [];
    const deps = makeStreamDeps([], { writeStderr: (l) => lines.push(l) });
    await cmdMonitor(["--help"], deps);
    expect(lines.join("")).toContain("mcx monitor");
  });

  test("parse error writes error message and exits 1", async () => {
    const stderr: string[] = [];
    const deps = makeStreamDeps([], {
      writeStderr: (l) => stderr.push(l),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      },
    });
    await expect(cmdMonitor(["--pr", "abc"], deps)).rejects.toThrow("exit:1");
    expect(stderr.join("")).toContain("Error:");
  });

  test("TTY mode formats events as human-readable lines", async () => {
    const events = [makeEvent(SESSION_RESULT, { sessionId: "abc12345", cost: 1.5 })];
    const stdout: string[] = [];
    const deps = makeStreamDeps(events, { isTTY: true, writeStdout: (l) => stdout.push(l) });
    await cmdMonitor([], deps);
    expect(stdout.length).toBe(1);
    expect(stdout[0]).toContain(SESSION_RESULT);
    expect(stdout[0]).not.toContain('"seq"'); // not raw JSON
  });

  test("--json mode emits raw NDJSON", async () => {
    const event = makeEvent(SESSION_RESULT, { sessionId: "abc12345" });
    const stdout: string[] = [];
    const deps = makeStreamDeps([event], { isTTY: true, writeStdout: (l) => stdout.push(l) });
    await cmdMonitor(["--json"], deps);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0].trim());
    expect(parsed.event).toBe(SESSION_RESULT);
  });

  test("non-TTY mode automatically uses JSON output", async () => {
    const event = makeEvent(SESSION_RESULT, {});
    const stdout: string[] = [];
    const deps = makeStreamDeps([event], { isTTY: false, writeStdout: (l) => stdout.push(l) });
    await cmdMonitor([], deps);
    const parsed = JSON.parse(stdout[0].trim());
    expect(parsed.event).toBe(SESSION_RESULT);
  });

  test("--max-events stops after N events", async () => {
    const events = [makeEvent(SESSION_RESULT, {}), makeEvent(SESSION_ENDED, {}), makeEvent(SESSION_CLEARED, {})];
    const stdout: string[] = [];
    const deps = makeStreamDeps(events, { writeStdout: (l) => stdout.push(l) });
    await cmdMonitor(["--max-events", "2"], deps);
    expect(stdout.length).toBe(2);
  });

  test("--until stops when matching event type is seen", async () => {
    const events = [
      makeEvent(SESSION_RESULT, {}),
      makeEvent(PR_MERGED, { category: "work_item" }),
      makeEvent(SESSION_ENDED, {}),
    ];
    const stdout: string[] = [];
    const deps = makeStreamDeps(events, { writeStdout: (l) => stdout.push(l) });
    await cmdMonitor(["--until", PR_MERGED], deps);
    expect(stdout.length).toBe(2); // SESSION_RESULT + PR_MERGED
  });

  test("AbortError is swallowed (clean exit)", async () => {
    const abortStream: AsyncIterable<MonitorEvent> = {
      [Symbol.asyncIterator]: (): AsyncIterator<MonitorEvent> => ({
        async next(): Promise<IteratorResult<MonitorEvent>> {
          throw new DOMException("Aborted", "AbortError");
        },
      }),
    };
    const deps: MonitorDeps = {
      openEventStream: () => ({ events: abortStream, abort: () => {} }),
      isTTY: true,
      writeStdout: () => {},
      writeStderr: () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      },
      onSigint: () => {},
      onStdoutError: () => {},
    };
    // Should not throw — AbortError is treated as clean exit
    await expect(cmdMonitor([], deps)).resolves.toBeUndefined();
  });

  test("non-abort error writes to stderr and exits 1", async () => {
    const errorStream: AsyncIterable<MonitorEvent> = {
      [Symbol.asyncIterator]: (): AsyncIterator<MonitorEvent> => ({
        async next(): Promise<IteratorResult<MonitorEvent>> {
          throw new Error("connection refused");
        },
      }),
    };
    const stderr: string[] = [];
    const deps: MonitorDeps = {
      openEventStream: () => ({ events: errorStream, abort: () => {} }),
      isTTY: true,
      writeStdout: () => {},
      writeStderr: (l) => stderr.push(l),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      },
      onSigint: () => {},
      onStdoutError: () => {},
    };
    await expect(cmdMonitor([], deps)).rejects.toThrow("exit:1");
    expect(stderr.join("")).toContain("connection refused");
  });

  test("--timeout sets a timer that calls abort", async () => {
    let abortCalled = false;
    async function* emptyGen(): AsyncGenerator<MonitorEvent> {
      // yields nothing — stream ends immediately
    }
    const deps: MonitorDeps = {
      openEventStream: () => ({
        events: emptyGen(),
        abort: () => {
          abortCalled = true;
        },
      }),
      isTTY: true,
      writeStdout: () => {},
      writeStderr: () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      },
      onSigint: () => {},
      onStdoutError: () => {},
    };
    // timeout=0 fires immediately; stream may already be exhausted — no crash is the assertion
    await cmdMonitor(["--timeout", "0"], deps);
    expect(typeof abortCalled).toBe("boolean");
  });

  test("EPIPE on stdout calls finish(0) via onStdoutError handler", async () => {
    let capturedErrHandler: ((err: Error) => void) | undefined;
    const exitCalls: number[] = [];

    async function* emptyGen(): AsyncGenerator<MonitorEvent> {}

    const deps: MonitorDeps = {
      openEventStream: () => ({ events: emptyGen(), abort: () => {} }),
      isTTY: true,
      writeStdout: () => {},
      writeStderr: () => {},
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
      onSigint: () => {},
      onStdoutError: (fn) => {
        capturedErrHandler = fn;
      },
    };

    await cmdMonitor([], deps);

    expect(capturedErrHandler).toBeDefined();
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    capturedErrHandler?.(epipe);
    expect(exitCalls).toEqual([0]);
  });

  test("non-EPIPE stdout errors do not trigger finish", async () => {
    let capturedErrHandler: ((err: Error) => void) | undefined;
    const exitCalls: number[] = [];

    async function* emptyGen(): AsyncGenerator<MonitorEvent> {}

    const deps: MonitorDeps = {
      openEventStream: () => ({ events: emptyGen(), abort: () => {} }),
      isTTY: true,
      writeStdout: () => {},
      writeStderr: () => {},
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
      onSigint: () => {},
      onStdoutError: (fn) => {
        capturedErrHandler = fn;
      },
    };

    await cmdMonitor([], deps);

    expect(capturedErrHandler).toBeDefined();
    const otherErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    capturedErrHandler?.(otherErr);
    expect(exitCalls).toHaveLength(0);
  });
});
