import { afterEach, describe, expect, mock, test } from "bun:test";
import { ACP_SERVER_NAME, silentLogger } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { testOptions } from "../../../test/test-options";
import { AcpServer, buildAcpToolCache, isAcpWorkerEvent } from "./acp-server";
import { StateDb } from "./db/state";
import { MetricsCollector } from "./metrics";

/** Minimal Worker stub that emits "ready" synchronously via postMessage. */
function mockWorkerFactory() {
  return (_scriptPath: string) => {
    const w = {
      postMessage: mock((_msg: unknown) => {
        queueMicrotask(() => {
          w.onmessage?.({ data: { type: "ready" } } as MessageEvent);
        });
      }),
      terminate: mock(() => {}),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent | Event) => void) | null,
    };
    return w as unknown as Worker;
  };
}

const instantClient = () =>
  ({
    connect: async () => {},
    close: async () => {},
  }) as unknown as Client;

function makeMockServer(db: StateDb) {
  return new AcpServer(db, undefined, instantClient, silentLogger, undefined, undefined, mockWorkerFactory());
}

// ── isAcpWorkerEvent ──

describe("isAcpWorkerEvent (acp)", () => {
  test("matches all known DB event types", () => {
    expect(isAcpWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isAcpWorkerEvent({ type: "db:state", sessionId: "s1", state: "active" })).toBe(true);
    expect(isAcpWorkerEvent({ type: "db:cost", sessionId: "s1", cost: 0, tokens: 0 })).toBe(true);
    expect(isAcpWorkerEvent({ type: "db:disconnected", sessionId: "s1", reason: "x" })).toBe(true);
    expect(isAcpWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);
  });

  test("matches metrics and ready event types", () => {
    expect(isAcpWorkerEvent({ type: "metrics:inc", name: "foo" })).toBe(true);
    expect(isAcpWorkerEvent({ type: "metrics:observe", name: "foo", value: 1 })).toBe(true);
    expect(isAcpWorkerEvent({ type: "ready" })).toBe(true);
  });

  test("rejects JSON-RPC messages", () => {
    expect(isAcpWorkerEvent({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
  });

  test("rejects messages with unknown type values", () => {
    expect(isAcpWorkerEvent({ type: "unknown" })).toBe(false);
    expect(isAcpWorkerEvent({ type: "" })).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(isAcpWorkerEvent(null)).toBe(false);
    expect(isAcpWorkerEvent(undefined)).toBe(false);
    expect(isAcpWorkerEvent("string")).toBe(false);
    expect(isAcpWorkerEvent(42)).toBe(false);
  });

  test("rejects objects without type field", () => {
    expect(isAcpWorkerEvent({})).toBe(false);
    expect(isAcpWorkerEvent({ data: "foo" })).toBe(false);
  });
});

// ── buildAcpToolCache ──

describe("buildAcpToolCache", () => {
  test("returns all 9 acp tools", () => {
    const tools = buildAcpToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("acp_prompt")).toBe(true);
    expect(tools.has("acp_session_list")).toBe(true);
    expect(tools.has("acp_session_status")).toBe(true);
    expect(tools.has("acp_interrupt")).toBe(true);
    expect(tools.has("acp_bye")).toBe(true);
    expect(tools.has("acp_transcript")).toBe(true);
    expect(tools.has("acp_wait")).toBe(true);
    expect(tools.has("acp_approve")).toBe(true);
    expect(tools.has("acp_deny")).toBe(true);
  });

  test("all tools have server set to _acp", () => {
    const tools = buildAcpToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(ACP_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildAcpToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("acp_prompt has agent and customCommand extra properties", () => {
    const tools = buildAcpToolCache();
    const prompt = tools.get("acp_prompt");
    expect(prompt).toBeDefined();
    expect(prompt?.description).toContain("ACP agent");
    const schema = prompt?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.agent).toBeDefined();
    expect(schema.properties?.customCommand).toBeDefined();
    expect(schema.properties?.disallowedTools).toBeDefined();
  });
});

// ── ACP_SERVER_NAME ──

describe("ACP_SERVER_NAME", () => {
  test("is _acp", () => {
    expect(ACP_SERVER_NAME).toBe("_acp");
  });
});

// ── AcpServer descriptor ──

describe("AcpServer.descriptor", () => {
  test("descriptor has correct providerName, serverName, and workerScript", () => {
    using opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    const server = new AcpServer(db, undefined, undefined, silentLogger);
    const desc = server.descriptor;

    expect(desc.providerName).toBe("acp");
    expect(desc.displayName).toBe("ACP");
    expect(desc.serverName).toBe(ACP_SERVER_NAME);
    expect(desc.workerScript).toBe("acp-session-worker.ts");
    db.close();
  });

  test("descriptor has correct metric names", () => {
    using opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    const server = new AcpServer(db, undefined, undefined, silentLogger);
    const { metrics } = server.descriptor;

    expect(metrics.crashLoopStopped).toBe("mcpd_acp_worker_crash_loop_stopped");
    expect(metrics.crashesTotal).toBe("mcpd_acp_worker_crashes_total");
    expect(metrics.activeSessions).toBe("mcpd_acp_active_sessions");
    expect(metrics.sessionsTotal).toBe("mcpd_acp_sessions_total");
    db.close();
  });
});

// ── AcpServer lifecycle and DB event handling ──

describe("AcpServer", () => {
  let server: AcpServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("worker db:upsert event persists session to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "acp-s1", state: "active", cwd: "/tmp" },
    });

    const row = db.getSession("acp-s1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("active");
  });

  test("worker db:state event updates session state", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "acp-s2", state: "active" });

    expect(db.getSession("acp-s2")?.state).toBe("active");
  });

  test("worker db:cost event updates cost and tokens", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-s3", state: "active" } });
    handle({ type: "db:cost", sessionId: "acp-s3", cost: 0.02, tokens: 800 });

    const row = db.getSession("acp-s3");
    expect(row?.totalCost).toBe(0.02);
    expect(row?.totalTokens).toBe(800);
  });

  test("worker db:end event marks session as ended", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-s4", state: "active" } });
    handle({ type: "db:end", sessionId: "acp-s4" });

    const row = db.getSession("acp-s4");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  test("hasActiveSessions() returns false initially", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-active", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "acp-active" });
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-stop", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();
    expect(server.hasActiveSessions()).toBe(false);
    server = undefined;
  });

  test("start() throws if called while worker is already running", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

    await server.start();
    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  test("onActivity is called on db:upsert, db:state, and db:cost events", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new AcpServer(db, undefined, undefined, silentLogger);

    let activityCount = 0;
    server.onActivity = () => {
      activityCount++;
    };

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-act", state: "active" } });
    expect(activityCount).toBe(1);

    handle({ type: "db:state", sessionId: "acp-act", state: "idle" });
    expect(activityCount).toBe(2);

    handle({ type: "db:cost", sessionId: "acp-act", cost: 0.01, tokens: 100 });
    expect(activityCount).toBe(3);

    // db:end and db:disconnected should NOT trigger onActivity
    handle({ type: "db:disconnected", sessionId: "acp-act", reason: "test" });
    expect(activityCount).toBe(3);

    handle({ type: "db:end", sessionId: "acp-act" });
    expect(activityCount).toBe(3);
  });

  // ── Crash recovery ──

  test("handleWorkerCrash auto-restarts and fires onRestarted", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

    await server.start();

    let restartedClient: unknown;
    server.onRestarted = (c) => {
      restartedClient = c;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    expect(restartedClient).not.toBeNull();
  });

  test("handleWorkerCrash ends orphaned sessions after restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-crash-1", state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "acp-crash-2", state: "active" } });

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    expect(db.getSession("acp-crash-1")?.state).toBe("ended");
    expect(db.getSession("acp-crash-2")?.state).toBe("ended");
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("handleWorkerCrash gives up after too many crashes", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

    await server.start();

    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);

    for (let i = 0; i < 3; i++) {
      await crash(`crash ${i}`);
    }
    expect(restartCount).toBe(3);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "acp-exhaust-1", state: "active" } });

    await crash("crash 3");
    expect(restartCount).toBe(3);
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() prevents auto-restart on subsequent crash", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = makeMockServer(db);

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

  test("start() terminates worker and nulls state if client.connect() throws", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    const fakeClient = {
      connect: async () => {
        throw new Error("simulated connect failure");
      },
      close: async () => {},
    };
    server = new AcpServer(
      db,
      undefined,
      () => fakeClient as never,
      silentLogger,
      undefined,
      undefined,
      mockWorkerFactory(),
    );

    await expect(server.start()).rejects.toThrow("simulated connect failure");

    const internals = server as unknown as { worker: Worker | null; transport: unknown; client: unknown };
    expect(internals.worker).toBeNull();
    expect(internals.transport).toBeNull();
    expect(internals.client).toBeNull();
    server = undefined;
  });
});

// ── AcpServer connect timeout metric ──

describe("AcpServer connect timeout metric", () => {
  let server: AcpServer | undefined;
  let db: StateDb | undefined;

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

    const testMetrics = new MetricsCollector();
    server = new AcpServer(db, undefined, () => neverConnect, silentLogger, 50, testMetrics, mockWorkerFactory());

    await expect(server.start()).rejects.toThrow("MCP handshake timeout (0.05s)");
    expect(testMetrics.counter("mcpd_connect_timeouts_total").value()).toBe(1);
  });

  test("does not increment timeout counter when connect resolves instantly", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    const instantConnect = {
      connect: async () => {},
      close: async () => {},
    } as unknown as Client;

    const testMetrics = new MetricsCollector();
    server = new AcpServer(db, undefined, () => instantConnect, silentLogger, 10_000, testMetrics, mockWorkerFactory());

    await server.start();
    expect(testMetrics.counter("mcpd_connect_timeouts_total").value()).toBe(0);
  });
});
