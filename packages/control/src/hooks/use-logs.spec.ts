import { afterEach, describe, expect, it } from "bun:test";
import type { LogEntry, ServerStatus } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseLogsOptions, useLogs } from "./use-logs";

/* ---------- helpers ---------- */

function logEntry(line: string, ts?: number): LogEntry {
  return { line, timestamp: ts ?? Date.now() };
}

interface HookState {
  lines: LogEntry[];
}

const Harness: FC<{ servers: ServerStatus[]; opts: UseLogsOptions; stateRef: { current: HookState } }> = ({
  servers,
  opts,
  stateRef,
}) => {
  const result = useLogs(servers, opts);
  stateRef.current = { lines: result.lines };
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- tests ---------- */

describe("useLogs", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseLogsOptions) {
    const stateRef: { current: HookState } = {
      current: { lines: [] },
    };
    const instance = render(React.createElement(Harness, { servers: [], opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches daemon logs on mount", async () => {
    const entries = [logEntry("hello", 1), logEntry("world", 2)];
    const ipcCallFn = async () => ({ lines: entries });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.lines).toHaveLength(2);
    expect(stateRef.current.lines[0].line).toBe("hello");
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

    // POLL_INTERVAL_MS is 1000 so we won't get multiple polls in 150ms,
    // but the key assertion is that concurrency never exceeds 1.
    await flush(150);
    expect(maxConcurrency).toBe(1);
  });

  it("does not poll when enabled is false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { lines: [] };
    };

    mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush(50);
    expect(callCount).toBe(0);
  });

  it("cleanup stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return { lines: [] };
    };

    const { instance } = mount({
      ipcCallFn: ipcCallFn as UseLogsOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
