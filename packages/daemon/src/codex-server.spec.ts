import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CODEX_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { testOptions } from "../../../test/test-options";
import { CodexServer, buildCodexToolCache, isWorkerEvent } from "./codex-server";
import { StateDb } from "./db/state";
import { metrics } from "./metrics";

// ── isWorkerEvent ──

describe("isWorkerEvent (codex)", () => {
  test("matches all known DB event types", () => {
    expect(isWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isWorkerEvent({ type: "db:state", sessionId: "s1", state: "active" })).toBe(true);
    expect(isWorkerEvent({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 0 })).toBe(true);
    expect(isWorkerEvent({ type: "db:disconnected", sessionId: "s1", reason: "x" })).toBe(true);
    expect(isWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);
  });

  test("matches metrics and ready event types", () => {
    expect(isWorkerEvent({ type: "metrics:inc", name: "foo" })).toBe(true);
    expect(isWorkerEvent({ type: "metrics:observe", name: "foo", value: 1 })).toBe(true);
    expect(isWorkerEvent({ type: "ready" })).toBe(true);
  });

  test("rejects JSON-RPC messages", () => {
    expect(isWorkerEvent({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
  });

  test("rejects messages with unknown type values", () => {
    expect(isWorkerEvent({ type: "unknown" })).toBe(false);
    expect(isWorkerEvent({ type: "" })).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(isWorkerEvent(null)).toBe(false);
    expect(isWorkerEvent(undefined)).toBe(false);
    expect(isWorkerEvent("string")).toBe(false);
    expect(isWorkerEvent(42)).toBe(false);
  });

  test("rejects objects without type field", () => {
    expect(isWorkerEvent({})).toBe(false);
    expect(isWorkerEvent({ data: "foo" })).toBe(false);
  });
});

// ── buildCodexToolCache ──

describe("buildCodexToolCache", () => {
  test("returns all 9 codex tools", () => {
    const tools = buildCodexToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("codex_prompt")).toBe(true);
    expect(tools.has("codex_session_list")).toBe(true);
    expect(tools.has("codex_session_status")).toBe(true);
    expect(tools.has("codex_interrupt")).toBe(true);
    expect(tools.has("codex_bye")).toBe(true);
    expect(tools.has("codex_transcript")).toBe(true);
    expect(tools.has("codex_wait")).toBe(true);
    expect(tools.has("codex_approve")).toBe(true);
    expect(tools.has("codex_deny")).toBe(true);
  });

  test("all tools have server set to _codex", () => {
    const tools = buildCodexToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(CODEX_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildCodexToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── CODEX_SERVER_NAME ──

describe("CODEX_SERVER_NAME", () => {
  test("is _codex", () => {
    expect(CODEX_SERVER_NAME).toBe("_codex");
  });
});

// ── CodexServer integration (real Worker + MCP handshake) ──

describe("CodexServer", () => {
  let server: CodexServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  // ── Shared server for read-only integration tests ──
  describe("read-only (shared worker)", () => {
    let sharedServer: CodexServer;
    let sharedDb: StateDb;
    let sharedClient: Awaited<ReturnType<CodexServer["start"]>>["client"];
    let sharedOpts: ReturnType<typeof testOptions>;
    let initialized = false;

    async function ensureServer(): Promise<void> {
      if (!initialized) {
        sharedOpts = testOptions();
        sharedDb = new StateDb(sharedOpts.DB_PATH);
        sharedServer = new CodexServer(sharedDb, undefined, undefined, silentLogger);
        const { client: c } = await sharedServer.start();
        sharedClient = c;
        initialized = true;
      }
    }

    beforeEach(() => {
      server = undefined;
      db = undefined;
    });

    afterAll(async () => {
      await sharedServer?.stop();
      sharedDb?.close();
      sharedOpts?.[Symbol.dispose]();
    });

    test("start() connects and listTools returns codex tools", async () => {
      await ensureServer();
      const { tools } = await sharedClient.listTools();

      expect(tools.length).toBe(9);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "codex_approve",
        "codex_bye",
        "codex_deny",
        "codex_interrupt",
        "codex_prompt",
        "codex_session_list",
        "codex_session_status",
        "codex_transcript",
        "codex_wait",
      ]);
    });

    test("codex_session_list returns empty array initially", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({ name: "codex_session_list", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0].text);

      expect(sessions).toEqual([]);
    });

    test("codex_session_status returns error for unknown session", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({
        name: "codex_session_status",
        arguments: { sessionId: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Unknown session");
    });
  });

  // handleWorkerEvent tests don't need start() — they call the private method directly
  test("worker db:upsert event persists session to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "s1", state: "active", model: "codex-mini", cwd: "/tmp" },
    });

    const row = db.getSession("s1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
    expect(row?.model).toBe("codex-mini");
  });

  test("worker db:state event updates session state", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "s2", state: "active" });

    const row = db.getSession("s2");
    expect(row?.state).toBe("active");
  });

  test("worker db:cost event updates cost and tokens", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s3", state: "active" } });
    handle({ type: "db:cost", sessionId: "s3", cost: 0.05, tokens: 1500 });

    const row = db.getSession("s3");
    expect(row?.totalCost).toBe(0.05);
    expect(row?.totalTokens).toBe(1500);
  });

  test("worker db:end event marks session as ended", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s4", state: "active" } });
    handle({ type: "db:end", sessionId: "s4" });

    const row = db.getSession("s4");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  test("hasActiveSessions() returns false initially", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

    await server.start();

    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  test("onActivity is called on db:upsert, db:state, and db:cost events", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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
    server = new CodexServer(db, undefined, undefined, silentLogger);

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

  test("pruneDeadSessions prunes sessions after TTL expires", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

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

  test("db:state event refreshes sessionAddedAt so active sessions survive TTL prune", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    const internals = server as unknown as { sessionAddedAt: Map<string, number> };

    handle({ type: "db:upsert", session: { sessionId: "active-1", state: "active" } });

    // Backdate the creation to 9 minutes ago (simulating passage of time)
    const nineMinAgo = Date.now() - 9 * 60 * 1000;
    internals.sessionAddedAt.set("active-1", nineMinAgo);

    // Without a db:state event, pruning at now would kill it (9min old, but close to 10min)
    // Let's verify it survives at exactly now (9min < 10min TTL)
    server.pruneDeadSessions(Date.now());
    expect(server.hasActiveSessions()).toBe(true);

    // Now simulate 2 more minutes — 11min total, should be pruned if not refreshed
    // But first, send a db:state event to refresh the timestamp
    handle({ type: "db:state", sessionId: "active-1", state: "idle" });

    // Now prune at 11 minutes from original creation — session should SURVIVE
    // because db:state refreshed the timestamp to ~now
    server.pruneDeadSessions(nineMinAgo + 11 * 60 * 1000);
    expect(server.hasActiveSessions()).toBe(true);

    // Prune 11 minutes after the refresh — NOW it should be pruned
    const refreshedAt = internals.sessionAddedAt.get("active-1") ?? 0;
    server.pruneDeadSessions(refreshedAt + 11 * 60 * 1000);
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("db:cost event also refreshes sessionAddedAt", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "cost-1", state: "active" } });

    const internals = server as unknown as { sessionAddedAt: Map<string, number> };
    const originalAt = internals.sessionAddedAt.get("cost-1") ?? 0;

    // Simulate a cost event arriving later
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
    server = new CodexServer(db, undefined, () => fakeClient as never, silentLogger);

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

describe("CodexServer connect timeout metric", () => {
  let server: CodexServer | undefined;
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

    // Mock client that never resolves connect() — forces the handshake timeout to fire
    const neverConnect = {
      connect: () => new Promise<void>(() => {}),
      close: async () => {},
    } as unknown as Client;

    server = new CodexServer(db, undefined, () => neverConnect, silentLogger, 50);

    await expect(server.start()).rejects.toThrow("MCP handshake timeout (10s)");
    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(1);
  });

  test("does not increment counter on successful connect", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new CodexServer(db, undefined, undefined, silentLogger);

    await server.start();

    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(0);
  });
});
