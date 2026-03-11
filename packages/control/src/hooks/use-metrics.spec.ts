import { afterEach, describe, expect, it } from "bun:test";
import type { MetricsSnapshot } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseMetricsOptions, useMetrics } from "./use-metrics";

/* ---------- helpers ---------- */

function emptySnapshot(): MetricsSnapshot {
  return {
    collectedAt: Date.now(),
    counters: [],
    gauges: [],
    histograms: [],
  };
}

interface HookState {
  metrics: MetricsSnapshot | null;
  error: string | null;
  loading: boolean;
  restartedAt: number | null;
}

const Harness: FC<{ opts: UseMetricsOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
  const result = useMetrics(opts);
  stateRef.current = result;
  return React.createElement(Text, null, "ok");
};

async function flush(ms = 10) {
  await Bun.sleep(ms);
}

/* ---------- tests ---------- */

describe("useMetrics", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseMetricsOptions) {
    const stateRef: { current: HookState } = {
      current: { metrics: null, error: null, loading: true, restartedAt: null },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches metrics on mount", async () => {
    const snap = emptySnapshot();
    const ipcCallFn = async () => snap;

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.metrics).toEqual(snap);
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets error state when ipcCallFn throws", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.loading).toBe(false);
  });

  it("does not poll when disabled", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return emptySnapshot();
    };

    mount({
      enabled: false,
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    await flush(50);
    expect(callCount).toBe(0);
  });

  it("detects daemon restart when daemonId changes", async () => {
    let callNum = 0;
    const ipcCallFn = async () => {
      callNum++;
      return {
        ...emptySnapshot(),
        daemonId: callNum <= 2 ? "daemon-aaa" : "daemon-bbb",
      };
    };

    const { stateRef } = mount({
      intervalMs: 20,
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    // First poll — no restart yet
    await flush(10);
    expect(stateRef.current.restartedAt).toBeNull();

    // Wait for subsequent polls to pick up the new daemonId
    await flush(80);
    expect(typeof stateRef.current.restartedAt).toBe("number");
    expect(stateRef.current.restartedAt).toBeGreaterThan(0);
  });

  it("does not flag restart on first poll", async () => {
    const ipcCallFn = async () => ({
      ...emptySnapshot(),
      daemonId: "daemon-xyz",
    });

    const { stateRef } = mount({
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    await flush();
    expect(stateRef.current.restartedAt).toBeNull();
  });

  it("cleanup stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return emptySnapshot();
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UseMetricsOptions["ipcCallFn"],
    });

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
  });
});
