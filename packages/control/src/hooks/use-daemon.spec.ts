import { afterEach, describe, expect, it } from "bun:test";
import type { DaemonStatus } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseDaemonOptions, useDaemon } from "./use-daemon";

/* ---------- helpers ---------- */

function daemonStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    pid: 1234,
    uptime: 100,
    servers: [],
    ...overrides,
  } as DaemonStatus;
}

interface HookState {
  status: DaemonStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

const Harness: FC<{ opts: UseDaemonOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useDaemon(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- tests ---------- */

describe("useDaemon", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseDaemonOptions) {
    const stateRef: { current: HookState } = {
      current: { status: null, error: null, loading: true, refresh: () => {} },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("calls ipcCallFn on mount and sets status", async () => {
    const status = daemonStatus();
    const ipcCallFn = async () => status;

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.status).toEqual(status);
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets error state when ipcCallFn throws", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.loading).toBe(false);
  });

  it("does not stack overlapping polls (setTimeout chain)", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;
    const ipcCallFn = async () => {
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await new Promise((r) => setTimeout(r, 30));
      concurrency--;
      return daemonStatus();
    };

    mount({
      intervalMs: 10,
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
    });

    // With setInterval + 10ms interval and 30ms poll, we'd get overlapping polls.
    // With setTimeout chain, concurrency should never exceed 1.
    await flush(150);
    expect(maxConcurrency).toBe(1);
  });

  it("attempts auto-start when ipcCallFn fails, then retries successfully", async () => {
    let callCount = 0;
    const statusResult = daemonStatus();

    // First call fails (daemon down), second call succeeds (after restart)
    const ipcCallFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error("daemon offline");
      return statusResult;
    };

    let ensureCalled = false;
    const ensureDaemonFn = async () => {
      ensureCalled = true;
      return true; // daemon started successfully
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
      ensureDaemonFn,
    });

    await flush();
    expect(ensureCalled).toBe(true);
    expect(stateRef.current.status).toEqual(statusResult);
    expect(stateRef.current.error).toBeNull();
  });

  it("shows error when auto-start fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const ensureDaemonFn = async () => false; // failed to start

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
      ensureDaemonFn,
    });

    await flush();
    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.loading).toBe(false);
  });

  it("cleanup stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return daemonStatus();
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UseDaemonOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
