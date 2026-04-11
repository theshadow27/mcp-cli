import { afterEach, describe, expect, test } from "bun:test";
import { TRACING_SERVER_NAME } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { TracingServer, buildTracingToolCache } from "./tracing-server";

describe("buildTracingToolCache", () => {
  test("returns all 3 tools", () => {
    const cache = buildTracingToolCache();
    expect(cache.size).toBe(3);
    expect(cache.has("query_traces")).toBe(true);
    expect(cache.has("list_daemons")).toBe(true);
    expect(cache.has("get_trace")).toBe(true);
  });

  test("each tool has correct server name", () => {
    const cache = buildTracingToolCache();
    for (const tool of cache.values()) {
      expect(tool.server).toBe(TRACING_SERVER_NAME);
    }
  });
});

describe("TracingServer", () => {
  let server: TracingServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  function insertSpan(
    stateDb: StateDb,
    overrides?: Partial<{
      traceId: string;
      spanId: string;
      parentSpanId: string;
      name: string;
      startTimeMs: number;
      endTimeMs: number;
      durationMs: number;
      status: string;
      daemonId: string;
      attributes: Record<string, string | number | boolean>;
      events: Array<{ name: string; timeMs: number; attributes?: Record<string, string | number | boolean> }>;
    }>,
  ): void {
    const span = {
      traceId: overrides?.traceId ?? "a".repeat(32),
      spanId: overrides?.spanId ?? "b".repeat(16),
      parentSpanId: overrides?.parentSpanId,
      traceFlags: "01",
      name: overrides?.name ?? "test_span",
      startTimeMs: overrides?.startTimeMs ?? 1000,
      endTimeMs: overrides?.endTimeMs ?? 2000,
      durationMs: overrides?.durationMs ?? 1000,
      status: (overrides?.status ?? "OK") as "OK" | "ERROR" | "UNSET",
      attributes: overrides?.attributes ?? {},
      events: overrides?.events ?? [],
    };
    stateDb.recordSpan(span, overrides?.daemonId);
  }

  function parseResult(
    result: Awaited<ReturnType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client.prototype.callTool>>,
  ): Record<string, unknown> {
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text);
  }

  test("start() connects and listTools returns 3 tools", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new TracingServer(db);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name).sort()).toEqual(["get_trace", "list_daemons", "query_traces"]);
  });

  test("double start throws", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new TracingServer(db);
    await server.start();
    await expect(server.start()).rejects.toThrow("TracingServer already started");
  });

  test("can restart after stop", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new TracingServer(db);
    await server.start();
    await server.stop();
    const { client } = await server.start();
    expect(client).toBeDefined();
  });

  test("unknown tool returns error", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new TracingServer(db);
    const { client } = await server.start();
    const result = await client.callTool({ name: "nonexistent", arguments: {} });
    expect(result.isError).toBe(true);
  });

  describe("query_traces", () => {
    test("returns empty when no spans", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: {} }));
      expect(data.spans).toEqual([]);
    });

    test("does not include count field", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "span1".padEnd(16, "0") });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: {} }));
      expect(data).not.toHaveProperty("count");
    });

    test("does not include exportedAt in spans", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "span1".padEnd(16, "0") });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: {} }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans[0]).not.toHaveProperty("exportedAt");
    });

    test("returns all spans with no filters", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "span1".padEnd(16, "0") });
      insertSpan(db, { spanId: "span2".padEnd(16, "0") });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: {} }));
      expect((data.spans as unknown[]).length).toBe(2);
    });

    test("filters by daemon_id", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), daemonId: "daemon-1" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), daemonId: "daemon-2" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { daemon_id: "daemon-1" } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].daemonId).toBe("daemon-1");
    });

    test("filters by trace_id", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const traceA = "a".repeat(32);
      const traceB = "b".repeat(32);
      insertSpan(db, { traceId: traceA, spanId: "s1".padEnd(16, "0") });
      insertSpan(db, { traceId: traceB, spanId: "s2".padEnd(16, "0") });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { trace_id: traceA } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].traceId).toBe(traceA);
    });

    test("filters by status", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), status: "OK" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), status: "ERROR" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { status: "ERROR" } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].status).toBe("ERROR");
    });

    test("filters by time range", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), startTimeMs: 1000 });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), startTimeMs: 2000 });
      insertSpan(db, { spanId: "s3".padEnd(16, "0"), startTimeMs: 3000 });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(
        await client.callTool({ name: "query_traces", arguments: { since_ms: 1500, until_ms: 2500 } }),
      );
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].startTimeMs).toBe(2000);
    });

    test("respects limit", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      for (let i = 0; i < 5; i++) {
        insertSpan(db, { spanId: `s${i}`.padEnd(16, "0"), startTimeMs: 1000 + i });
      }

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { limit: 2 } }));
      expect((data.spans as unknown[]).length).toBe(2);
    });

    test("clamps limit to valid range", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = new TracingServer(db);
      const { client } = await server.start();

      // Should not error with oversized or zero limit
      const over = parseResult(await client.callTool({ name: "query_traces", arguments: { limit: 9999 } }));
      expect(over.spans).toEqual([]);

      const zero = parseResult(await client.callTool({ name: "query_traces", arguments: { limit: 0 } }));
      expect(zero.spans).toEqual([]);
    });

    test("filters by server name substring", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), name: "tool_call:atlassian:search" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), name: "tool_call:github:list_prs" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { server: "atlassian" } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].name).toContain("atlassian");
    });

    test("tool filter matches end of span name (after last colon)", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), name: "tool_call:atlassian:search" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), name: "tool_call:github:search" });
      insertSpan(db, { spanId: "s3".padEnd(16, "0"), name: "tool_call:github:list_prs" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { tool: "search" } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(2);
    });

    test("combined server and tool filter", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), name: "tool_call:atlassian:search" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), name: "tool_call:github:search" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(
        await client.callTool({ name: "query_traces", arguments: { server: "atlassian", tool: "search" } }),
      );
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe("tool_call:atlassian:search");
    });

    test("LIKE wildcards in filter values are escaped", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), name: "tool_call:a%b:search" });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), name: "tool_call:axb:search" });

      server = new TracingServer(db);
      const { client } = await server.start();

      // "a%b" should match only the literal percent, not wildcard
      const data = parseResult(await client.callTool({ name: "query_traces", arguments: { server: "a%b" } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe("tool_call:a%b:search");
    });

    test("after_id enables cursor pagination", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      for (let i = 0; i < 5; i++) {
        insertSpan(db, { spanId: `s${i}`.padEnd(16, "0"), startTimeMs: 1000 + i });
      }

      server = new TracingServer(db);
      const { client } = await server.start();

      // Get first page
      const page1 = parseResult(await client.callTool({ name: "query_traces", arguments: { limit: 2 } }));
      const page1Spans = page1.spans as Array<Record<string, unknown>>;
      expect(page1Spans.length).toBe(2);

      // Get second page using last id from first page
      const lastId = page1Spans[page1Spans.length - 1].id as number;
      const page2 = parseResult(
        await client.callTool({ name: "query_traces", arguments: { limit: 2, after_id: lastId } }),
      );
      const page2Spans = page2.spans as Array<Record<string, unknown>>;
      expect(page2Spans.length).toBe(2);

      // Pages should not overlap
      const page1Ids = new Set(page1Spans.map((s) => s.id));
      for (const s of page2Spans) {
        expect(page1Ids.has(s.id as number)).toBe(false);
      }
    });
  });

  describe("list_daemons", () => {
    test("returns empty when no spans", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "list_daemons", arguments: {} }));
      expect(data.daemons).toEqual([]);
      expect(data).not.toHaveProperty("count");
    });

    test("groups spans by daemon_id", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0"), daemonId: "daemon-1", startTimeMs: 1000 });
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), daemonId: "daemon-1", startTimeMs: 2000 });
      insertSpan(db, { spanId: "s3".padEnd(16, "0"), daemonId: "daemon-2", startTimeMs: 3000 });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "list_daemons", arguments: {} }));
      const daemons = data.daemons as Array<Record<string, unknown>>;
      expect(daemons.length).toBe(2);
      const d1 = daemons.find((d) => d.daemonId === "daemon-1");
      expect(d1).toBeDefined();
      expect(d1?.spanCount).toBe(2);
      expect(d1?.earliestMs).toBe(1000);
      expect(d1?.latestMs).toBe(2000);
    });

    test("excludes spans with null daemon_id", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      insertSpan(db, { spanId: "s1".padEnd(16, "0") }); // no daemonId
      insertSpan(db, { spanId: "s2".padEnd(16, "0"), daemonId: "daemon-1" });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "list_daemons", arguments: {} }));
      expect((data.daemons as unknown[]).length).toBe(1);
    });
  });

  describe("get_trace", () => {
    test("returns error for missing trace_id", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = new TracingServer(db);
      const { client } = await server.start();

      const result = await client.callTool({ name: "get_trace", arguments: {} });
      expect(result.isError).toBe(true);
    });

    test("returns empty for nonexistent trace", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "get_trace", arguments: { trace_id: "x".repeat(32) } }));
      expect((data.spans as unknown[]).length).toBe(0);
      expect(data.trace_id).toBe("x".repeat(32));
      expect(data).not.toHaveProperty("count");
    });

    test("returns all spans for a trace ordered by start time ASC", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const traceId = "a".repeat(32);
      insertSpan(db, { traceId, spanId: "s1".padEnd(16, "0"), startTimeMs: 3000, name: "child_b" });
      insertSpan(db, { traceId, spanId: "s2".padEnd(16, "0"), startTimeMs: 1000, name: "root" });
      insertSpan(db, { traceId, spanId: "s3".padEnd(16, "0"), startTimeMs: 2000, name: "child_a" });
      // Different trace — should not appear
      insertSpan(db, { traceId: "b".repeat(32), spanId: "s4".padEnd(16, "0"), startTimeMs: 1500 });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "get_trace", arguments: { trace_id: traceId } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(3);
      expect(data.trace_id).toBe(traceId);
      // Ordered by start time ASC
      expect(spans[0].name).toBe("root");
      expect(spans[1].name).toBe("child_a");
      expect(spans[2].name).toBe("child_b");
    });

    test("includes attributes and events but not exportedAt", async () => {
      using opts = testOptions();
      db = new StateDb(opts.DB_PATH);
      const traceId = "c".repeat(32);
      insertSpan(db, {
        traceId,
        spanId: "s1".padEnd(16, "0"),
        attributes: { "tool.name": "search", "tool.server": "atlassian" },
        events: [{ name: "error", timeMs: 1500, attributes: { message: "timeout" } }],
      });

      server = new TracingServer(db);
      const { client } = await server.start();

      const data = parseResult(await client.callTool({ name: "get_trace", arguments: { trace_id: traceId } }));
      const spans = data.spans as Array<Record<string, unknown>>;
      expect((spans[0].attributes as Record<string, string>)["tool.name"]).toBe("search");
      expect((spans[0].events as Array<Record<string, string>>)[0].name).toBe("error");
      expect(spans[0]).not.toHaveProperty("exportedAt");
    });
  });
});
