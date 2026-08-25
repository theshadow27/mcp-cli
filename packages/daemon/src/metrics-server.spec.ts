import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_COMMIT, BUILD_VERSION, METRICS_SERVER_NAME, PROTOCOL_VERSION } from "@mcp-cli/core";
import { StateDb } from "./db/state";
import { MetricsCollector } from "./metrics";
import { MetricsServer, buildInfo } from "./metrics-server";

const dbPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `mcp-metrics-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
        // dotw-ignore test-empty-catch: best-effort cleanup — file may already be gone
      } catch {
        /* ignore */
      }
    }
  }
  dbPaths.length = 0;
});

const SETTLE_MS = 50;

describe("METRICS_SERVER_NAME", () => {
  test("is _metrics", () => {
    expect(METRICS_SERVER_NAME).toBe("_metrics");
  });
});

describe("start() returns tool cache", () => {
  test("returns 6 tools with correct server name", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { tools } = await server.start();
      expect(tools.size).toBe(6);
      expect(tools.has("get_metrics")).toBe(true);
      expect(tools.has("get_metric")).toBe(true);
      expect(tools.has("get_health")).toBe(true);
      expect(tools.has("quota_status")).toBe(true);
      expect(tools.has("get_domain_spend")).toBe(true);
      expect(tools.has("build_info")).toBe(true);
      for (const [, info] of tools) {
        expect(info.server).toBe("_metrics");
      }
    } finally {
      await server.stop();
    }
  });
});

describe("MetricsServer", () => {
  test("start returns client, transport, and tools", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client, transport, tools } = await server.start();
      expect(client).toBeDefined();
      expect(transport).toBeDefined();
      expect(tools).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  test("double start throws", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      await server.start();
      await expect(server.start()).rejects.toThrow("MetricsServer already started");
    } finally {
      await server.stop();
    }
  });

  test("can restart after stop", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    await server.start();
    await server.stop();
    const { client } = await server.start();
    expect(client).toBeDefined();
    await server.stop();
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

  test("get_metric returns error for non-string label values", async () => {
    const collector = new MetricsCollector();
    collector.counter("mcpd_tool_calls_total", { server: "foo" }).inc(3);
    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({
        name: "get_metric",
        arguments: { name: "mcpd_tool_calls_total", labels: { server: 42 } },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("must be a string");
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

  test("listTools returns all 5 tools", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.listTools();
      expect(result.tools).toHaveLength(6);
      expect(result.tools.map((t) => t.name).sort()).toEqual(
        ["build_info", "get_domain_spend", "get_health", "get_metric", "get_metrics", "quota_status"].sort(),
      );
    } finally {
      await server.stop();
    }
  });

  // Build provenance (#3264): a build epoch says when a binary was compiled,
  // never from what — so a build of a stale checkout is indistinguishable from
  // one containing a merged fix. This tool is the always-available answer.
  test("build_info reports version, protocol, and source commit", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "build_info", arguments: {} });
      const info = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(info.version).toBe(BUILD_VERSION);
      expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
      // Under `bun test` the daemon runs from source, so there is no injected
      // commit — null is the correct answer, and distinguishable from a daemon
      // too old to have the tool at all (which errors instead).
      expect(info).toHaveProperty("commit");
      expect(info.commit).toBe(BUILD_COMMIT);
    } finally {
      await server.stop();
    }
  });

  test("build_info commit is either null or a well-formed stamp", async () => {
    const info = buildInfo();
    if (info.commit !== null) {
      expect(info.commit).toMatch(/^[0-9a-f]{12}(-dirty|-unknown)?$/);
    }
  });

  test("quota_status returns available:false when no poller", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector); // no quota poller
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "quota_status", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);
      expect(data.available).toBe(false);
      expect(data.lastError).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  test("quota_status says 'not started' before the poller's first tick, and gives a timestamped reason after (#3223)", async () => {
    const collector = new MetricsCollector();
    const { QuotaPoller } = await import("./quota");

    // Never started: still the "not started" message.
    const neverStarted = new QuotaPoller({ intervalMs: 60_000, readToken: async () => null });
    const notStartedServer = new MetricsServer(collector, neverStarted);
    try {
      const { client } = await notStartedServer.start();
      const result = await client.callTool({ name: "quota_status", arguments: {} });
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      expect(data.available).toBe(false);
      expect(data.lastError).toBe("Quota monitoring not started");
      expect(data.lastAttemptAt).toBeNull();
    } finally {
      await notStartedServer.stop();
    }

    // Started, but the token source never finds a token (e.g. unconfigured host): a
    // distinguishable, timestamped reason instead of the misleading default forever.
    const attemptedNoToken = new QuotaPoller({ intervalMs: 60_000, readToken: async () => null });
    attemptedNoToken.start();
    await Bun.sleep(SETTLE_MS);
    attemptedNoToken.stop();

    const attemptedServer = new MetricsServer(collector, attemptedNoToken);
    try {
      const { client } = await attemptedServer.start();
      const result = await client.callTool({ name: "quota_status", arguments: {} });
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      expect(data.available).toBe(false);
      expect(data.lastError).not.toBe("Quota monitoring not started");
      expect(data.lastError).toContain("No Claude Code OAuth token found");
      expect(data.lastAttemptAt).toBeGreaterThan(0);
    } finally {
      await attemptedServer.stop();
    }
  });

  test("quota_status returns available:true with data when poller has status", async () => {
    const collector = new MetricsCollector();
    const { QuotaPoller, parseUsageResponse } = await import("./quota");
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      readToken: async () => ({ accessToken: "tok", expiresAt: Date.now() + 3_600_000 }),
      fetchUsage: async () =>
        parseUsageResponse({
          five_hour: { utilization: 55, resets_at: "2026-04-08T20:00:00Z" },
          seven_day: { utilization: 10, resets_at: "2026-04-14T00:00:00Z" },
        }),
    });
    poller.start();
    await Bun.sleep(SETTLE_MS);
    poller.stop();

    const server = new MetricsServer(collector, poller);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "quota_status", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);
      expect(data.available).toBe(true);
      expect(data.fiveHour?.utilization).toBe(55);
      expect(data.sevenDay?.utilization).toBe(10);
      expect(data.fetchedAt).toBeGreaterThan(0);
      expect(data.lastError).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test("quota_status returns available:false with lastError when poller has error", async () => {
    const collector = new MetricsCollector();
    const { QuotaPoller } = await import("./quota");
    const poller = new QuotaPoller({
      intervalMs: 60_000,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      readToken: async () => ({ accessToken: "tok", expiresAt: Date.now() + 3_600_000 }),
      fetchUsage: async () => {
        throw new Error("API returned 503");
      },
    });
    poller.start();
    await Bun.sleep(SETTLE_MS);
    poller.stop();

    const server = new MetricsServer(collector, poller);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "quota_status", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);
      expect(data.available).toBe(false);
      expect(data.lastError).toContain("503");
    } finally {
      await server.stop();
    }
  });

  test("get_domain_spend returns error when no StateDb is configured", async () => {
    const collector = new MetricsCollector();
    const server = new MetricsServer(collector); // no db
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_domain_spend", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("StateDb");
    } finally {
      await server.stop();
    }
  });

  test("get_domain_spend rolls up agent_sessions by domain", async () => {
    const collector = new MetricsCollector();
    const db = new StateDb(tmpDbPath());
    const phoenix = db.createDomain("phoenix", "/repo/phoenix");
    db.upsertSession({ sessionId: "p1", model: "opus" });
    db.updateSessionCost("p1", 1.5, 1000);
    db.database.run("UPDATE agent_sessions SET domain_id = ? WHERE session_id = ?", [phoenix.id, "p1"]);

    const server = new MetricsServer(collector, undefined, db);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_domain_spend", arguments: { domain: "phoenix" } });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);
      expect(data.totals).toHaveLength(1);
      expect(data.totals[0].domain).toBe("phoenix");
      expect(data.totals[0].totalCost).toBe(1.5);
      expect(data.totals[0].source).toBe("daemon");
      expect(data.sessions[0].sessionId).toBe("p1");
    } finally {
      await server.stop();
      db.close();
    }
  });

  test("get_domain_spend rejects a non-string domain argument", async () => {
    const collector = new MetricsCollector();
    const db = new StateDb(tmpDbPath());
    const server = new MetricsServer(collector, undefined, db);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_domain_spend", arguments: { domain: 42 } });
      expect(result.isError).toBe(true);
    } finally {
      await server.stop();
      db.close();
    }
  });

  test("get_domain_spend rejects a non-number sinceMs argument", async () => {
    const collector = new MetricsCollector();
    const db = new StateDb(tmpDbPath());
    const server = new MetricsServer(collector, undefined, db);
    try {
      const { client } = await server.start();
      const result = await client.callTool({ name: "get_domain_spend", arguments: { sinceMs: "yesterday" } });
      expect(result.isError).toBe(true);
    } finally {
      await server.stop();
      db.close();
    }
  });
});
