import { afterEach, describe, expect, test } from "bun:test";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { testOptions } from "../../../test/test-options";
import { CLAUDE_SERVER_NAME, ClaudeServer, buildClaudeToolCache } from "./claude-server";
import { StateDb } from "./db/state";

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

  test("handleWorkerCrash marks sessions as disconnected but keeps them active", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    handle({ type: "db:upsert", session: { sessionId: "crash-1", state: "active" } });
    handle({ type: "db:upsert", session: { sessionId: "crash-2", state: "active" } });
    expect(server.hasActiveSessions()).toBe(true);

    // Trigger crash handler directly
    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // Sessions should be marked as disconnected (NOT ended)
    const row1 = db.getSession("crash-1");
    expect(row1?.state).toBe("disconnected");
    expect(row1?.endedAt).toBeNull();

    const row2 = db.getSession("crash-2");
    expect(row2?.state).toBe("disconnected");
    expect(row2?.endedAt).toBeNull();

    // Sessions should still be tracked as active (prevents idle timeout)
    expect(server.hasActiveSessions()).toBe(true);
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

  test("hasActiveSessions stays true after worker crash when sessions had PIDs", async () => {
    using opts = testOptions();
    db = new StateDb(opts.DB_PATH);
    server = new ClaudeServer(db);

    await server.start();

    const handle = (server as unknown as { handleWorkerEvent: (e: unknown) => void }).handleWorkerEvent.bind(server);
    // Use our own PID so it's "alive"
    handle({ type: "db:upsert", session: { sessionId: "crash-alive", pid: process.pid, state: "active" } });

    const crash = (
      server as unknown as { handleWorkerCrash: (reason: string) => Promise<void> }
    ).handleWorkerCrash.bind(server);
    await crash("test crash");

    // Session should still be tracked (prevents idle timeout from firing)
    expect(server.hasActiveSessions()).toBe(true);

    // pruneDeadSessions should NOT remove it (PID is alive)
    server.pruneDeadSessions();
    expect(server.hasActiveSessions()).toBe(true);
  });
});
