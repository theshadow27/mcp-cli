import { afterEach, describe, expect, it } from "bun:test";
import type { LogEntry, ServerStatus } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type LogSource, type UseLogsOptions, buildLogSources, filterLogLines, useLogs } from "./use-logs";

/* ---------- helpers ---------- */

function logEntry(line: string, ts?: number): LogEntry {
  return { line, timestamp: ts ?? Date.now() };
}

function serverStatus(name: string): ServerStatus {
  return {
    name,
    state: "connected",
    transport: "stdio",
    lastError: undefined,
    toolCount: 0,
    source: "test",
  } as ServerStatus;
}

interface HookState {
  lines: LogEntry[];
  source: LogSource;
  setSource: (s: LogSource) => void;
}

const Harness: FC<{
  servers: ServerStatus[];
  opts: UseLogsOptions;
  stateRef: { current: HookState };
}> = ({ servers, opts, stateRef }) => {
  const result = useLogs(servers, opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- pure function tests ---------- */

describe("buildLogSources", () => {
  it("returns daemon + one per server", () => {
    const sources = buildLogSources([serverStatus("a"), serverStatus("b")]);
    expect(sources).toEqual([{ type: "daemon" }, { type: "server", name: "a" }, { type: "server", name: "b" }]);
  });

  it("returns just daemon when no servers", () => {
    expect(buildLogSources([])).toEqual([{ type: "daemon" }]);
  });
});

describe("filterLogLines", () => {
  it("returns all lines when filter is empty", () => {
    const lines = [logEntry("hello"), logEntry("world")];
    expect(filterLogLines(lines, "")).toEqual(lines);
  });

  it("filters case-insensitively", () => {
    const lines = [logEntry("Error: boom"), logEntry("info: ok"), logEntry("ERROR: crash")];
    const result = filterLogLines(lines, "error");
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe("Error: boom");
    expect(result[1].line).toBe("ERROR: crash");
  });
});

/* ---------- hook tests ---------- */

describe("useLogs", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseLogsOptions, servers: ServerStatus[] = []) {
    const stateRef: { current: HookState } = {
      current: { lines: [], source: { type: "daemon" }, setSource: () => {} },
    };
    const instance = render(React.createElement(Harness, { servers, opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches daemon logs on mount", async () => {
    const entries = [logEntry("line1", 1), logEntry("line2", 2)];
    const ipcCallFn = async (_method: string, _params: unknown) => ({
      lines: entries,
    });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.lines).toHaveLength(2);
    expect(stateRef.current.lines[0].line).toBe("line1");
  });

  it("skips polling when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { lines: [] };
    };

    mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(callCount).toBe(0);
  });

  it("defaults enabled to true", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { lines: [] };
    };

    mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("passes limit on first call", async () => {
    let capturedParams: unknown = null;
    const ipcCallFn = async (_method: string, params: unknown) => {
      capturedParams = params;
      return { lines: [] };
    };

    mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(capturedParams).toEqual({ limit: 50 });
  });

  it("passes since on subsequent calls", async () => {
    const calls: unknown[] = [];
    const ipcCallFn = async (_method: string, params: unknown) => {
      calls.push(params);
      return { lines: [logEntry("x", 42)] };
    };

    mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    // Wait for initial + at least one interval poll
    await flush(1200);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Second call should have since=42 (from the first result's timestamp)
    expect(calls[1]).toEqual({ since: 42 });
  });

  it("caps lines at MAX_LINES (500)", async () => {
    const bigBatch = Array.from({ length: 600 }, (_, i) => logEntry(`line-${i}`, i));
    const ipcCallFn = async () => ({ lines: bigBatch });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.lines).toHaveLength(500);
    // Should keep the last 500 lines
    expect(stateRef.current.lines[0].line).toBe("line-100");
  });

  it("does not stack overlapping polls (setTimeout chain)", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;
    const ipcCallFn = async () => {
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await new Promise((r) => setTimeout(r, 30));
      concurrency--;
      return { lines: [logEntry("log", Date.now())] };
    };

    mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush(150);
    expect(maxConcurrency).toBe(1);
  });

  it("cleanup clears interval on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { lines: [] };
    };

    const { instance } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(1200);
    expect(callCount).toBe(countAtUnmount);
  });

  it("calls getLogs for server source", async () => {
    let capturedMethod = "" as string;
    let capturedParams: unknown = null;
    const ipcCallFn = async (method: string, params: unknown) => {
      capturedMethod = method;
      capturedParams = params;
      return { lines: [] };
    };

    const servers = [serverStatus("my-server")];
    const stateRef: { current: HookState } = {
      current: { lines: [], source: { type: "daemon" }, setSource: () => {} },
    };

    const ServerHarness: FC = () => {
      const result = useLogs(servers, {
        ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
      });
      stateRef.current = result;
      React.useEffect(() => {
        result.setSource({ type: "server", name: "my-server" });
      }, [result.setSource]);
      return React.createElement(Text, null, "ok");
    };

    const instance = render(React.createElement(ServerHarness));
    instances.push(instance);

    await flush(100);
    expect(capturedMethod).toBe("getLogs");
    expect(capturedParams).toEqual({ server: "my-server", limit: 50 });
  });

  it("silently catches errors from ipcCallFn", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    // Should not crash; lines remain empty
    expect(stateRef.current.lines).toEqual([]);
  });
});
