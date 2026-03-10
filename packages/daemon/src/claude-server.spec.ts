import { afterEach, describe, expect, test } from "bun:test";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { testOptions } from "../../../test/test-options";
import { CLAUDE_SERVER_NAME, ClaudeServer, buildClaudeToolCache, isWorkerEvent } from "./claude-server";
import { StateDb } from "./db/state";

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
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

    await server.start();

    expect(server.port).toBeGreaterThan(0);
  });

  test("claude_session_list returns empty array initially", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    const { client } = await server.start();
    const result = await client.callTool({ name: "claude_session_list", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const sessions = JSON.parse(content[0].text);

    expect(sessions).toEqual([]);
  });

  test("claude_session_status returns error for unknown session", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    const { client } = await server.start();
    const result = await client.callTool({
      name: "claude_session_status",
      arguments: { sessionId: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Unknown session");
  });

  test("worker db:upsert event persists session to SQLite", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    // Call the private handleWorkerEvent directly to test DB routing
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

  test("worker db:state event updates session state", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

    await server.start();

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() returns true after db:upsert, false after db:end", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-active", state: "connecting" } });

    expect(server.hasActiveSessions()).toBe(true);

    handle({ type: "db:end", sessionId: "s-active" });

    expect(server.hasActiveSessions()).toBe(false);
  });

  test("hasActiveSessions() tracks multiple sessions independently", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

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
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "s-stop", state: "connecting" } });
    expect(server.hasActiveSessions()).toBe(true);

    await server.stop();
    expect(server.hasActiveSessions()).toBe(false);
    server = undefined; // prevent double stop
  });

  test("stop() clears crashTimestamps so stale history does not poison restarts", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    // Simulate 2 crashes to accumulate timestamps
    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("crash 0");
    await crash("crash 1");

    const timestamps = (server as unknown as { crashTimestamps: number[] }).crashTimestamps;
    expect(timestamps.length).toBe(2);

    // Manual stop + restart cycle
    await server.stop();
    expect(timestamps.length).toBe(0);

    // Restart — should have a fresh crash budget
    await server.start();

    // 3 more crashes should all succeed (not poisoned by stale history)
    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };
    const crash2 = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    for (let i = 0; i < 3; i++) {
      await crash2(`post-restart crash ${i}`);
    }
    expect(restartCount).toBe(3);
  });

  test("stop() terminates worker cleanly", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();
    await server.stop();

    expect(server.port).toBeNull();
    server = undefined; // prevent double stop
  });

  // ── Crash recovery ──

  test("handleWorkerCrash ends orphaned sessions after successful restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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

    // After restart, orphaned sessions are ended (can no longer reach new WS port)
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
    server = new ClaudeServer(db);

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

    // Worker should be restarted with a new port
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(originalPort);
    expect(restartedCalled).toBe(true);
  });

  test("handleWorkerCrash emits tools/list_changed notification after restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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

  test("handleWorkerCrash debounces concurrent crashes", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);

    // Fire two crashes concurrently — only one should restart
    await Promise.all([crash("crash A"), crash("crash B")]);

    expect(restartCount).toBe(1);
  });

  test("handleWorkerCrash gives up after too many crashes in window", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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

    // 4th crash should be rate-limited — no restart
    await crash("crash 3");
    expect(restartCount).toBe(3);
    expect(server.port).toBeNull();
  });

  test("worker error event triggers crash detection and survives after first error", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    // Track restarts via the callback
    let restartCount = 0;
    server.onRestarted = () => {
      restartCount++;
    };

    // Access the internal worker to fire a real error event
    const worker = (server as unknown as { worker: Worker | null }).worker;
    expect(worker).not.toBeNull();

    // Fire a real error event on the worker — this goes through addEventListener, not handleWorkerCrash directly
    worker?.dispatchEvent(new ErrorEvent("error", { message: "simulated crash" }));

    // handleWorkerCrash is async; poll for restart completion
    const deadline = Date.now() + 10_000;
    while (restartCount < 1 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(restartCount).toBe(1);

    // Fire a second error event on the NEW worker to verify the listener persists across restarts
    const worker2 = (server as unknown as { worker: Worker | null }).worker;
    expect(worker2).not.toBeNull();
    expect(worker2).not.toBe(worker); // should be a new worker

    worker2?.dispatchEvent(new ErrorEvent("error", { message: "second crash" }));

    const deadline2 = Date.now() + 10_000;
    while (restartCount < 2 && Date.now() < deadline2) {
      await Bun.sleep(50);
    }
    expect(restartCount).toBe(2);
  });

  test("stop() prevents auto-restart on subsequent crash", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

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
    server = new ClaudeServer(db);

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

  test("pruneDeadSessions removes sessions with dead PIDs", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use a PID that definitely doesn't exist
    handle({ type: "db:upsert", session: { sessionId: "dead-1", pid: 999999, state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("dead-1");
    expect(row?.state).toBe("ended");
  });

  test("pruneDeadSessions keeps sessions with live PIDs", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use our own PID — definitely alive
    handle({ type: "db:upsert", session: { sessionId: "alive-1", pid: process.pid, state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(true);
  });

  test("pruneDeadSessions handles sessions without PIDs (no prune)", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Session without PID — should not be pruned (no PID to check)
    handle({ type: "db:upsert", session: { sessionId: "no-pid", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    server.pruneDeadSessions();

    expect(server.hasActiveSessions()).toBe(true);
  });

  // ── onActivity callback ──

  test("onActivity is called on db:upsert, db:state, and db:cost events", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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

  // ── Worker crash + idle timeout interaction ──

  test("orphaned sessions are cleaned up after worker crash+restart", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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
    // reach the new WS server (new port, new worker instance).
    expect(server.hasActiveSessions()).toBe(false);
    const row = db.getSession("crash-alive");
    expect(row?.state).toBe("ended");
  });

  // ── isWorkerEvent routing ──

  test("unknown message types pass through isWorkerEvent filter, not consumed as worker events", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

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

  // ── PID-less session TTL ──

  test("pruneDeadSessions prunes pid-less sessions after TTL expires", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

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
