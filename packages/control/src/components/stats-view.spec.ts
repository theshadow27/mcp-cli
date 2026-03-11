import { describe, expect, it } from "bun:test";
import type { MetricsSnapshot } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import {
  StatsView,
  aggregateByServer,
  buildStatsLines,
  findCounter,
  findGauge,
  percentile,
  topTools,
} from "./stats-view";

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    collectedAt: Date.now(),
    counters: [],
    gauges: [],
    histograms: [],
    ...overrides,
  };
}

describe("findCounter", () => {
  it("sums matching counters", () => {
    const snap = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "t1" }, value: 5 },
        { name: "mcpd_tool_calls_total", labels: { server: "b", tool: "t2" }, value: 3 },
        { name: "mcpd_tool_errors_total", labels: { server: "a", tool: "t1" }, value: 1 },
      ],
    });
    expect(findCounter(snap, "mcpd_tool_calls_total")).toBe(8);
    expect(findCounter(snap, "mcpd_tool_calls_total", { server: "a" })).toBe(5);
    expect(findCounter(snap, "mcpd_tool_errors_total")).toBe(1);
    expect(findCounter(snap, "nonexistent")).toBe(0);
  });
});

describe("findGauge", () => {
  it("returns matching gauge value", () => {
    const snap = makeSnapshot({
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 42 },
        { name: "mcpd_servers_total", labels: {}, value: 3 },
      ],
    });
    expect(findGauge(snap, "mcpd_uptime_seconds")).toBe(42);
    expect(findGauge(snap, "nonexistent")).toBe(0);
  });
});

describe("percentile", () => {
  it("returns correct bucket boundary for given percentile", () => {
    const buckets = [
      { le: 10, count: 2 },
      { le: 50, count: 5 },
      { le: 100, count: 8 },
      { le: 500, count: 10 },
    ];
    expect(percentile(buckets, 10, 0.5)).toBe(50);
    expect(percentile(buckets, 10, 0.99)).toBe(500);
    expect(percentile(buckets, 10, 0.1)).toBe(10);
  });

  it("returns 0 for empty histogram", () => {
    expect(percentile([], 0, 0.5)).toBe(0);
  });
});

describe("aggregateByServer", () => {
  it("groups tool call stats by server", () => {
    const snap = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "alpha", tool: "t1" }, value: 10 },
        { name: "mcpd_tool_calls_total", labels: { server: "alpha", tool: "t2" }, value: 5 },
        { name: "mcpd_tool_calls_total", labels: { server: "beta", tool: "t3" }, value: 3 },
        { name: "mcpd_tool_errors_total", labels: { server: "alpha", tool: "t1" }, value: 2 },
      ],
      histograms: [
        {
          name: "mcpd_tool_call_duration_ms",
          labels: { server: "alpha", tool: "t1" },
          count: 10,
          sum: 500,
          buckets: [],
        },
        {
          name: "mcpd_tool_call_duration_ms",
          labels: { server: "alpha", tool: "t2" },
          count: 5,
          sum: 250,
          buckets: [],
        },
        { name: "mcpd_tool_call_duration_ms", labels: { server: "beta", tool: "t3" }, count: 3, sum: 150, buckets: [] },
      ],
    });

    const result = aggregateByServer(snap);
    expect(result).toHaveLength(2);
    expect(result[0].server).toBe("alpha");
    expect(result[0].calls).toBe(15);
    expect(result[0].errors).toBe(2);
    expect(result[0].avgMs).toBe(50); // 750 / 15
    expect(result[1].server).toBe("beta");
    expect(result[1].calls).toBe(3);
  });

  it("returns empty array for no tool calls", () => {
    expect(aggregateByServer(makeSnapshot())).toEqual([]);
  });
});

describe("topTools", () => {
  it("returns tools sorted by call count, limited", () => {
    const snap = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "z" }, value: 1 },
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "y" }, value: 10 },
        { name: "mcpd_tool_calls_total", labels: { server: "b", tool: "x" }, value: 5 },
      ],
    });

    const result = topTools(snap, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ server: "a", tool: "y", calls: 10 });
    expect(result[1]).toEqual({ server: "b", tool: "x", calls: 5 });
  });

  it("skips counters without server+tool labels", () => {
    const snap = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "a" }, value: 5 },
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "t" }, value: 3 },
      ],
    });
    expect(topTools(snap)).toHaveLength(1);
  });
});

describe("buildStatsLines", () => {
  it("returns lines array with dashboard, servers, and tools sections", () => {
    const snap = makeSnapshot({
      counters: [{ name: "mcpd_tool_calls_total", labels: { server: "a", tool: "search" }, value: 10 }],
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 60 },
        { name: "mcpd_servers_total", labels: {}, value: 1 },
        { name: "mcpd_servers_connected", labels: {}, value: 1 },
      ],
    });

    const lines = buildStatsLines(snap, null);
    // Dashboard header + 3 dashboard lines + spacer + servers header + 1 server + spacer + tools header + 1 tool
    expect(lines.length).toBeGreaterThanOrEqual(4); // at least dashboard
    expect(lines.length).toBeLessThan(50); // sanity check
  });

  it("grows with more servers", () => {
    const snap1 = makeSnapshot({
      counters: [{ name: "mcpd_tool_calls_total", labels: { server: "a", tool: "t" }, value: 1 }],
      gauges: [{ name: "mcpd_uptime_seconds", labels: {}, value: 60 }],
    });
    const snap2 = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "t" }, value: 1 },
        { name: "mcpd_tool_calls_total", labels: { server: "b", tool: "t" }, value: 1 },
        { name: "mcpd_tool_calls_total", labels: { server: "c", tool: "t" }, value: 1 },
      ],
      gauges: [{ name: "mcpd_uptime_seconds", labels: {}, value: 60 }],
    });

    expect(buildStatsLines(snap2, null).length).toBeGreaterThan(buildStatsLines(snap1, null).length);
  });
});

describe("StatsView", () => {
  it("shows loading state", () => {
    const { lastFrame } = render(
      React.createElement(StatsView, { metrics: null, loading: true, error: null, scrollOffset: 0, height: 20 }),
    );
    expect(lastFrame()).toContain("Loading metrics");
  });

  it("shows error state", () => {
    const { lastFrame } = render(
      React.createElement(StatsView, {
        metrics: null,
        loading: false,
        error: "connection refused",
        scrollOffset: 0,
        height: 20,
      }),
    );
    expect(lastFrame()).toContain("connection refused");
  });

  it("shows no metrics state", () => {
    const { lastFrame } = render(
      React.createElement(StatsView, { metrics: null, loading: false, error: null, scrollOffset: 0, height: 20 }),
    );
    expect(lastFrame()).toContain("No metrics available");
  });

  it("renders dashboard with metrics data", () => {
    const snap = makeSnapshot({
      counters: [
        { name: "mcpd_tool_calls_total", labels: { server: "a", tool: "search" }, value: 100 },
        { name: "mcpd_tool_errors_total", labels: { server: "a", tool: "search" }, value: 5 },
        { name: "mcpd_ipc_requests_total", labels: { method: "callTool" }, value: 200 },
        { name: "mcpd_ipc_errors_total", labels: { method: "callTool" }, value: 2 },
      ],
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 3661 },
        { name: "mcpd_servers_total", labels: {}, value: 3 },
        { name: "mcpd_servers_connected", labels: {}, value: 2 },
        { name: "mcpd_active_sessions", labels: {}, value: 1 },
      ],
      histograms: [
        {
          name: "mcpd_tool_call_duration_ms",
          labels: { server: "a", tool: "search" },
          count: 100,
          sum: 5000,
          buckets: [
            { le: 10, count: 20 },
            { le: 50, count: 50 },
            { le: 100, count: 80 },
            { le: 500, count: 100 },
          ],
        },
      ],
    });

    const { lastFrame } = render(
      React.createElement(StatsView, { metrics: snap, loading: false, error: null, scrollOffset: 0, height: 40 }),
    );
    const output = lastFrame() ?? "";

    expect(output).toContain("Dashboard");
    expect(output).toContain("1h 1m");
    expect(output).toContain("2/3");
    expect(output).toContain("100");
    expect(output).toContain("95%");
    expect(output).toContain("Servers");
    expect(output).toContain("Top Tools");
    expect(output).toContain("search");
  });

  it("renders empty dashboard when no tool calls exist", () => {
    const snap = makeSnapshot({
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 30 },
        { name: "mcpd_servers_total", labels: {}, value: 0 },
        { name: "mcpd_servers_connected", labels: {}, value: 0 },
      ],
    });

    const { lastFrame } = render(
      React.createElement(StatsView, { metrics: snap, loading: false, error: null, scrollOffset: 0, height: 40 }),
    );
    const output = lastFrame() ?? "";

    expect(output).toContain("Dashboard");
    expect(output).toContain("30s");
    expect(output).toContain("0/0");
    // Success rate shows "—" when no calls, not misleading "0%"
    expect(output).toContain("—");
    expect(output).not.toContain("0%");
    // No Servers or Top Tools sections when no tool calls
    expect(output).not.toContain("Servers");
    expect(output).not.toContain("Top Tools");
  });

  it("scrolls content when offset is applied", () => {
    const snap = makeSnapshot({
      counters: Array.from({ length: 20 }, (_, i) => ({
        name: "mcpd_tool_calls_total",
        labels: { server: `server-${i}`, tool: `tool-${i}` },
        value: 10 - i,
      })),
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 60 },
        { name: "mcpd_servers_total", labels: {}, value: 20 },
        { name: "mcpd_servers_connected", labels: {}, value: 20 },
      ],
    });

    // With small height and offset=0, should show Dashboard
    const { lastFrame: frame0 } = render(
      React.createElement(StatsView, { metrics: snap, loading: false, error: null, scrollOffset: 0, height: 5 }),
    );
    expect(frame0()).toContain("Dashboard");

    // With large offset, should skip past Dashboard to show later content
    const { lastFrame: frameOffset } = render(
      React.createElement(StatsView, { metrics: snap, loading: false, error: null, scrollOffset: 6, height: 5 }),
    );
    const output = frameOffset() ?? "";
    // Should show server entries instead of Dashboard header
    expect(output).toContain("server-");
  });

  it("shows scroll position indicator when content exceeds height", () => {
    const snap = makeSnapshot({
      counters: Array.from({ length: 20 }, (_, i) => ({
        name: "mcpd_tool_calls_total",
        labels: { server: `server-${i}`, tool: `tool-${i}` },
        value: 10,
      })),
      gauges: [
        { name: "mcpd_uptime_seconds", labels: {}, value: 60 },
        { name: "mcpd_servers_total", labels: {}, value: 20 },
        { name: "mcpd_servers_connected", labels: {}, value: 20 },
      ],
    });

    const { lastFrame } = render(
      React.createElement(StatsView, { metrics: snap, loading: false, error: null, scrollOffset: 0, height: 5 }),
    );
    const output = lastFrame() ?? "";
    // Should contain position indicator like [1-5/N]
    expect(output).toMatch(/\[\d+-\d+\/\d+\]/);
  });

  it("shows stale data warning when error occurs after successful fetch", () => {
    const snap = makeSnapshot({
      gauges: [{ name: "mcpd_uptime_seconds", labels: {}, value: 60 }],
    });

    const { lastFrame } = render(
      React.createElement(StatsView, {
        metrics: snap,
        loading: false,
        error: "connection refused",
        scrollOffset: 0,
        height: 40,
      }),
    );
    const output = lastFrame() ?? "";

    expect(output).toContain("stale data");
    expect(output).toContain("connection refused");
    // Still renders the dashboard with stale metrics
    expect(output).toContain("Dashboard");
  });
});
