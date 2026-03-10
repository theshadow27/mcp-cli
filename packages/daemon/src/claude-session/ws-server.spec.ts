import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serialize } from "./ndjson";
import type { SessionEvent } from "./session-state";
import type { SpawnFn, WaitResult } from "./ws-server";
import { ClaudeWsServer, WaitTimeoutError, readJsonlTranscript, resolveJsonlPath, summarizeInput } from "./ws-server";

// ── Mock spawn ──

function mockSpawn(): {
  spawn: SpawnFn;
  exitResolve: (code: number) => void;
  killed: boolean;
  lastCmd: string[];
} {
  let exitResolve: (code: number) => void = () => {};
  const state = {
    spawn: ((cmd: string[]) => {
      state.lastCmd = cmd;
      return {
        pid: 12345,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          state.killed = true;
          // Simulate immediate process exit on kill
          exitResolve(143);
        },
      };
    }) as SpawnFn,
    exitResolve: (code: number) => exitResolve(code),
    killed: false,
    lastCmd: [] as string[],
  };
  return state;
}

// ── Mock Claude CLI WebSocket client ──

function connectMockClaude(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/session/${sessionId}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Failed to connect"));
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(String(event.data));
  });
}

// ── Poll helper ──

// Shared poll helper — throws on timeout for visible test failures
import { pollUntil } from "../../../../test/harness";

// ── Helpers ──

function systemInitMessage(sessionId: string, model = "claude-sonnet-4-6"): string {
  return serialize({
    type: "system",
    subtype: "init",
    cwd: "/test",
    session_id: sessionId,
    tools: ["Read", "Write"],
    mcp_servers: [],
    model,
    permissionMode: "default",
    apiKeySource: "test",
    claude_code_version: "2.1.70",
    uuid: "test-uuid",
  });
}

function assistantMessage(sessionId: string): string {
  return serialize({
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
    uuid: "test-uuid",
    session_id: sessionId,
  });
}

function resultMessage(sessionId: string): string {
  return serialize({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done!",
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    uuid: "test-uuid",
    session_id: sessionId,
  });
}

function canUseToolMessage(requestId: string): string {
  return serialize({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "echo hello" },
      tool_use_id: "tool-1",
    },
  });
}

// ── Tests ──

describe("ClaudeWsServer", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("start() creates server and returns port", () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn });
    const port = server.start();
    expect(port).toBeGreaterThan(0);
  });

  test("prepareSession + spawnClaude starts claude process with correct args", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      allowedTools: ["Read", "Glob"],
      worktree: "my-tree",
    });
    const pid = server.spawnClaude("test-session");

    expect(pid).toBe(12345);
    expect(ms.lastCmd).toContain("claude");
    expect(ms.lastCmd).toContain("--sdk-url");
    expect(ms.lastCmd).toContain(`ws://localhost:${port}/session/test-session`);
    expect(ms.lastCmd).toContain("--allowedTools");
    expect(ms.lastCmd).toContain("Read");
    expect(ms.lastCmd).toContain("Glob");
    expect(ms.lastCmd).toContain("--worktree");
    expect(ms.lastCmd).toContain("my-tree");
  });

  test("spawnClaude passes --model flag when model is set in config", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("model-session", {
      prompt: "Hello",
      model: "claude-sonnet-4-6",
    });
    server.spawnClaude("model-session");

    expect(ms.lastCmd).toContain("--model");
    expect(ms.lastCmd).toContain("claude-sonnet-4-6");
  });

  test("spawnClaude omits --model flag when model is not set", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("no-model-session", {
      prompt: "Hello",
    });
    server.spawnClaude("no-model-session");

    expect(ms.lastCmd).not.toContain("--model");
  });

  test("WS connect sends user message immediately on open", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello Claude" });
    server.spawnClaude("test-session");

    // Connect as mock Claude CLI
    const ws = await connectMockClaude(port, "test-session");
    try {
      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Hello Claude");
      expect(parsed.session_id).toBe("test-session");
    } finally {
      ws.close();
    }
  });

  test("system/init triggers session:init event", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      // Read initial user message
      await waitForMessage(ws);

      // Send system/init and poll until the event is emitted
      ws.send(systemInitMessage("test-session"));
      await pollUntil(() => events.some((e) => e.type === "session:init"));

      const initEvent = events.find((e) => e.type === "session:init");
      expect(initEvent).toBeDefined();
      if (initEvent?.type === "session:init") {
        expect(initEvent.model).toBe("claude-sonnet-4-6");
        expect(initEvent.cwd).toBe("/test");
      }
    } finally {
      ws.close();
    }
  });

  test("result message resolves waitForResult", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Start waiting for result
      const resultPromise = server.waitForResult("test-session", 5000);

      // Send system/init + assistant + result — WS ordering is guaranteed,
      // so no intermediate sleeps needed; resultPromise awaits completion.
      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.result).toBe("Done!");
      expect(result.cost).toBe(0.01);
    } finally {
      ws.close();
    }
  });

  test("can_use_tool with auto router is auto-approved", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "auto",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // initial user message

      // Set up message listener before sending can_use_tool
      ws.send(systemInitMessage("test-session"));
      const responsePromise = waitForMessage(ws);
      ws.send(canUseToolMessage("req-1"));

      const response = await responsePromise;
      const parsed = JSON.parse(response.trim());
      expect(parsed.type).toBe("control_response");
      expect(parsed.response.subtype).toBe("success");
      expect(parsed.response.response.behavior).toBe("allow");
    } finally {
      ws.close();
    }
  });

  test("can_use_tool with rules router denies unmatched tool", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "rules",
      permissionRules: [{ tool: "Read", action: "allow" }],
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      const responsePromise = waitForMessage(ws);
      ws.send(canUseToolMessage("req-1")); // Bash tool — not in rules

      const response = await responsePromise;
      const parsed = JSON.parse(response.trim());
      expect(parsed.type).toBe("control_response");
      expect(parsed.response.response.behavior).toBe("deny");
    } finally {
      ws.close();
    }
  });

  test("listSessions returns session info", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.prepareSession("s2", { prompt: "World" });

    const sessions = server.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  test("getStatus returns detailed session info", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("s1", { prompt: "Hello", worktree: "my-tree" });
    server.spawnClaude("s1");

    const status = server.getStatus("s1");
    expect(status.sessionId).toBe("s1");
    expect(status.worktree).toBe("my-tree");
    expect(status.pid).toBe(12345);
    expect(status.state).toBe("connecting");
  });

  test("transcript stores messages up to limit", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      // Poll until transcript has both the outbound user msg and inbound system/init
      await pollUntil(() => (server?.getTranscript("test-session")?.length ?? 0) >= 2);

      const transcript = server.getTranscript("test-session");
      expect(transcript.length).toBeGreaterThanOrEqual(2);
      expect(transcript[0].direction).toBe("outbound");
      expect(transcript[0].message.type).toBe("user");
      expect(transcript[1].direction).toBe("inbound");
      expect(transcript[1].message.type).toBe("system");
    } finally {
      ws.close();
    }
  });

  test("getTranscript with limit returns last N entries", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      // Send both messages and poll until all are recorded in the transcript
      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      // outbound user + inbound system/init + inbound assistant = 3 entries
      await pollUntil(() => (server?.getTranscript("test-session")?.length ?? 0) >= 3);

      const last1 = server.getTranscript("test-session", 1);
      expect(last1).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  test("waitForResult rejects on timeout", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    await expect(server.waitForResult("test-session", 100)).rejects.toThrow("Timeout");
  });

  test("unknown session path returns 404", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    const res = await fetch(`http://localhost:${port}/session/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("invalid path returns 404", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    const res = await fetch(`http://localhost:${port}/invalid`);
    expect(res.status).toBe(404);
  });

  test("sendPrompt on existing session sends user message", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // initial prompt

      // Send init and result to move session to idle state
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));
      // Poll until session is idle before calling sendPrompt
      await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "idle"));

      // Now send follow-up
      const followUpPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Follow up question");

      const msg = await followUpPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Follow up question");
    } finally {
      ws.close();
    }
  });

  test("process exit marks session as disconnected but does not terminate", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    // Simulate process exit and poll until the state machine reflects it
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    // Session should still exist (not terminated) but be disconnected
    const sessions = server.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].state).toBe("disconnected");
    expect(sessions[0].spawnAlive).toBe(false);
  });

  test("WS close marks session as disconnected and rejects result waiters", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));

    // Start waiting for result, then close WS — resultPromise rejects on disconnect
    const resultPromise = server.waitForResult("test-session", 5000).catch((e: unknown) => e);
    ws.close();

    // Result waiter should be rejected once disconnect is processed
    const err = await resultPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("WebSocket disconnected");

    // Session should be disconnected but still exist
    const sessions = server.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].state).toBe("disconnected");

    // Should have emitted session:disconnected event
    const disconnectEvent = events.find((e) => e.type === "session:disconnected");
    expect(disconnectEvent).toBeDefined();
  });

  test("process exit while WS still open marks session as disconnected", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Spawn exits while WS is still connected; poll until state reflects it
      ms.exitResolve(0);
      await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

      const sessions = server.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].state).toBe("disconnected");
      expect(sessions[0].spawnAlive).toBe(false);
      expect(sessions[0].wsConnected).toBe(true);

      const disconnectEvent = events.find((e) => e.type === "session:disconnected");
      expect(disconnectEvent).toBeDefined();
    } finally {
      ws.close();
    }
  });

  test("WS close then process exit fires disconnect event only once", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);

    // WS closes first — poll until disconnect event is recorded
    ws.close();
    await pollUntil(() => events.some((e) => e.type === "session:disconnected"));

    // Process exits — poll until spawn is marked dead
    ms.exitResolve(0);
    await pollUntil(() => !server?.listSessions()[0]?.spawnAlive);

    // Only one disconnect event (idempotent)
    const disconnectEvents = events.filter((e) => e.type === "session:disconnected");
    expect(disconnectEvents.length).toBe(1);
  });

  test("sendPrompt on disconnected session throws", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Disconnect via process exit
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    expect(() => server?.sendPrompt("test-session", "follow up")).toThrow("Cannot send prompt to disconnected session");
  });

  test("interrupt on disconnected session throws", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    expect(() => server?.interrupt("test-session")).toThrow("Cannot interrupt disconnected session");
  });

  test("waitForResult on already-disconnected session rejects immediately", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    await expect(server.waitForResult("test-session", 5000)).rejects.toThrow("Session is disconnected");
  });

  test("process exit rejects pending result waiters", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Register a result waiter BEFORE process exits
    const resultPromise = server.waitForResult("test-session", 5000).catch((e: unknown) => e);

    // Process exits — waiter should be rejected
    ms.exitResolve(0);

    const err = await resultPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Process exited");
  });

  test("process exit resolves pending event waiters with disconnect event", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Register an event waiter BEFORE process exits
    const eventPromise = server.waitForEvent("test-session", 5000);

    // Process exits — event waiter should resolve with a session event
    ms.exitResolve(0);

    const event = await eventPromise;
    expect(event.sessionId).toBe("test-session");
  });

  test("waitForEvent on already-disconnected session rejects immediately", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    await expect(server.waitForEvent("test-session", 5000)).rejects.toThrow("Session is disconnected");
  });

  test("bye on disconnected session cleans up properly", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello", worktree: "my-tree" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    const result = await server.bye("test-session");
    expect(result).toEqual({ worktree: "my-tree", cwd: null });
    expect(server.sessionCount).toBe(0);
  });

  test("WS reconnect after disconnect transitions back to connecting", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Connect, then disconnect
    const ws1 = await connectMockClaude(port, "test-session");
    await waitForMessage(ws1);
    ws1.close();
    await pollUntil(() => server?.listSessions()[0]?.state === "disconnected");

    expect(server.listSessions()[0].state).toBe("disconnected");

    // Reconnect
    const ws2 = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws2);

      // Should transition back from disconnected
      const sessions = server.listSessions();
      expect(sessions[0].wsConnected).toBe(true);
      // State should be connecting (or init/active after receiving messages)
      expect(sessions[0].state).not.toBe("disconnected");
    } finally {
      ws2.close();
    }
  });

  test("terminateSession sets spawnAlive to false", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // spawnAlive should be true after spawn
    expect(server.listSessions()[0].spawnAlive).toBe(true);

    // bye calls terminateSession
    await server.bye("test-session");
    // Session is removed, so we just verify it didn't throw
    expect(server.sessionCount).toBe(0);
  });

  test("killAndAwaitProc escalates to SIGKILL when SIGTERM times out", async () => {
    const killSignals: (number | undefined)[] = [];
    let exitResolve: (code: number) => void = () => {};
    const stubbornSpawn: SpawnFn = () => ({
      pid: 99999,
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: (signal?: number) => {
        killSignals.push(signal);
        if (signal === 9) exitResolve(137); // SIGKILL exits immediately
        // SIGTERM is ignored — stubborn process
      },
    });

    server = new ClaudeWsServer({ spawn: stubbornSpawn, killTimeoutMs: 50 });
    server.start();
    server.prepareSession("stubborn", { prompt: "Hello" });
    server.spawnClaude("stubborn");

    await server.bye("stubborn");

    // SIGTERM was sent first (undefined = default signal), then SIGKILL after timeout
    expect(killSignals).toContain(9);
    expect(server.sessionCount).toBe(0);
  });

  test("clearSession skips concurrent clear (reentrancy guard)", async () => {
    let exitResolve: (code: number) => void = () => {};
    let spawnCount = 0;
    const slowSpawn: SpawnFn = () => {
      spawnCount++;
      return {
        pid: spawnCount * 1000,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          exitResolve(143);
        },
      };
    };

    server = new ClaudeWsServer({ spawn: slowSpawn });
    server.start();
    server.prepareSession("double-clear", { prompt: "Hello" });
    server.spawnClaude("double-clear"); // spawnCount = 1
    const spawnAfterSetup = spawnCount;

    // Fire two concurrent clears — second should be a no-op
    const p1 = server.clearSession("double-clear");
    const p2 = server.clearSession("double-clear");
    await Promise.all([p1, p2]);

    // Only one respawn should have happened (spawnAfterSetup + 1)
    expect(spawnCount).toBe(spawnAfterSetup + 1);
    expect(server.sessionCount).toBe(1);
  });

  test("respondToPermission sends control_response to WS", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    // Use delegate strategy so auto-router doesn't handle can_use_tool
    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "delegate",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // initial user message

      // Send init then canUseTool; poll until the permission is pending
      ws.send(systemInitMessage("test-session"));
      ws.send(canUseToolMessage("req-perm-1"));
      await pollUntil(() => server?.getStatus("test-session").pendingPermissionIds.includes("req-perm-1"));

      // Manually respond via respondToPermission
      const responsePromise = waitForMessage(ws);
      server.respondToPermission("test-session", "req-perm-1", true);

      const response = await responsePromise;
      const parsed = JSON.parse(response.trim());
      expect(parsed.type).toBe("control_response");
      expect(parsed.response.subtype).toBe("success");
      expect(parsed.response.response.behavior).toBe("allow");
    } finally {
      ws.close();
    }
  });

  test("interrupt sends sigint to session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));

      // Interrupt the session
      server.interrupt("test-session");

      // Should have sent a control message
      const status = server.getStatus("test-session");
      expect(status).toBeDefined();
    } finally {
      ws.close();
    }
  });

  test("waitForEvent resolves on session:result", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Start waiting for event, then send messages — WS ordering is guaranteed
      const eventPromise = server.waitForEvent("test-session", 5000);

      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const event = await eventPromise;
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:result");
      expect(event.cost).toBe(0.01);
      expect(event.result).toBe("Done!");
      // session snapshot should be present with same fields as listSessions()
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(event.session?.state).toBe("idle");
      expect(event.session?.model).toBe("claude-sonnet-4-6");
      expect(event.session?.cwd).toBe("/test");
      expect(event.session?.cost).toBe(0.01);
      expect(typeof event.session?.wsConnected).toBe("boolean");
      expect(typeof event.session?.spawnAlive).toBe("boolean");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent with null sessionId resolves on any session event", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Wait for any session event
      const eventPromise = server.waitForEvent(null, 5000);

      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const event = await eventPromise;
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:result");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent resolves on permission_request (delegate mode)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "delegate",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("test-session"));
      const eventPromise = server.waitForEvent("test-session", 5000);
      ws.send(canUseToolMessage("req-wait-1"));

      const event = await eventPromise;
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:permission_request");
      expect(event.requestId).toBe("req-wait-1");
      expect(event.toolName).toBe("Bash");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent rejects on timeout", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const err = await server.waitForEvent("test-session", 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect((err as Error).message).toContain("Timeout");
  });

  test("waitForEvent resolves immediately when session is already idle", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // consume initial user message

      // Drive session to idle state
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));
      await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "idle"));

      // waitForEvent should resolve immediately — session is already idle
      const event = await server.waitForEvent("test-session", 1000);
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:result");
      expect(event.cost).toBe(0.01);
      expect(event.numTurns).toBe(1);
      // immediate events also include session snapshot
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(event.session?.state).toBe("idle");
      expect(event.session?.cwd).toBe("/test");
      expect(event.session?.model).toBe("claude-sonnet-4-6");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent resolves immediately when any session is idle (null filter)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.spawnClaude("s1");

    const ws = await connectMockClaude(port, "s1");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("s1"));
      ws.send(resultMessage("s1"));
      await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "s1" && s.state === "idle"));

      // null sessionId — should find idle s1 immediately
      const event = await server.waitForEvent(null, 1000);
      expect(event.sessionId).toBe("s1");
      expect(event.event).toBe("session:result");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent resolves immediately when session has pending permission", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "delegate",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("test-session"));
      ws.send(canUseToolMessage("req-perm-1"));
      await pollUntil(() =>
        server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "waiting_permission"),
      );

      // waitForEvent should resolve immediately with the pending permission
      const event = await server.waitForEvent("test-session", 1000);
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:permission_request");
      expect(event.requestId).toBe("req-perm-1");
      expect(event.toolName).toBe("Bash");
      // session snapshot included for permission events too
      expect(event.session).toBeDefined();
      expect(event.session?.state).toBe("waiting_permission");
      expect(event.session?.pendingPermissions).toBe(1);
    } finally {
      ws.close();
    }
  });

  test("waitForEvent rejects for unknown session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    await expect(server.waitForEvent("nonexistent", 100)).rejects.toThrow("Unknown session");
  });

  test("waitForEvent rejects with no active sessions", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    await expect(server.waitForEvent(null, 100)).rejects.toThrow("No active sessions");
  });

  test("waitForEvent rejects when session terminates", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const eventPromise = server.waitForEvent("test-session", 5000);

    // End the session
    void server.bye("test-session");

    await expect(eventPromise).rejects.toThrow("Session ended by user");
  });

  test("bye returns worktree info", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("wt-session", { prompt: "Hello", worktree: "claude-test1", cwd: "/repo" });
    server.spawnClaude("wt-session");

    const result = await server.bye("wt-session");
    expect(result).toEqual({ worktree: "claude-test1", cwd: "/repo" });
  });

  test("bye returns null worktree for non-worktree session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("plain-session", { prompt: "Hello" });
    server.spawnClaude("plain-session");

    const result = await server.bye("plain-session");
    expect(result).toEqual({ worktree: null, cwd: null });
  });

  test("sessionCount tracks active sessions", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    expect(server.sessionCount).toBe(0);

    server.prepareSession("s1", { prompt: "Hello" });
    expect(server.sessionCount).toBe(1);

    server.prepareSession("s2", { prompt: "World" });
    expect(server.sessionCount).toBe(2);

    await server.bye("s1");
    expect(server.sessionCount).toBe(1);

    await server.bye("s2");
    expect(server.sessionCount).toBe(0);
  });

  test("stop() cleans up all sessions", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.prepareSession("s2", { prompt: "World" });
    server.spawnClaude("s1");
    server.spawnClaude("s2");

    server.stop();
    server = undefined; // prevent double stop in afterEach

    expect(ms.killed).toBe(true);
  });

  test("listSessions includes pendingPermissionDetails", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "delegate",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      // Send both and poll until the permission appears
      ws.send(systemInitMessage("test-session"));
      ws.send(canUseToolMessage("req-detail-1"));
      await pollUntil(() => server?.listSessions().some((s) => s.pendingPermissions === 1));

      const sessions = server.listSessions();
      const session = sessions.find((s) => s.sessionId === "test-session");
      expect(session).toBeDefined();
      expect(session?.pendingPermissions).toBe(1);
      expect(session?.pendingPermissionDetails).toHaveLength(1);
      expect(session?.pendingPermissionDetails[0].requestId).toBe("req-detail-1");
      expect(session?.pendingPermissionDetails[0].toolName).toBe("Bash");
      expect(session?.pendingPermissionDetails[0].inputSummary).toContain("command=");
    } finally {
      ws.close();
    }
  });

  test("pendingPermissionDetails clears after respondToPermission", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", {
      prompt: "Hello",
      permissionStrategy: "delegate",
    });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      // Send init + canUseTool and poll until permission is pending
      ws.send(systemInitMessage("test-session"));
      ws.send(canUseToolMessage("req-clear-1"));
      await pollUntil(() => server?.listSessions().some((s) => s.pendingPermissions === 1));

      // respondToPermission is synchronous — permission is cleared immediately
      server.respondToPermission("test-session", "req-clear-1", true);

      const sessions = server.listSessions();
      const session = sessions.find((s) => s.sessionId === "test-session");
      expect(session?.pendingPermissions).toBe(0);
      expect(session?.pendingPermissionDetails).toHaveLength(0);
    } finally {
      ws.close();
    }
  });
  // ── Sequence cursors ──

  test("currentSeq starts at 0", () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn });
    server.start();
    expect(server.currentSeq).toBe(0);
  });

  test("events increment currentSeq and include seq in event", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      const eventPromise = server.waitForEvent("test-session", 5000);

      // WS ordering is guaranteed — eventPromise will wait for result
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const event = await eventPromise;
      expect(event.seq).toBeGreaterThan(0);
      expect(server.currentSeq).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince returns immediately when buffered events exist", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Send messages and wait for them to be buffered (waitForEventsSince will return them)
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));

      // Events have already fired — waitForEventsSince with afterSeq=0 should return immediately
      const result: WaitResult = await server.waitForEventsSince("test-session", 0, 5000);
      expect(result.seq).toBeGreaterThan(0);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].event).toBe("session:result");
      expect(result.events[0].seq).toBeGreaterThan(0);
      // buffered events carry session snapshot
      expect(result.events[0].session).toBeDefined();
      expect(result.events[0].session?.sessionId).toBe("test-session");
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince blocks when no events past cursor", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Send first result and poll until currentSeq advances
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));
      await pollUntil(() => (server?.currentSeq ?? 0) > 0);

      const currentSeq = server.currentSeq;

      // Wait with cursor at current — should block until new event
      const resultPromise = server.waitForEventsSince(null, currentSeq, 5000);

      // Send another result to trigger a new event — no sleep needed; resultPromise awaits it
      ws.send(resultMessage("test-session"));

      const result: WaitResult = await resultPromise;
      expect(result.seq).toBeGreaterThan(currentSeq);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe("session:result");
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince returns empty events on timeout (no error)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // No events will fire — should timeout and return empty
    const result: WaitResult = await server.waitForEventsSince("test-session", 0, 100);
    expect(result.events).toHaveLength(0);
    expect(result.seq).toBe(0); // No events ever fired
  });

  test("waitForEventsSince filters by sessionId from buffer", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    // Create two sessions sequentially (mockSpawn reuses PID, but that's fine)
    server.prepareSession("s1", { prompt: "Hello" });
    server.spawnClaude("s1");

    const ws1 = await connectMockClaude(port, "s1");
    try {
      await waitForMessage(ws1);
      // Send messages and poll until currentSeq advances (result buffered)
      ws1.send(systemInitMessage("s1"));
      ws1.send(resultMessage("s1"));
      await pollUntil(() => (server?.currentSeq ?? 0) > 0);

      const seqAfterS1 = server.currentSeq;
      expect(seqAfterS1).toBeGreaterThan(0);

      // All buffered events should be for s1
      const result: WaitResult = await server.waitForEventsSince("s1", 0, 5000);
      expect(result.events.length).toBeGreaterThan(0);
      for (const event of result.events) {
        expect(event.sessionId).toBe("s1");
      }

      // Requesting events for a different prepared session should find none in buffer
      server.prepareSession("s2", { prompt: "World" });
      server.spawnClaude("s2");
      const result2: WaitResult = await server.waitForEventsSince("s2", 0, 100);
      // s2 hasn't emitted events yet — should timeout with empty
      expect(result2.events).toHaveLength(0);
    } finally {
      ws1.close();
    }
  });

  test("waitForEventsSince with null sessionId returns all session events", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.spawnClaude("s1");

    const ws = await connectMockClaude(port, "s1");
    try {
      await waitForMessage(ws);

      // WS ordering + waitForEventsSince timeout handles waiting
      ws.send(systemInitMessage("s1"));
      ws.send(resultMessage("s1"));

      const result: WaitResult = await server.waitForEventsSince(null, 0, 5000);
      expect(result.events.length).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince rejects for unknown session", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn });
    server.start();

    await expect(server.waitForEventsSince("nonexistent", 0, 100)).rejects.toThrow("Unknown session");
  });

  test("waitForEventsSince rejects with no active sessions", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn });
    server.start();

    await expect(server.waitForEventsSince(null, 0, 100)).rejects.toThrow("No active sessions");
  });

  // ── session snapshot field on cleared/model_changed/disconnected events ──

  test("waitForEvent session:cleared event includes session snapshot with snapshotTs", async () => {
    const spawnCalls: string[][] = [];
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        pid: 12345 + spawnCalls.length,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          exitResolve(143);
        },
      };
    };

    server = new ClaudeWsServer({ spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    // Connect and send init but NOT result, so session stays in active/init state (not idle)
    // This prevents findImmediateEvent from short-circuiting with session:result
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(20);

    const before = Date.now();
    // waitForEvent blocks — session is not idle
    const eventPromise = server.waitForEvent("test-session", 5000);
    server.sendPrompt("test-session", "/clear");

    const event = await eventPromise;
    expect(event.event).toBe("session:cleared");
    expect(event.session).toBeDefined();
    expect(event.session?.sessionId).toBe("test-session");
    expect(typeof event.session?.snapshotTs).toBe("number");
    expect(event.session!.snapshotTs).toBeGreaterThanOrEqual(before);
    ws.close();
  });

  test("waitForEvent session:model_changed event includes session snapshot with snapshotTs", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      const before = Date.now();
      const eventPromise = server.waitForEvent("test-session", 5000);
      server.sendPrompt("test-session", "/model claude-opus-4-6");

      const event = await eventPromise;
      expect(event.event).toBe("session:model_changed");
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(typeof event.session?.snapshotTs).toBe("number");
      expect(event.session!.snapshotTs).toBeGreaterThanOrEqual(before);
    } finally {
      ws.close();
    }
  });

  test("waitForEvent session:disconnected event includes session snapshot with snapshotTs", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      const before = Date.now();
      const eventPromise = server.waitForEvent("test-session", 5000);
      // Trigger process exit — this routes through handleSessionEvent which calls resolveEventWaiters
      ms.exitResolve(0);

      const event = await eventPromise;
      expect(event.event).toBe("session:disconnected");
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(typeof event.session?.snapshotTs).toBe("number");
      expect(event.session!.snapshotTs).toBeGreaterThanOrEqual(before);
    } finally {
      ws.close();
    }
  });

  // ── /clear and /model interception ──

  test("sendPrompt with /clear kills process and respawns", async () => {
    const spawnCalls: string[][] = [];
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        pid: 12345 + spawnCalls.length,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          exitResolve(143);
        },
      };
    };

    server = new ClaudeWsServer({ spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws); // initial prompt
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(20);
    ws.send(resultMessage("test-session"));
    await Bun.sleep(20);

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    // Send /clear — should kill+respawn
    server.sendPrompt("test-session", "/clear");
    await Bun.sleep(50);

    // Should have spawned a second time
    expect(spawnCalls.length).toBe(2);

    // Should have emitted session:cleared event
    const clearedEvent = events.find((e) => e.type === "session:cleared");
    expect(clearedEvent).toBeDefined();

    // Session should still exist in connecting state
    const sessions = server.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].state).toBe("connecting");

    // New claude should be able to connect
    const ws2 = await connectMockClaude(port, "test-session");
    try {
      const msg = await waitForMessage(ws2);
      const parsed = JSON.parse(msg.trim());
      // Prompt should be empty after clear
      expect(parsed.message.content).toBe("");
    } finally {
      ws2.close();
    }
    ws.close();
  });

  test("sendPrompt with /model sends set_model control request", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // initial prompt
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      const events: SessionEvent[] = [];
      server.onSessionEvent = (_id, event) => events.push(event);

      // Send /model command
      const msgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "/model claude-opus-4-6");

      const msg = await msgPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("set_model");
      expect(parsed.request.model).toBe("claude-opus-4-6");

      // Should have emitted session:model_changed event
      const modelEvent = events.find((e) => e.type === "session:model_changed");
      expect(modelEvent).toBeDefined();
      if (modelEvent?.type === "session:model_changed") {
        expect(modelEvent.model).toBe("claude-opus-4-6");
      }

      // State should track new model
      const status = server.getStatus("test-session");
      expect(status.model).toBe("claude-opus-4-6");
    } finally {
      ws.close();
    }
  });

  test("sendPrompt with regular message is not intercepted", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(20);

      // Regular message should be sent as user message
      const msgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Do something");

      const msg = await msgPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Do something");
    } finally {
      ws.close();
    }
  });

  test("clearSession preserves cumulative cost/tokens", async () => {
    const spawnCalls: string[][] = [];
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (cmd: string[]) => {
      spawnCalls.push(cmd);
      return {
        pid: 12345 + spawnCalls.length,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          exitResolve(143);
        },
      };
    };

    server = new ClaudeWsServer({ spawn });
    const port = server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(20);
    ws.send(assistantMessage("test-session"));
    await Bun.sleep(20);
    ws.send(resultMessage("test-session"));
    await Bun.sleep(20);

    // Verify cost accumulated
    const statusBefore = server.getStatus("test-session");
    expect(statusBefore.cost).toBeGreaterThan(0);
    const costBefore = statusBefore.cost;

    // Clear session and await completion
    await server.clearSession("test-session");

    // Cost should be preserved
    const statusAfter = server.getStatus("test-session");
    expect(statusAfter.cost).toBe(costBefore);
    expect(statusAfter.state).toBe("connecting");

    ws.close();
  });

  test("WebSocket disconnect runs full cleanup: state, waiters, and keep-alive timer", async () => {
    const spawnState = mockSpawn();
    const events: SessionEvent[] = [];
    const server = new ClaudeWsServer({ spawn: spawnState.spawn });
    server.onSessionEvent = (_sid, event) => events.push(event);
    const port = server.start();

    server.prepareSession("test-session", { prompt: "hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws); // consume initial user message

    // Drive session to idle state so we can queue a result waiter and then follow-up
    ws.send(systemInitMessage("test-session"));
    ws.send(resultMessage("test-session"));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

    // Send a follow-up prompt to move back to active, then set up result waiter
    server.sendPrompt("test-session", "follow up");
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    const resultPromise = server.waitForResult("test-session", 10_000);

    // Abrupt client disconnect — simulates network issue or send failure
    ws.close();

    // Result waiter should be rejected with disconnect error
    await expect(resultPromise).rejects.toThrow("WebSocket disconnected");

    // Session should transition to disconnected
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));
    expect(server.sessionCount).toBe(1);
    expect(server.getStatus("test-session").state).toBe("disconnected");
    expect(server.getStatus("test-session").wsConnected).toBe(false);

    // Should have emitted session:disconnected event
    const disconnectEvent = events.find((e) => e.type === "session:disconnected");
    expect(disconnectEvent).toBeDefined();

    // Resolve spawn exit so stop() doesn't hang
    spawnState.exitResolve(0);
    await server.stop();
  });
});

// ── summarizeInput ──

describe("summarizeInput", () => {
  test("returns key=value for string input", () => {
    expect(summarizeInput({ command: "echo hello" })).toBe("command=echo hello");
  });

  test("returns empty string for empty input", () => {
    expect(summarizeInput({})).toBe("");
  });

  test("truncates long values to 80 chars", () => {
    const longValue = "x".repeat(100);
    const result = summarizeInput({ command: longValue });
    expect(result.length).toBe(80);
    expect(result.endsWith("...")).toBe(true);
  });

  test("JSON-stringifies non-string values", () => {
    expect(summarizeInput({ count: 42 })).toBe("count=42");
  });
});

// ── JSONL fallback tests ──

describe("resolveJsonlPath", () => {
  test("encodes cwd with dashes and appends session ID", () => {
    const path = resolveJsonlPath("/Users/alice/code", "abc-123");
    expect(path).toBe(join(homedir(), ".claude/projects/-Users-alice-code/abc-123.jsonl"));
  });
});

describe("readJsonlTranscript", () => {
  const testDir = join(homedir(), ".claude", "projects", "-tmp-jsonl-test");
  const sessionId = "test-session-id";
  const filePath = join(testDir, `${sessionId}.jsonl`);

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test("returns null when cwd is null", () => {
    expect(readJsonlTranscript(null, sessionId, 10)).toBeNull();
  });

  test("returns null when claudeSessionId is null", () => {
    expect(readJsonlTranscript("/tmp/jsonl-test", null, 10)).toBeNull();
  });

  test("returns null when file does not exist", () => {
    expect(readJsonlTranscript("/tmp/nonexistent-dir-xyz", sessionId, 10)).toBeNull();
  });

  test("reads user and assistant messages from JSONL file", () => {
    mkdirSync(testDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello" },
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId,
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hi!" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        timestamp: "2026-01-01T00:00:02.000Z",
        sessionId,
      }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const entries = readJsonlTranscript("/tmp/jsonl-test", sessionId, 10);
    expect(entries).not.toBeNull();
    expect(entries?.length).toBe(3);
    expect(entries?.[0].direction).toBe("outbound"); // user
    expect(entries?.[1].direction).toBe("inbound"); // assistant
    expect(entries?.[2].direction).toBe("inbound"); // result
    expect(entries?.[0].timestamp).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
  });

  test("filters out non-transcript types", () => {
    mkdirSync(testDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Hi" }, timestamp: "2026-01-01T00:00:01.000Z" }),
      JSON.stringify({ type: "stream_event", event: {}, timestamp: "2026-01-01T00:00:02.000Z" }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const entries = readJsonlTranscript("/tmp/jsonl-test", sessionId, 10);
    expect(entries).not.toBeNull();
    expect(entries?.length).toBe(1);
    expect((entries?.[0].message as Record<string, unknown>).type).toBe("user");
  });

  test("returns last N entries when file has more", () => {
    mkdirSync(testDir, { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `Message ${i}` },
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const entries = readJsonlTranscript("/tmp/jsonl-test", sessionId, 5);
    expect(entries).not.toBeNull();
    expect(entries?.length).toBe(5);
    expect((entries?.[0].message as Record<string, unknown>).message).toEqual({
      role: "user",
      content: "Message 15",
    });
  });

  test("skips malformed lines gracefully", () => {
    mkdirSync(testDir, { recursive: true });
    const lines = [
      "not valid json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Valid" },
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      "{broken",
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const entries = readJsonlTranscript("/tmp/jsonl-test", sessionId, 10);
    expect(entries).not.toBeNull();
    expect(entries?.length).toBe(1);
  });
});

describe("getTranscript JSONL fallback", () => {
  const testDir = join(homedir(), ".claude", "projects", "-test-cwd");
  const claudeSessionId = "claude-session-for-transcript";
  const filePath = join(testDir, `${claudeSessionId}.jsonl`);
  let server: ClaudeWsServer;
  let spawnState: ReturnType<typeof mockSpawn>;

  afterEach(() => {
    // Resolve mock spawn exit to prevent stop() from hanging
    spawnState?.exitResolve(0);
    server?.stop();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test("falls back to JSONL file when buffer has fewer entries than requested", async () => {
    // Create JSONL file with 5 entries
    mkdirSync(testDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `JSONL msg ${i}` },
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    // Set up server with a session
    spawnState = mockSpawn();
    server = new ClaudeWsServer({ spawn: spawnState.spawn });
    server.start();

    const sessionId = "test-session-1";
    server.prepareSession(sessionId, { prompt: "test", cwd: "/test-cwd" });
    server.spawnClaude(sessionId);

    // Connect mock client and send system/init so claudeSessionId is captured
    const ws = await connectMockClaude(server.port, sessionId);
    await waitForMessage(ws); // consume initial prompt

    ws.send(
      serialize({
        type: "system",
        subtype: "init",
        cwd: "/test-cwd",
        session_id: claudeSessionId,
        tools: [],
        mcp_servers: [],
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        apiKeySource: "test",
        claude_code_version: "2.1.70",
        uuid: "test-uuid",
      }),
    );

    // Wait for init to be processed
    await pollUntil(() => {
      const status = server.getStatus(sessionId);
      return status.model === "claude-sonnet-4-6";
    });

    // Buffer has 1 entry (the outbound prompt), requesting 200 exceeds it
    const transcript = server.getTranscript(sessionId, 200);
    // Should get 5 entries from JSONL (not just the 1 in buffer)
    expect(transcript.length).toBe(5);
    expect((transcript[0].message as Record<string, unknown>).message).toEqual({
      role: "user",
      content: "JSONL msg 0",
    });

    ws.close();
  });

  test("returns buffer entries when request fits in buffer", async () => {
    spawnState = mockSpawn();
    server = new ClaudeWsServer({ spawn: spawnState.spawn });
    server.start();

    const sessionId = "test-session-2";
    server.prepareSession(sessionId, { prompt: "hello", cwd: "/test-cwd" });
    server.spawnClaude(sessionId);

    // Connect so the initial prompt is added to transcript
    const ws = await connectMockClaude(server.port, sessionId);
    await waitForMessage(ws); // consume initial prompt

    // Buffer has 1 entry (the outbound prompt); requesting 1 should use buffer
    const transcript = server.getTranscript(sessionId, 1);
    expect(transcript.length).toBe(1);
    expect(transcript[0].direction).toBe("outbound");

    ws.close();
  });
});
