import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MOCK_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import { MockServer, buildMockToolCache, isWorkerEvent } from "./mock-server";

// ── isWorkerEvent ──

describe("isWorkerEvent (mock)", () => {
  test("matches all known DB event types", () => {
    expect(isWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isWorkerEvent({ type: "db:state", sessionId: "s1", state: "active" })).toBe(true);
    expect(isWorkerEvent({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 0 })).toBe(true);
    expect(isWorkerEvent({ type: "db:disconnected", sessionId: "s1", reason: "x" })).toBe(true);
    expect(isWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);
  });

  test("matches ready event type", () => {
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

// ── buildMockToolCache ──

describe("buildMockToolCache", () => {
  test("returns all 9 mock tools", () => {
    const tools = buildMockToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("mock_prompt")).toBe(true);
    expect(tools.has("mock_session_list")).toBe(true);
    expect(tools.has("mock_session_status")).toBe(true);
    expect(tools.has("mock_interrupt")).toBe(true);
    expect(tools.has("mock_bye")).toBe(true);
    expect(tools.has("mock_transcript")).toBe(true);
    expect(tools.has("mock_wait")).toBe(true);
    expect(tools.has("mock_approve")).toBe(true);
    expect(tools.has("mock_deny")).toBe(true);
  });

  test("all tools have server set to _mock", () => {
    const tools = buildMockToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(MOCK_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildMockToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── MOCK_SERVER_NAME ──

describe("MOCK_SERVER_NAME", () => {
  test("is _mock", () => {
    expect(MOCK_SERVER_NAME).toBe("_mock");
  });
});

// ── MockServer integration (real Worker + MCP handshake) ──

describe("MockServer", () => {
  let server: MockServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  // ── Shared server for read-only integration tests ──
  describe("read-only (shared worker)", () => {
    let sharedServer: MockServer;
    let sharedDb: StateDb;
    let sharedClient: Awaited<ReturnType<MockServer["start"]>>["client"];
    let sharedOpts: ReturnType<typeof testOptions>;
    let initialized = false;

    async function ensureServer(): Promise<void> {
      if (!initialized) {
        sharedOpts = testOptions();
        sharedDb = new StateDb(sharedOpts.DB_PATH);
        sharedServer = new MockServer(sharedDb, undefined, undefined, silentLogger);
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

    test("start() connects and listTools returns mock tools", async () => {
      await ensureServer();
      const { tools } = await sharedClient.listTools();

      expect(tools.length).toBe(9);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "mock_approve",
        "mock_bye",
        "mock_deny",
        "mock_interrupt",
        "mock_prompt",
        "mock_session_list",
        "mock_session_status",
        "mock_transcript",
        "mock_wait",
      ]);
    });

    test("mock_session_list returns empty array initially", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({ name: "mock_session_list", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0].text);

      expect(sessions).toEqual([]);
    });

    test("mock_session_status returns error for unknown session", async () => {
      await ensureServer();
      const result = await sharedClient.callTool({
        name: "mock_session_status",
        arguments: { sessionId: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Unknown session");
    });
  });

  // handleWorkerEvent tests
  test("worker db:upsert event persists session to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "s1", state: "active", model: "mock", cwd: "/tmp" },
    });

    const row = db.getSession("s1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
    expect(row?.model).toBe("mock");
  });

  test("worker db:state event updates session state", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "s2", state: "active" });

    const row = db.getSession("s2");
    expect(row?.state).toBe("active");
  });

  test("worker db:end event marks session as ended", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

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
    server = new MockServer(db, undefined, undefined, silentLogger);

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

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
    server = new MockServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stop-end-1", state: "active" } });

    await server.stop();

    const row1 = db.getSession("stop-end-1");
    expect(row1?.state).toBe("ended");
    expect(row1?.endedAt).not.toBeNull();

    server = undefined;
  });

  test("start() throws if called while worker is already running", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    await server.start();

    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  test("onActivity is called on db:upsert, db:state, and db:cost events", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

    let activityCount = 0;
    server.onActivity = () => {
      activityCount++;
    };

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s1", state: "active" } });
    expect(activityCount).toBe(1);

    handle({ type: "db:state", sessionId: "s1", state: "idle" });
    expect(activityCount).toBe(2);

    handle({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 5 });
    expect(activityCount).toBe(3);

    // db:end and db:disconnected should NOT trigger onActivity
    handle({ type: "db:disconnected", sessionId: "s1", reason: "test" });
    expect(activityCount).toBe(3);

    handle({ type: "db:end", sessionId: "s1" });
    expect(activityCount).toBe(3);
  });

  // ── Session TTL pruning ──

  test("pruneDeadSessions prunes sessions after TTL expires", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new MockServer(db, undefined, undefined, silentLogger);

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
});
