import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { capturingLogger, silentLogger } from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { testOptions } from "../../../test/test-options";
import {
  CLAUDE_SERVER_NAME,
  ClaudeServer,
  WORKER_EVENT_TYPES,
  buildClaudeToolCache,
  isWorkerEvent,
} from "./claude-server";
import { StateDb } from "./db/state";
import { metrics } from "./metrics";

// ── WORKER_EVENT_TYPES exhaustiveness ──

describe("WORKER_EVENT_TYPES", () => {
  test("covers all WorkerEvent type literals", () => {
    // This list must be updated when new WorkerEvent types are added.
    // The Record<WorkerEvent["type"], true> in claude-server.ts provides
    // compile-time enforcement; this test catches runtime drift.
    const expected: string[] = [
      "ready",
      "db:upsert",
      "db:state",
      "db:cost",
      "db:disconnected",
      "db:end",
      "metrics:inc",
      "metrics:observe",
    ];
    expect(WORKER_EVENT_TYPES.size).toBe(expected.length);
    for (const t of expected) {
      expect(WORKER_EVENT_TYPES.has(t)).toBe(true);
    }
  });
});

// ── isWorkerEvent ──

describe("isWorkerEvent", () => {
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
    expect(isWorkerEvent({ type: "ready", port: 3000 })).toBe(true);
  });

  test("rejects JSON-RPC messages (even though they have no matching type)", () => {
    expect(isWorkerEvent({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe(false);
  });

  test("rejects messages with unknown type values", () => {
    expect(isWorkerEvent({ type: "unknown" })).toBe(false);
    expect(isWorkerEvent({ type: "custom:event" })).toBe(false);
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

// ── buildClaudeToolCache ──

describe("buildClaudeToolCache", () => {
  test("returns all 9 claude tools", () => {
    const tools = buildClaudeToolCache();
    expect(tools.size).toBe(9);
    expect(tools.has("claude_prompt")).toBe(true);
    expect(tools.has("claude_session_list")).toBe(true);
    expect(tools.has("claude_session_status")).toBe(true);
    expect(tools.has("claude_interrupt")).toBe(true);
    expect(tools.has("claude_bye")).toBe(true);
    expect(tools.has("claude_transcript")).toBe(true);
    expect(tools.has("claude_wait")).toBe(true);
    expect(tools.has("claude_approve")).toBe(true);
    expect(tools.has("claude_deny")).toBe(true);
  });

  test("all tools have server set to _claude", () => {
    const tools = buildClaudeToolCache();
    for (const [, tool] of tools) {
      expect(tool.server).toBe(CLAUDE_SERVER_NAME);
    }
  });

  test("all tools have descriptions and input schemas", () => {
    const tools = buildClaudeToolCache();
    for (const [, tool] of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── CLAUDE_SERVER_NAME ──

describe("CLAUDE_SERVER_NAME", () => {
  test("is _claude", () => {
    expect(CLAUDE_SERVER_NAME).toBe("_claude");
  });
});

// ── ClaudeServer integration (real Worker + MCP handshake) ──

describe("ClaudeServer", () => {
  let server: ClaudeServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("start() connects and listTools returns claude tools", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const { tools } = await client.listTools();

    expect(tools.length).toBe(9);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claude_approve",
      "claude_bye",
      "claude_deny",
      "claude_interrupt",
      "claude_prompt",
      "claude_session_list",
      "claude_session_status",
      "claude_transcript",
      "claude_wait",
    ]);
  });

  test("start() reports a WS port", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    expect(server.port).toBeGreaterThan(0);
  });

  test("claude_session_list returns empty array initially", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const result = await client.callTool({ name: "claude_session_list", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const sessions = JSON.parse(content[0].text);

    expect(sessions).toEqual([]);
  });

  test("claude_session_status returns error for unknown session", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "claude_session_status",
      arguments: { sessionId: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown session");
  });

  test("worker db:upsert event persists session to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    // Call the private handleWorkerEvent directly to test DB routing (no start() needed)
    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "s1", pid: 999, state: "active", model: "claude-sonnet-4-6", cwd: "/tmp" },
    });

    const row = db.getSession("s1");
    expect(row).not.toBeNull();
    expect(row?.pid).toBe(999);
    expect(row?.state).toBe("active");
    expect(row?.model).toBe("claude-sonnet-4-6");
  });

  test("worker db:state event updates session state", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });
    handle({ type: "db:state", sessionId: "s2", state: "active" });

    const row = db.getSession("s2");
    expect(row?.state).toBe("active");
  });

  test("worker db:cost event updates cost and tokens", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

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
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

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
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() tracks multiple sessions independently", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s1", state: "connecting" } });
    handle({ type: "db:upsert", session: { sessionId: "s2", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s1" });
    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s2" });
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("stop() clears active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-stop", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();
    expect(server.hasActiveSessions()).toBe(false);
    server = undefined; // prevent double stop
  });

  test("stop() terminates worker cleanly", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();
    await server.stop();

    expect(server.port).toBeNull();
    server = undefined; // prevent double stop
  });

  // ── Crash recovery ──

  test("handleWorkerCrash ends orphaned sessions after successful restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "crash-1", state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "crash-2", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    // Trigger crash handler directly — it restarts the worker internally
    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // After restart, orphaned sessions are ended (can no longer reach new WS server)
    const row1 = db.getSession("crash-1");
    expect(row1?.state).toBe("ended");
    expect(row1?.endedAt).not.toBeNull();

    const row2 = db.getSession("crash-2");
    expect(row2?.state).toBe("ended");
    expect(row2?.endedAt).not.toBeNull();

    // Active sessions cleared after restart cleanup
    expect(server.hasActiveSessions()).toBe(false);
  });

  test("handleWorkerCrash auto-restarts and fires onRestarted", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();
    const originalPort = server.port;

    let restartedCalled = false;
    server.onRestarted = () => {
      restartedCalled = true;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // Worker should be restarted
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(originalPort);
    expect(restartedCalled).toBe(true);
  });

  test("handleWorkerCrash emits tools/list_changed notification after restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    let notificationReceived = false;
    server.onRestarted = (client) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        notificationReceived = true;
      });
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // Poll until the notification arrives (deadline-based, no fixed sleep)
    const deadline = Date.now() + 5000;
    while (!notificationReceived && Date.now() < deadline) {
      await Bun.sleep(50);
    }

    expect(notificationReceived).toBe(true);
  });

  test("handleWorkerCrash queues second crash during restart and retries", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

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

  test("handleWorkerCrash terminates worker and closes client before nulling", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    // Grab references before crash and spy on terminate() and close()
    const oldWorker = (server as unknown as { worker: Worker | null }).worker;
    expect(oldWorker).not.toBeNull();

    let terminateCalled = false;
    const origTerminate = (oldWorker as Worker).terminate.bind(oldWorker);
    (oldWorker as Worker).terminate = () => {
      terminateCalled = true;
      return origTerminate();
    };

    const oldClient = (server as unknown as { client: { close: () => Promise<void> } | null }).client;
    expect(oldClient).not.toBeNull();

    let closeCalled = false;
    const origClose = (oldClient as { close: () => Promise<void> }).close.bind(oldClient);
    (oldClient as { close: () => Promise<void> }).close = async () => {
      closeCalled = true;
      return origClose();
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test cleanup");

    // worker.terminate() and client.close() must have been called
    expect(terminateCalled).toBe(true);
    expect(closeCalled).toBe(true);

    // After restart, old worker handlers should be cleaned up
    expect(oldWorker?.onmessage).toBeNull();
    expect(oldWorker?.onerror).toBeNull();
  });

  test("stop() prevents auto-restart on subsequent crash", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

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

    // Should not restart after explicit stop
    expect(server.port).toBeNull();
    expect(restartedCalled).toBe(false);
    server = undefined; // prevent double stop
  });

  // ── Worker handler cleanup ──

  test("restart cleans up old worker message/error handlers to prevent closure leaks", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    // Grab reference to the old worker before crash
    const oldWorker = (server as unknown as { worker: Worker | null }).worker;
    expect(oldWorker).not.toBeNull();

    // Verify old worker has handlers set
    expect(oldWorker?.onmessage).not.toBeNull();

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash for cleanup");

    // After restart, old worker's onmessage should be nulled (cleaned up)
    expect(oldWorker?.onmessage).toBeNull();

    // New worker should be different and have its own handlers
    const newWorker = (server as unknown as { worker: Worker | null }).worker;
    expect(newWorker).not.toBeNull();
    expect(newWorker).not.toBe(oldWorker);
    expect(newWorker?.onmessage).not.toBeNull();
  });

  test("stop() cleans up worker message/error handlers", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const worker = (server as unknown as { worker: Worker | null }).worker;
    expect(worker).not.toBeNull();
    expect(worker?.onmessage).not.toBeNull();

    await server.stop();

    // After stop, worker handlers should be cleaned up
    expect(worker?.onmessage).toBeNull();
    server = undefined; // prevent double stop
  });

  // ── pruneDeadSessions ──

  test("pruneDeadSessions removes sessions with dead PIDs", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use a PID that definitely doesn't exist
    handle({ type: "db:upsert", session: { sessionId: "dead-1", pid: 999999, state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("dead-1");
    expect(row?.state).toBe("ended");
  });

  test("pruneDeadSessions keeps sessions with live PIDs", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use our own PID — definitely alive
    handle({ type: "db:upsert", session: { sessionId: "alive-1", pid: process.pid, state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(true);
  });

  test("pruneDeadSessions handles sessions without PIDs (no prune)", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Session without PID — should not be pruned (no PID to check)
    handle({ type: "db:upsert", session: { sessionId: "no-pid", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(true);
  });

  // ── onActivity callback ──

  test("onActivity is called on db:upsert, db:state, and db:cost events", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

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

  // ── Worker crash + idle timeout interaction ──

  test("orphaned sessions are cleaned up after worker crash+restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use our own PID so it's "alive" during crash detection
    handle({ type: "db:upsert", session: { sessionId: "crash-alive", pid: process.pid, state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // After successful restart, orphaned sessions are ended — they can no longer
    // reach the new WS server (new worker instance).
    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("crash-alive");
    expect(row?.state).toBe("ended");
  });

  // ── Crash recovery with configuredWsPort (#643) ──

  test("handleWorkerCrash restores sessions when configuredWsPort is set", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    // Use port 0 to let the OS pick, but the configuredWsPort parameter being set
    // is what matters — it signals that sessions can reconnect to the same port.
    server = new ClaudeServer(db, undefined, undefined, silentLogger, 10_000, 0);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "ws-crash-1", pid: process.pid, state: "active" },
    });
    handle({
      type: "db:upsert",
      session: { sessionId: "ws-crash-2", pid: process.pid, state: "idle" },
    });
    expect(server.hasActiveSessions()).toBe(true);

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash with configuredWsPort");

    // Sessions should be RESTORED (not ended) because configuredWsPort is set —
    // the CLI can reconnect to the same WS port.
    expect(server.hasActiveSessions()).toBe(true);

    const row1 = db.getSession("ws-crash-1");
    expect(row1?.state).toBe("disconnected");
    expect(row1?.endedAt).toBeNull();

    const row2 = db.getSession("ws-crash-2");
    expect(row2?.state).toBe("disconnected");
    expect(row2?.endedAt).toBeNull();
  });

  test("handleWorkerCrash without configuredWsPort ends orphaned sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    // No configuredWsPort — sessions can't reconnect to the new random port
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "no-ws-1", pid: process.pid, state: "active" },
    });
    expect(server.hasActiveSessions()).toBe(true);

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash without configuredWsPort");

    // Without configuredWsPort, orphaned sessions should be ended
    const row = db.getSession("no-ws-1");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
    expect(server.hasActiveSessions()).toBe(false);
  });

  // ── isWorkerEvent routing ──

  test("unknown message types pass through isWorkerEvent filter, not consumed as worker events", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();

    // Verify the routing decision: unknown types must NOT match isWorkerEvent
    // so they fall through to the MCP transport handler instead of being consumed
    expect(isWorkerEvent({ type: "unknown:something", data: "test" })).toBe(false);
    expect(isWorkerEvent({ type: "init", daemonId: "d1" })).toBe(false);
    expect(isWorkerEvent({ type: "tools_changed" })).toBe(false);

    // Known worker events must match
    expect(isWorkerEvent({ type: "db:upsert", session: {} })).toBe(true);
    expect(isWorkerEvent({ type: "db:end", sessionId: "s1" })).toBe(true);

    // MCP client should still work correctly after startup
    const { tools } = await client.listTools();
    expect(tools.length).toBe(9);
  });

  // ── Worker cleanup on start() failure (#471, #453, #454) ──

  test("start() terminates worker and nulls state if client.connect() throws", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    // Inject a factory that produces a client whose connect() always throws —
    // avoids polluting the global Client.prototype across test files.
    const fakeClient = {
      connect: async () => {
        throw new Error("simulated connect failure");
      },
      close: async () => {},
    };
    server = new ClaudeServer(db, undefined, () => fakeClient as never, silentLogger);

    await expect(server.start()).rejects.toThrow("simulated connect failure");

    // Worker, transport, client, wsPort should all be cleaned up
    const internals = server as unknown as {
      worker: Worker | null;
      transport: unknown;
      client: unknown;
    };
    expect(internals.worker).toBeNull();
    expect(internals.transport).toBeNull();
    expect(internals.client).toBeNull();
    expect(server.port).toBeNull();
    server = undefined; // already cleaned up
  });

  // ── Crash counter metric (#475) ──

  test("handleWorkerCrash increments mcpd_claude_server_crashes_total", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const before = metrics.counter("mcpd_claude_server_crashes_total").value();

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash for metric");

    expect(metrics.counter("mcpd_claude_server_crashes_total").value()).toBe(before + 1);
  });

  // ── Crash timestamp log on stop (#475) ──

  test("stop() logs cleared crash timestamps count after a crash", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    const { logger, texts } = capturingLogger();
    server = new ClaudeServer(db, undefined, undefined, logger);

    await server.start();

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    await server.stop();
    server = undefined;

    expect(texts.some((t) => t.includes("Cleared") && t.includes("crash timestamp"))).toBe(true);
  });

  test("stop() does not log crash timestamps when none exist", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    const { logger, texts } = capturingLogger();
    server = new ClaudeServer(db, undefined, undefined, logger);

    await server.start();
    await server.stop();
    server = undefined;

    expect(texts.some((t) => t.includes("Cleared") && t.includes("crash timestamp"))).toBe(false);
  });

  // ── Re-entrancy guard (#493) ──

  test("start() throws if called while worker is already running", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    await expect(server.start()).rejects.toThrow("start() called while worker is already running");
  });

  // ── repoRoot filtering (#607) ──

  test("db:upsert with repoRoot persists to SQLite", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "repo-1", state: "active", repoRoot: "/projects/my-repo" },
    });

    const row = db.getSession("repo-1");
    expect(row).not.toBeNull();
    expect(row?.repoRoot).toBe("/projects/my-repo");
  });

  test("db:upsert without repoRoot stores null", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({
      type: "db:upsert",
      session: { sessionId: "repo-2", state: "active" },
    });

    const row = db.getSession("repo-2");
    expect(row).not.toBeNull();
    // repoRoot should be null/undefined when not set
    expect(row?.repoRoot ?? null).toBeNull();
  });

  test("claude_session_list returns empty array with repoRoot filter when no sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "claude_session_list",
      arguments: { repoRoot: "/some/repo" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const sessions = JSON.parse(content[0].text);

    expect(sessions).toEqual([]);
  });

  // ── stop() ends sessions in DB (#495) ──

  test("stop() calls db.endSession() for all active sessions", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "stop-end-1", pid: process.pid, state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "stop-end-2", state: "idle" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();

    // Both sessions should be ended in the DB
    const row1 = db.getSession("stop-end-1");
    expect(row1?.state).toBe("ended");
    expect(row1?.endedAt).not.toBeNull();

    const row2 = db.getSession("stop-end-2");
    expect(row2?.state).toBe("ended");
    expect(row2?.endedAt).not.toBeNull();

    server = undefined; // prevent double stop
  });

  // ── PID-less session TTL ──

  test("pruneDeadSessions prunes pid-less sessions after TTL expires", () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Session without PID
    handle({ type: "db:upsert", session: { sessionId: "no-pid-ttl", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    // Not yet expired — should not be pruned
    server.pruneDeadSessions(Date.now());
    expect(server.hasActiveSessions()).toBe(true);

    // Simulate time past TTL (10+ minutes)
    const future = Date.now() + 11 * 60 * 1000;
    server.pruneDeadSessions(future);

    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("no-pid-ttl");
    expect(row?.state).toBe("ended");
  });
});

// ── connect timeout metric ──

describe("ClaudeServer connect timeout metric", () => {
  let server: ClaudeServer | undefined;
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

    server = new ClaudeServer(db, undefined, () => neverConnect, silentLogger, 50);

    await expect(server.start()).rejects.toThrow("MCP handshake timeout (10s)");
    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(1);
  });

  test("does not increment counter on successful connect", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db, undefined, undefined, silentLogger);

    await server.start();

    expect(metrics.counter("mcpd_connect_timeouts_total").value()).toBe(0);
  });
});

// ── Session persistence across restart ──

describe("session persistence", () => {
  let server: ClaudeServer | undefined;
  let db: StateDb | undefined;

  afterEach(async () => {
    await server?.stop();
    db?.close();
    server = undefined;
    db = undefined;
  });

  test("start() restores active sessions from SQLite", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    // Seed the DB with an active session (simulating a previous daemon's state)
    db.upsertSession({
      sessionId: "persist-1",
      pid: process.pid, // Use current process PID so isProcessAlive returns true
      state: "idle",
      model: "claude-sonnet-4-6",
      cwd: "/test/persist",
    });

    server = new ClaudeServer(db, undefined, undefined, silentLogger);
    await server.start();

    // The server should have restored the session
    expect(server.hasActiveSessions()).toBe(true);

    // Session should be marked as disconnected in DB (waiting for CLI reconnect)
    const row = db.getSession("persist-1");
    expect(row?.state).toBe("disconnected");
  });

  test("start() skips sessions whose processes are dead", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    // Seed with a session whose PID doesn't exist
    db.upsertSession({
      sessionId: "dead-1",
      pid: 999999, // Very unlikely to be a real process
      state: "idle",
      model: "claude-sonnet-4-6",
      cwd: "/test/dead",
    });

    server = new ClaudeServer(db, undefined, undefined, silentLogger);
    await server.start();

    // Dead session should NOT be restored
    expect(server.hasActiveSessions()).toBe(false);

    // Session should be ended in DB
    const row = db.getSession("dead-1");
    expect(row?.state).toBe("ended");
    expect(row?.endedAt).not.toBeNull();
  });

  test("start() restores sessions without PIDs", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    // Session with no PID (e.g., PID wasn't captured before crash)
    db.upsertSession({
      sessionId: "no-pid-1",
      state: "connecting",
      model: undefined,
      cwd: "/test/no-pid",
    });

    server = new ClaudeServer(db, undefined, undefined, silentLogger);
    await server.start();

    // Should be restored (no PID to check, so we can't tell if alive)
    expect(server.hasActiveSessions()).toBe(true);

    const row = db.getSession("no-pid-1");
    expect(row?.state).toBe("disconnected");
  });

  test("start() skips already-ended sessions in DB", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);

    // Insert and then end a session
    db.upsertSession({
      sessionId: "ended-1",
      state: "active",
      cwd: "/test/ended",
    });
    db.endSession("ended-1");

    server = new ClaudeServer(db, undefined, undefined, silentLogger);
    await server.start();

    // Ended sessions should not be restored
    expect(server.hasActiveSessions()).toBe(false);
  });
});
