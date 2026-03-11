import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "./metrics";
import { METRICS_SERVER_NAME, MetricsServer, buildMetricsToolCache } from "./metrics-server";

describe("METRICS_SERVER_NAME", () => {
  test("is _metrics", () => {
    expect(METRICS_SERVER_NAME).toBe("_metrics");
  });
});

describe("buildMetricsToolCache", () => {
  test("returns 3 tools", () => {
    const cache = buildMetricsToolCache();
    expect(cache.size).toBe(3);
    expect(cache.has("get_metrics")).toBe(true);
    expect(cache.has("get_metric")).toBe(true);
    expect(cache.has("get_health")).toBe(true);
  });

  test("tool entries have correct server name", () => {
    const cache = buildMetricsToolCache();
    for (const [, info] of cache) {
      expect(info.server).toBe("_metrics");
    }
  });
});

describe("MetricsServer", () => {
  test("start returns client and transport", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client, transport } = await server.start();
      expect(client).toBeDefined();
      expect(transport).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  test("get_metrics returns full snapshot", async () => {
    const collector = new MetricsCollector();
    collector.counter("test_counter").inc(5);
    collector.gauge("test_gauge").set(42);

    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_metrics", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const snap = JSON.parse(text);

      expect(snap.collectedAt).toBeNumber();
      expect(snap.counters).toBeArray();
      expect(snap.gauges).toBeArray();
      expect(snap.histograms).toBeArray();
      expect(snap.counters.find((c: Record<string, unknown>) => c.name === "test_counter")?.value).toBe(5);
      expect(snap.gauges.find((g: Record<string, unknown>) => g.name === "test_gauge")?.value).toBe(42);
    } finally {
      await server.stop();
    }
  });

  test("get_metric filters by name", async () => {
    const collector = new MetricsCollector();
    collector.counter("mcpd_tool_calls_total", { server: "foo" }).inc(3);
    collector.counter("mcpd_tool_calls_total", { server: "bar" }).inc(7);
    collector.counter("mcpd_other_metric").inc(1);

    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({
        name: "get_metric",
        arguments: { name: "mcpd_tool_calls_total" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);

      expect(data.name).toBe("mcpd_tool_calls_total");
      expect(data.series).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  test("get_metric filters by labels", async () => {
    const collector = new MetricsCollector();
    collector.counter("mcpd_tool_calls_total", { server: "foo" }).inc(3);
    collector.counter("mcpd_tool_calls_total", { server: "bar" }).inc(7);

    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({
        name: "get_metric",
        arguments: { name: "mcpd_tool_calls_total", labels: { server: "bar" } },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);

      expect(data.series).toHaveLength(1);
      expect(data.series[0].value).toBe(7);
    } finally {
      await server.stop();
    }
  });

  test("get_metric returns error for missing name", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_metric", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("get_health returns summary object", async () => {
    const collector = new MetricsCollector();
    collector.gauge("mcpd_uptime_seconds").set(120);
    collector.gauge("mcpd_servers_total").set(5);
    collector.gauge("mcpd_servers_connected").set(3);
    collector.gauge("mcpd_active_sessions").set(2);
    collector.counter("mcpd_tool_calls_total", { server: "a" }).inc(10);
    collector.counter("mcpd_tool_calls_total", { server: "b" }).inc(5);
    collector.counter("mcpd_tool_errors_total", { server: "a" }).inc(1);

    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_health", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const health = JSON.parse(text);

      expect(health.uptime_seconds).toBe(120);
      expect(health.servers_total).toBe(5);
      expect(health.servers_connected).toBe(3);
      expect(health.active_sessions).toBe(2);
      expect(health.tool_calls_total).toBe(15);
      expect(health.tool_errors_total).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("unknown tool returns error", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "nonexistent", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
