import { describe, expect, test } from "bun:test";
import type { SpanRow } from "@mcp-cli/core";
import { cmdSpans } from "./spans";

function mockSpanRow(overrides?: Partial<SpanRow>): SpanRow {
  return {
    id: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    traceFlags: "01",
    name: "ipc.callTool",
    startTimeMs: 1700000000000,
    endTimeMs: 1700000000050,
    durationMs: 50,
    status: "OK",
    attributes: {},
    events: [],
    daemonId: "d".repeat(16),
    exportedAt: null,
    ...overrides,
  };
}

describe("cmdSpans", () => {
  test("calls getSpans with default limit", async () => {
    let calledParams: unknown;
    await cmdSpans([], {
      ipcCall: async (_method, params) => {
        calledParams = params;
        return { spans: [] } as never;
      },
      printError: () => {},
      exit: (() => {}) as never,
    });
    expect(calledParams).toEqual({ limit: 100, since: undefined, unexported: false });
  });

  test("passes --limit and --since flags", async () => {
    let calledParams: unknown;
    await cmdSpans(["--limit", "10", "--since", "1700000000000"], {
      ipcCall: async (_method, params) => {
        calledParams = params;
        return { spans: [] } as never;
      },
      printError: () => {},
      exit: (() => {}) as never,
    });
    expect(calledParams).toEqual({ limit: 10, since: 1700000000000, unexported: false });
  });

  test("--json outputs JSON to stdout", async () => {
    const span = mockSpanRow();
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await cmdSpans(["--json"], {
        ipcCall: async () => ({ spans: [span] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(output.join(""));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("ipc.callTool");
  });

  test("human-readable output shows span details", async () => {
    const span = mockSpanRow({ name: "tool.echo.ping", durationMs: 123, status: "OK" });
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await cmdSpans([], {
        ipcCall: async () => ({ spans: [span] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.log = origLog;
    }
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("tool.echo.ping");
    expect(output[0]).toContain("123ms");
    expect(output[0]).toContain("OK ");
  });

  test("human-readable shows ERR for error spans", async () => {
    const span = mockSpanRow({ status: "ERROR" });
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await cmdSpans([], {
        ipcCall: async () => ({ spans: [span] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.log = origLog;
    }
    expect(output[0]).toContain("ERR");
  });

  test("shows E marker for exported spans", async () => {
    const span = mockSpanRow({ exportedAt: 1700000001000 });
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await cmdSpans([], {
        ipcCall: async () => ({ spans: [span] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.log = origLog;
    }
    expect(output[0]).toContain(" E ");
  });

  test("empty result prints no spans message", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      await cmdSpans([], {
        ipcCall: async () => ({ spans: [] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.error = origError;
    }
    expect(errors).toContain("No spans found.");
  });

  test("-j shorthand for --json", async () => {
    const span = mockSpanRow();
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await cmdSpans(["-j"], {
        ipcCall: async () => ({ spans: [span] }) as never,
        printError: () => {},
        exit: (() => {}) as never,
      });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(output.join(""));
    expect(parsed).toHaveLength(1);
  });

  test("--unexported flag is passed to IPC", async () => {
    let calledParams: unknown;
    await cmdSpans(["--unexported"], {
      ipcCall: async (_method, params) => {
        calledParams = params;
        return { spans: [] } as never;
      },
      printError: () => {},
      exit: (() => {}) as never,
    });
    expect(calledParams).toEqual({ limit: 100, since: undefined, unexported: true });
  });

  test("prune subcommand calls pruneSpans", async () => {
    let calledMethod: string | undefined;
    await cmdSpans(["prune"], {
      ipcCall: async (method) => {
        calledMethod = method;
        return { pruned: 5 } as never;
      },
      printError: () => {},
      exit: (() => {}) as never,
    });
    expect(calledMethod).toBe("pruneSpans");
  });
});
