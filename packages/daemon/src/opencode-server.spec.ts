import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OPENCODE_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { metrics } from "./metrics";
import { OpenCodeServer, buildOpenCodeToolCache, isOpenCodeWorkerEvent } from "./opencode-server";

// ── isOpenCodeWorkerEvent ──

describe("isOpenCodeWorkerEvent", () => {
  test("matches all known DB event types", () => {
    expect(isOpenCodeWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "db:state", sessionId: "s1", state: "active" })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 0 })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "db:disconnected", sessionId: "s1", reason: "x" })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);
  });

  test("matches metrics and ready event types", () => {
    expect(isOpenCodeWorkerEvent({ type: "metrics:inc", name: "foo" })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "metrics:observe", name: "foo", value: 1 })).toBe(true);
    expect(isOpenCodeWorkerEvent({ type: "ready" })).toBe(true);
  });

  test("rejects JSON-RPC messages", () => {
    expect(isOpenCodeWorkerEvent({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
  });

  test("rejects messages with unknown type values", () => {
    expect(isOpenCodeWorkerEvent({ type: "unknown" })).toBe(false);
    expect(isOpenCodeWorkerEvent({ type: "" })).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(isOpenCodeWorkerEvent(null)).toBe(false);
    expect(isOpenCodeWorkerEvent(undefined)).toBe(false);
    expect(isOpenCodeWorkerEvent("string")).toBe(false);
    expect(isOpenCodeWorkerEvent(42)).toBe(false);
  });

  test("rejects objects without type field", () => {
    expect(isOpenCodeWorkerEvent({})).toBe(false);
    expect(isOpenCodeWorkerEvent({ data: "foo" })).toBe(false);
  });
});

// ── buildOpenCodeToolCache ──

describe("buildOpenCodeToolCache", () => {
  test("returns all 9 opencode tools", () => {
    const tools = buildOpenCodeToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("opencode_prompt")).toBe(true);
    expect(tools.has("opencode_session_list")).toBe(true);
    expect(tools.has("opencode_session_status")).toBe(true);
    expect(tools.has("opencode_interrupt")).toBe(true);
    expect(tools.has("opencode_bye")).toBe(true);
    expect(tools.has("opencode_transcript")).toBe(true);
    expect(tools.has("opencode_wait")).toBe(true);
    expect(tools.has("opencode_approve")).toBe(true);
    expect(tools.has("opencode_deny")).toBe(true);
  });

  test("all tools have server set to _opencode", () => {
    const tools = buildOpenCodeToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(OPENCODE_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildOpenCodeToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── OPENCODE_SERVER_NAME ──

describe("OPENCODE_SERVER_NAME", () => {
  test("is _opencode", () => {
    expect(OPENCODE_SERVER_NAME).toBe("_opencode");
  });
});

// ── OpenCodeServer integration (real Worker + MCP handshake) ──

describe("OpenCodeServer", () => {
  let server: OpenCodeServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("start() connects and listTools returns opencode tools", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools.length).toBe(9);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "opencode_approve",
      "opencode_bye",
      "opencode_deny",
      "opencode_interrupt",
      "opencode_prompt",
      "opencode_session_list",
      "opencode_session_status",
      "opencode_transcript",
      "opencode_wait",
    ]);
  });

  test("opencode_session_list returns empty array initially", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const result = await client.callTool({ name: "opencode_session_list", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const sessions = JSON.parse(content[0].text);

    expect(sessions).toEqual([]);
  });

  test("opencode_session_status returns error for unknown session", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "opencode_session_status",
      arguments: { sessionId: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown session");
  });

  test("worker db:upsert event persists session to SQLite", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "s1", state: "active", model: "gpt-4o-mini", cwd: "/tmp" },
    });

    const row = db.getSession("s1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
    expect(row?.model).toBe("gpt-4o-mini");
  });

  test("worker db:state event updates session state", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "s2", state: "active" });

    const row = db.getSession("s2");
    expect(row?.state).toBe("active");
  });

  test("worker db:cost event updates cost and tokens", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s3", state: "active" } });
    handle({ type: "db:cost", sessionId: "s3", cost: 0.05, tokens: 1500 });

    const row = db.getSession("s3");
    expect(row?.totalCost).toBe(0.05);
    expect(row?.totalTokens).toBe(1500);
  });

  test("worker db:end event marks session as ended", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s4", state: "active" } });
    handle({ type: "db:end", sessionId: "s4" });

    const row = db.getSession("s4");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  test("hasActiveSessions() returns false initially", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-stop", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();
    expect(server.hasActiveSessions()).toBe(false);
    server = undefined;
  });

  test("stop() ends sessions in DB", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stop-end-1", state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "stop-end-2", state: "idle" } });

    await server.stop();

    const row1 = db.getSession("stop-end-1");
    expect(row1?.state).toBe("ended");
    expect(row1?.endedAt).not.toBeNull();

    const row2 = db.getSession("stop-end-2");
    expect(row2?.state).toBe("ended");
    expect(row2?.endedAt).not.toBeNull();

    server = undefined;
  });

  test("start() throws if called while worker is already running", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  test("onActivity is called on db:upsert, db:state, and db:cost events", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    let activityCount = 0;
    server.onActivity = () => {
      activityCount++;
    };

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s1", state: "active" } });
    expect(activityCount).toBe(1);

    handle({ type: "db:state", sessionId: "s1", state: "idle" });
    expect(activityCount).toBe(2);

    handle({ type: "db:cost", sessionId: "s1", cost: 0.01, tokens: 100 });
    expect(activityCount).toBe(3);

    // db:end and db:disconnected should NOT trigger onActivity
    handle({ type: "db:disconnected", sessionId: "s1", reason: "test" });
    expect(activityCount).toBe(3);

    handle({ type: "db:end", sessionId: "s1" });
    expect(activityCount).toBe(3);
  });

  // ── Crash recovery ──

  test("handleWorkerCrash auto-restarts and fires onRestarted", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    let restartedCalled = false;
    server.onRestarted = () => {
      restartedCalled = true;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    expect(restartedCalled).toBe(true);
  });

  test("handleWorkerCrash ends orphaned sessions after restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "crash-1", state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "crash-2", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    const row1 = db.getSession("crash-1");
    expect(row1?.state).toBe("ended");

    const row2 = db.getSession("crash-2");
    expect(row2?.state).toBe("ended");

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("handleWorkerCrash queues second crash during restart and retries", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);

    // Fire two crashes concurrently — second queues behind the first, both restart
    await Promise.all([crash("crash A"), crash("crash B")]);

    expect(restartCount).toBe(2);
  });

  test("handleWorkerCrash gives up after too many crashes", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);

    // Crash MAX_CRASHES times (3) — all should succeed
    for (let i = 0; i < 3; i++) {
      await crash(`crash ${i}`);
    }
    expect(restartCount).toBe(3);

    // Add sessions before exhaustion crash
    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "exhaust-1", state: "active" } });

    // 4th crash — rate-limited
    await crash("crash 3");
    expect(restartCount).toBe(3);
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() prevents auto-restart on subsequent crash", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();
    await server.stop();

    let restartedCalled = false;
    server.onRestarted = () => {
      restartedCalled = true;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("post-stop crash");

    expect(restartedCalled).toBe(false);
    server = undefined;
  });

  // ── Session TTL pruning ──

  test("pruneDeadSessions prunes sessions after TTL expires", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stale-1", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    // Not yet expired
    server.pruneDeadSessions(Date.now());
    expect(server.hasActiveSessions()).toBe(true);

    // Simulate time past TTL (10+ minutes)
    const future = Date.now() + 11 * 60 * 1000;
    server.pruneDeadSessions(future);

    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("stale-1");
    expect(row?.state).toBe("ended");
  });

  test("db:state event refreshes sessionAddedAt so active sessions survive TTL prune", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    const internals = server as unknown as { sessionAddedAt: Map<string, number> };

    handle({ type: "db:upsert", session: { sessionId: "active-1", state: "active" } });

    // Backdate the creation to 9 minutes ago
    const nineMinAgo = Date.now() - 9 * 60 * 1000;
    internals.sessionAddedAt.set("active-1", nineMinAgo);

    // 9min < 10min TTL — should survive
    server.pruneDeadSessions(Date.now());
    expect(server.hasActiveSessions()).toBe(true);

    // Send a db:state event to refresh the timestamp
    handle({ type: "db:state", sessionId: "active-1", state: "idle" });

    // Prune at 11 minutes from original creation — session should SURVIVE
    // because db:state refreshed the timestamp to ~now
    server.pruneDeadSessions(nineMinAgo + 11 * 60 * 1000);
    expect(server.hasActiveSessions()).toBe(true);

    // Prune 11 minutes after the refresh — NOW it should be pruned
    const refreshedAt = internals.sessionAddedAt.get("active-1") ?? 0;
    server.pruneDeadSessions(refreshedAt + 11 * 60 * 1000);
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("db:cost event also refreshes sessionAddedAt", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "cost-1", state: "active" } });

    const internals = server as unknown as { sessionAddedAt: Map<string, number> };
    const originalAt = internals.sessionAddedAt.get("cost-1") ?? 0;

    handle({ type: "db:cost", sessionId: "cost-1", cost: 0.01, tokens: 100 });
    const afterCost = internals.sessionAddedAt.get("cost-1") ?? 0;

    expect(afterCost).toBeGreaterThanOrEqual(originalAt);
  });

  // ── Worker cleanup on start() failure ──

  test("start() terminates worker and nulls state if client.connect() throws", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    const fakeClient = {
      connect: async () => {
        throw new Error("simulated connect failure");
      },
      close: async () => {},
    };
    server = new OpenCodeServer(db, undefined, () => fakeClient as never, silentLogger);

    await expect(server.start()).rejects.toThrow("simulated connect failure");

    const internals = server as unknown as {
      worker: Worker | null;
      transport: unknown;
      client: unknown;
    };
    expect(internals.worker).toBeNull();
    expect(internals.transport).toBeNull();
    expect(internals.client).toBeNull();
    server = undefined;
  });
});

// ── connect timeout metric ──

describe("OpenCodeServer connect timeout metric", () => {
  let server: OpenCodeServer | undefined;
  let db: StateDb | undefined;

  beforeEach(() => {
    metrics.reset();
  });

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("increments mcpd_connect_timeouts_total when handshake times out", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    const neverConnect = {
      connect: () => new Promise<void>(() => {}),
      close: async () => {},
    } as unknown as Client;

    server = new OpenCodeServer(db, undefined, () => neverConnect, silentLogger, 50);

    await expect(server.start()).rejects.toThrow("MCP handshake timeout (0.05s)");
    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(1);
  });

  test("does not increment counter on successful connect", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new OpenCodeServer(db, undefined, undefined, silentLogger);

    await server.start();

    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(0);
  });
});
