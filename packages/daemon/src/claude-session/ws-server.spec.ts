import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MonitorEventInput, WorkItemEvent } from "@mcp-cli/core";
import { silentLogger } from "@mcp-cli/core";
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
  lastOpts: { cwd?: string; env?: Record<string, string | undefined> };
} {
  let exitResolve: (code: number) => void = () => {};
  const state = {
    spawn: ((cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => {
      state.lastCmd = cmd;
      state.lastOpts = { cwd: opts?.cwd, env: opts?.env };
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
    lastOpts: {} as { cwd?: string; env?: Record<string, string | undefined> },
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

  test("start() creates server and returns port", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  test("start(port) binds to the requested port", async () => {
    // Use a specific well-known port and verify the server actually bound to it
    const first = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const probePort = await first.start(0); // grab a free port
    await first.stop();

    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const port = await server.start(probePort);
    expect(port).toBe(probePort);
    expect(server.port).toBe(probePort);
  });

  test("start(port) falls back to random port on EADDRINUSE", async () => {
    // Occupy a port with a first server
    const first = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const occupiedPort = await first.start(0);
    try {
      // Second server tries the same port — portRetryCount=0 skips backoff for test speed
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger, portRetryCount: 0 });
      const fallbackPort = await server.start(occupiedPort);
      expect(fallbackPort).toBeGreaterThan(0);
      expect(fallbackPort).not.toBe(occupiedPort);
    } finally {
      await first.stop();
    }
  });

  test("start(port) begins reclaim loop on fallback", async () => {
    // Occupy a port, force fallback, then release and verify reclaim
    const blocker = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const wellKnownPort = await blocker.start(0);
    try {
      server = new ClaudeWsServer({
        spawn: mockSpawn().spawn,
        logger: silentLogger,
        portRetryCount: 0,
        reclaimIntervalMs: 50, // fast for testing
      });
      const fallbackPort = await server.start(wellKnownPort);
      expect(fallbackPort).not.toBe(wellKnownPort);
      expect(server.reclaimed).toBe(false);

      // Release the well-known port
      await blocker.stop();

      // Wait for reclaim to succeed
      await pollUntil(() => server?.reclaimed, 3_000);
      expect(server.port).toBe(wellKnownPort);
    } finally {
      await blocker.stop().catch(() => {});
    }
  });

  test("reclaim loop stops after successful reclaim", async () => {
    const blocker = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const wellKnownPort = await blocker.start(0);
    try {
      server = new ClaudeWsServer({
        spawn: mockSpawn().spawn,
        logger: silentLogger,
        portRetryCount: 0,
        reclaimIntervalMs: 50,
      });
      await server.start(wellKnownPort);
      await blocker.stop();

      await pollUntil(() => server?.reclaimed, 3_000);

      // New sessions should get the well-known port in their spawn URL
      const ms = mockSpawn();
      const server2 = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      // Verify reclaimed server accepts connections
      const ws = new WebSocket(`ws://localhost:${wellKnownPort}/session/no-such-session`);
      const closed = new Promise<number>((r) => {
        ws.onclose = (e) => r(e.code);
      });
      // Should get 404 (not connection refused) since the reclaim server is listening
      ws.onerror = () => {};
      await closed;
      await server2.stop();
    } finally {
      await blocker.stop().catch(() => {});
    }
  });

  test("reclaimed port serves new sessions while fallback port keeps existing ones", async () => {
    const blocker = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const wellKnownPort = await blocker.start(0);
    try {
      const ms = mockSpawn();
      server = new ClaudeWsServer({
        spawn: ms.spawn,
        logger: silentLogger,
        portRetryCount: 0,
        reclaimIntervalMs: 50,
      });
      const fallbackPort = await server.start(wellKnownPort);

      // Create a session on the fallback port
      server.prepareSession("existing-session", { prompt: "test" });

      // Connect to the fallback port
      const existingWs = await connectMockClaude(fallbackPort, "existing-session");
      const initMsg = await waitForMessage(existingWs);
      expect(initMsg).toContain('"type":"user"');

      // Release well-known port and wait for reclaim
      await blocker.stop();
      await pollUntil(() => server?.reclaimed, 3_000);

      // server.port should now return the well-known port
      expect(server.port).toBe(wellKnownPort);

      // New session should be connectable on the well-known port
      server.prepareSession("new-session", { prompt: "test2" });
      const newWs = await connectMockClaude(wellKnownPort, "new-session");
      const newInitMsg = await waitForMessage(newWs);
      expect(newInitMsg).toContain('"type":"user"');

      // Existing connection on fallback port should still work —
      // drive session to idle with init + result messages
      existingWs.send(systemInitMessage("existing-session"));
      existingWs.send(resultMessage("existing-session"));
      await pollUntil(() => server?.listSessions().find((s) => s.sessionId === "existing-session")?.state === "idle");

      existingWs.close();
      newWs.close();
    } finally {
      await blocker.stop().catch(() => {});
    }
  });

  test("start() without port does not start reclaim loop", async () => {
    server = new ClaudeWsServer({
      spawn: mockSpawn().spawn,
      logger: silentLogger,
      reclaimIntervalMs: 20,
    });
    await server.start();
    // No reclaim needed when using a random port by choice
    expect(server.reclaimed).toBe(false);
    await Bun.sleep(30);
    expect(server.reclaimed).toBe(false);
  });

  test("prepareSession + spawnClaude starts claude process with correct args", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("spawnClaude passes --model flag when model is set in config", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("model-session", {
      prompt: "Hello",
      model: "claude-sonnet-4-6",
    });
    server.spawnClaude("model-session");

    expect(ms.lastCmd).toContain("--model");
    expect(ms.lastCmd).toContain("claude-sonnet-4-6");
  });

  test("spawnClaude omits --model flag when model is not set", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("no-model-session", {
      prompt: "Hello",
    });
    server.spawnClaude("no-model-session");

    expect(ms.lastCmd).not.toContain("--model");
  });

  test("WS connect sends user message immediately on open", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("listSessions returns session info", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.prepareSession("s2", { prompt: "World" });

    const sessions = server.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  test("getStatus returns detailed session info", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("s1", { prompt: "Hello", worktree: "my-tree" });
    server.spawnClaude("s1");

    const status = server.getStatus("s1");
    expect(status.sessionId).toBe("s1");
    expect(status.worktree).toBe("my-tree");
    expect(status.pid).toBe(12345);
    expect(status.state).toBe("connecting");
  });

  test("checkSessionIdle returns not-idle for connecting session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.spawnClaude("s1");

    const result = server.checkSessionIdle("s1");
    expect(result).not.toBeNull();
    expect(result?.idle).toBe(false);
    expect(result?.state).toBe("connecting");
    expect(result?.resolvedId).toBe("s1");
  });

  test("checkSessionIdle returns idle for idle session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));
      await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "idle"));

      const result = server.checkSessionIdle("test-session");
      expect(result?.idle).toBe(true);
      expect(result?.state).toBe("idle");
    } finally {
      ws.close();
    }
  });

  test("checkSessionIdle returns null for unknown session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    const result = server.checkSessionIdle("nonexistent");
    expect(result).toBeNull();
  });

  test("checkSessionIdle resolves by prefix", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session-abc", { prompt: "Hello" });
    server.spawnClaude("test-session-abc");

    const ws = await connectMockClaude(port, "test-session-abc");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session-abc"));
      ws.send(resultMessage("test-session-abc"));
      await pollUntil(() =>
        server?.listSessions().some((s) => s.sessionId === "test-session-abc" && s.state === "idle"),
      );

      const result = server.checkSessionIdle("test-session");
      expect(result?.resolvedId).toBe("test-session-abc");
      expect(result?.idle).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("transcript stores messages up to limit", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("transcript excludes keep_alive messages", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      // Send keep_alive messages — these should be filtered out
      ws.send(`${JSON.stringify({ type: "keep_alive" })}\n`);
      ws.send(`${JSON.stringify({ type: "keep_alive" })}\n`);
      ws.send(assistantMessage("test-session"));

      // Wait for the assistant message to appear (outbound user + system/init + assistant = 3)
      await pollUntil(() => (server?.getTranscript("test-session")?.length ?? 0) >= 3);

      const transcript = server.getTranscript("test-session");
      // Should have user, system/init, assistant — but NO keep_alive entries
      expect(transcript.every((e) => e.message.type !== "keep_alive")).toBe(true);
      expect(transcript.length).toBe(3);
    } finally {
      ws.close();
    }
  });

  test("waitForResult rejects on timeout", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    await expect(server.waitForResult("test-session", 100)).rejects.toThrow("Timeout");
  });

  test("unknown session path returns 404", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    const res = await fetch(`http://localhost:${port}/session/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("invalid path returns 404", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    const res = await fetch(`http://localhost:${port}/invalid`);
    expect(res.status).toBe(404);
  });

  test("sendPrompt on existing session sends user message", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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

  test("process exit auto-terminates completed session (proc exits while idle)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Drive session to idle: connect WS, send init + result
    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    ws.send(resultMessage("test-session"));
    await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "idle"));

    ws.close();
    // Process exits after session completed work
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().length === 0);

    // Session should be fully terminated, not left as disconnected
    expect(server.listSessions().length).toBe(0);
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("WS-close-then-exit auto-terminates completed session (not zombie disconnected)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Drive session to idle
    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    ws.send(resultMessage("test-session"));
    await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "test-session" && s.state === "idle"));

    // WS closes first — session transitions to disconnected while spawn is still alive
    ws.close();
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    // Now process exits — should auto-terminate because workCompleted is set,
    // even though state is already "disconnected" (not "idle")
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().length === 0);

    expect(server.listSessions().length).toBe(0);
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("WS close marks session as disconnected and rejects result waiters", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Disconnect via process exit
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    expect(() => server?.sendPrompt("test-session", "follow up")).toThrow("Cannot send prompt to disconnected session");
  });

  test("interrupt on disconnected session throws", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    expect(() => server?.interrupt("test-session")).toThrow("Cannot interrupt disconnected session");
  });

  test("waitForResult on already-disconnected session rejects immediately", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    await expect(server.waitForResult("test-session", 5000)).rejects.toThrow("Session is disconnected");
  });

  test("process exit rejects pending result waiters", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    await expect(server.waitForEvent("test-session", 5000)).rejects.toThrow("Session is disconnected");
  });

  test("bye on disconnected session cleans up properly", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello", worktree: "my-tree" });
    server.spawnClaude("test-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    const result = await server.bye("test-session");
    expect(result).toEqual({ worktree: "my-tree", cwd: null, repoRoot: null });
    expect(server.sessionCount).toBe(0);
  });

  test("bye accepts optional closing message and cleans up session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("msg-session", { prompt: "Hello" });
    server.spawnClaude("msg-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    const result = await server.bye("msg-session", "PR #42 pushed and verified");
    expect(server.sessionCount).toBe(0);
    // bye returns worktree metadata regardless of message
    expect(result).toHaveProperty("worktree");
    expect(result).toHaveProperty("cwd");
    expect(result).toHaveProperty("repoRoot");
  });

  test("bye with message logs [bye] entry to transcript", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("transcript-bye-session", { prompt: "Hello" });
    server.spawnClaude("transcript-bye-session");

    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s) => s.state === "disconnected"));

    const transcriptCalls: Array<[string, string, unknown]> = [];
    // biome-ignore lint/suspicious/noExplicitAny: testing private method via monkeypatching
    const origAddTranscript = (server as any).addTranscript.bind(server);
    // biome-ignore lint/suspicious/noExplicitAny: testing private method via monkeypatching
    (server as any).addTranscript = (session: unknown, direction: string, message: unknown) => {
      transcriptCalls.push([direction, JSON.stringify(message), session as string]);
      return origAddTranscript(session, direction, message);
    };

    await server.bye("transcript-bye-session", "PR #99 pushed and verified");

    const byeEntry = transcriptCalls.find(
      ([direction, msg]) => direction === "outbound" && msg.includes("[bye] PR #99 pushed and verified"),
    );
    expect(byeEntry).toBeDefined();
  });

  test("bye with message uses message in termination reason", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("reason-session", { prompt: "Hello" });
    server.spawnClaude("reason-session");

    const eventPromise = server.waitForEvent("reason-session", 5000);
    void server.bye("reason-session", "stuck in retry loop");

    await expect(eventPromise).rejects.toThrow("Session ended: stuck in retry loop");
  });

  test("WS reconnect after disconnect transitions back to connecting without resending prompt", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // Connect, then disconnect
    const ws1 = await connectMockClaude(port, "test-session");
    await waitForMessage(ws1); // consume initial prompt
    ws1.close();
    await pollUntil(() => server?.listSessions()[0]?.state === "disconnected");

    expect(server.listSessions()[0].state).toBe("disconnected");

    // Reconnect — should NOT receive the initial prompt again
    const ws2 = await connectMockClaude(port, "test-session");
    try {
      // Negative assertion: race a real message against a 50ms deadline.
      // No observable condition to poll for (test/CLAUDE.md §exception).
      const msg = await Promise.race([waitForMessage(ws2), Bun.sleep(50).then((): null => null)]);
      expect(msg).toBeNull(); // No prompt resent on reconnect

      // Should transition back from disconnected
      const sessions = server.listSessions();
      expect(sessions[0].wsConnected).toBe(true);
      expect(sessions[0].state).not.toBe("disconnected");
    } finally {
      ws2.close();
    }
  });

  test("terminateSession sets spawnAlive to false", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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

    server = new ClaudeWsServer({ spawn: stubbornSpawn, killTimeoutMs: 50, logger: silentLogger });
    await server.start();
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

    server = new ClaudeWsServer({ spawn: slowSpawn, logger: silentLogger });
    await server.start();
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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("interrupt with reason prepends context to next sendPrompt", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

      // Consume the interrupt control_request, then listen for the user message
      const interruptPromise = waitForMessage(ws);
      server.interrupt("test-session", "Wrong path, abandon it");
      await interruptPromise;

      const msgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Do something else");

      const msg = await msgPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("[Interrupt context: Wrong path, abandon it]\n\nDo something else");
    } finally {
      ws.close();
    }
  });

  test("interrupt reason is consumed on first sendPrompt only", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

      // Consume the interrupt control_request
      const interruptPromise = waitForMessage(ws);
      server.interrupt("test-session", "Stop that");
      await interruptPromise;

      // First send: reason prepended
      const firstMsgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "First follow-up");
      const firstMsg = await firstMsgPromise;
      const firstParsed = JSON.parse(firstMsg.trim());
      expect(firstParsed.message.content).toContain("[Interrupt context: Stop that]");

      // Session goes idle again
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

      // Second send: no reason prepended
      const secondMsgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Second follow-up");
      const secondMsg = await secondMsgPromise;
      const secondParsed = JSON.parse(secondMsg.trim());
      expect(secondParsed.message.content).toBe("Second follow-up");
    } finally {
      ws.close();
    }
  });

  test("bare interrupt clears a previously set pending reason", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

      // Set a reason via first interrupt
      const firstInterruptPromise = waitForMessage(ws);
      server.interrupt("test-session", "Wrong path");
      await firstInterruptPromise;

      // Bare interrupt should clear the pending reason
      const secondInterruptPromise = waitForMessage(ws);
      server.interrupt("test-session");
      await secondInterruptPromise;

      // sendPrompt should not prepend the stale reason
      const msgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Next instruction");
      const msg = await msgPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.message.content).toBe("Next instruction");
    } finally {
      ws.close();
    }
  });

  test("interrupt without reason does not affect sendPrompt", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

      // Consume the interrupt control_request
      const interruptPromise = waitForMessage(ws);
      server.interrupt("test-session");
      await interruptPromise;

      const msgPromise = waitForMessage(ws);
      server.sendPrompt("test-session", "Plain message");

      const msg = await msgPromise;
      const parsed = JSON.parse(msg.trim());
      expect(parsed.message.content).toBe("Plain message");
    } finally {
      ws.close();
    }
  });

  test("waitForEvent resolves on session:result", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const err = await server.waitForEvent("test-session", 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect((err as Error).message).toContain("Timeout");
  });

  test("waitForEvent resolves immediately when session is already idle", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    await expect(server.waitForEvent("nonexistent", 100)).rejects.toThrow("Unknown session");
  });

  test("waitForEvent rejects with no active sessions", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    await expect(server.waitForEvent(null, 100)).rejects.toThrow("No active sessions");
  });

  test("waitForEvent rejects when session terminates", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const eventPromise = server.waitForEvent("test-session", 5000);

    // End the session
    void server.bye("test-session");

    await expect(eventPromise).rejects.toThrow("Session ended by user");
  });

  test("bye returns worktree info", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("wt-session", {
      prompt: "Hello",
      worktree: "claude-test1",
      cwd: "/repo",
      repoRoot: "/original-repo",
    });
    server.spawnClaude("wt-session");

    const result = await server.bye("wt-session");
    expect(result).toEqual({ worktree: "claude-test1", cwd: "/repo", repoRoot: "/original-repo" });
  });

  test("spawnClaude omits --worktree when both cwd and worktree are set (hook pre-created)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("hook-session", {
      prompt: "Hello",
      worktree: "my-tree",
      cwd: "/tmp/worktrees/my-tree",
    });
    server.spawnClaude("hook-session");

    // cwd should be passed (as spawn option), but --worktree should NOT be in the command
    expect(ms.lastCmd).not.toContain("--worktree");
    expect(ms.lastCmd).not.toContain("my-tree");
  });

  test("spawnClaude passes --worktree when only worktree is set (no cwd)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("wt-only-session", {
      prompt: "Hello",
      worktree: "my-tree",
    });
    server.spawnClaude("wt-only-session");

    expect(ms.lastCmd).toContain("--worktree");
    expect(ms.lastCmd).toContain("my-tree");
  });

  test("spawnClaude passes TRACEPARENT env when traceparent is provided", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("trace-session", { prompt: "Hello" });
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    server.spawnClaude("trace-session", tp);

    expect(ms.lastOpts.env).toEqual({ TRACEPARENT: tp });
  });

  test("spawnClaude omits TRACEPARENT env when traceparent is not provided", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("no-trace-session", { prompt: "Hello" });
    server.spawnClaude("no-trace-session");

    expect(ms.lastOpts.env).toBeUndefined();
  });

  test("spawnClaude pins GIT_DIR and GIT_WORK_TREE when worktree and cwd are both set", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    const worktreePath = "/repo/.claude/worktrees/my-tree";
    server.prepareSession("wt-pinned-session", {
      prompt: "Hello",
      worktree: "my-tree",
      cwd: worktreePath,
    });
    server.spawnClaude("wt-pinned-session");

    expect(ms.lastOpts.env).toMatchObject({
      GIT_DIR: `${worktreePath}/.git`,
      GIT_WORK_TREE: worktreePath,
    });
  });

  test("spawnClaude does not pin GIT_DIR when only worktree name is set (no cwd)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("wt-name-only-session", {
      prompt: "Hello",
      worktree: "my-tree",
    });
    server.spawnClaude("wt-name-only-session");

    expect(ms.lastOpts.env).toBeUndefined();
  });

  test("spawnClaude includes both TRACEPARENT and GIT pins when all are set", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    const worktreePath = "/repo/.claude/worktrees/my-tree";
    const tp = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    server.prepareSession("wt-trace-session", {
      prompt: "Hello",
      worktree: "my-tree",
      cwd: worktreePath,
    });
    server.spawnClaude("wt-trace-session", tp);

    expect(ms.lastOpts.env).toEqual({
      TRACEPARENT: tp,
      GIT_DIR: `${worktreePath}/.git`,
      GIT_WORK_TREE: worktreePath,
    });
  });

  test("bye returns null worktree for non-worktree session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("plain-session", { prompt: "Hello" });
    server.spawnClaude("plain-session");

    const result = await server.bye("plain-session");
    expect(result).toEqual({ worktree: null, cwd: null, repoRoot: null });
  });

  test("bye suppresses worktree cleanup when another session shares the same worktree (#1837)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    // Simulate parallel-spawn race: two sessions claim the same worktree
    server.prepareSession("ghost-session", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo/.claude/worktrees/claude-shared",
      repoRoot: "/repo",
    });
    server.prepareSession("active-session", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo/.claude/worktrees/claude-shared",
      repoRoot: "/repo",
    });

    // Bye the ghost — worktree should be suppressed because active-session still uses it
    const ghostResult = await server.bye("ghost-session");
    expect(ghostResult.worktree).toBeNull();
    expect(ghostResult.cwd).toBeNull();
    expect(ghostResult.repoRoot).toBeNull();

    // Bye the remaining session — worktree should be returned for cleanup
    const activeResult = await server.bye("active-session");
    expect(activeResult.worktree).toBe("claude-shared");
    expect(activeResult.cwd).toBe("/repo/.claude/worktrees/claude-shared");
    expect(activeResult.repoRoot).toBe("/repo");
  });

  test("bye with concurrent calls on shared worktree: exactly one returns worktree for cleanup (#1837)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("ghost-session", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo/.claude/worktrees/claude-shared",
      repoRoot: "/repo",
    });
    server.prepareSession("active-session", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo/.claude/worktrees/claude-shared",
      repoRoot: "/repo",
    });

    // Concurrent byes — one must suppress, the other must return the worktree
    const [ghostResult, activeResult] = await Promise.all([server.bye("ghost-session"), server.bye("active-session")]);

    const worktrees = [ghostResult.worktree, activeResult.worktree];
    const nonNullCount = worktrees.filter((w) => w !== null).length;
    expect(nonNullCount).toBe(1);
  });

  test("bye does NOT suppress cleanup when same worktree name is in different repos (#1837)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("session-a", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo-a/.claude/worktrees/claude-shared",
      repoRoot: "/repo-a",
    });
    server.prepareSession("session-b", {
      prompt: "Hello",
      worktree: "claude-shared",
      cwd: "/repo-b/.claude/worktrees/claude-shared",
      repoRoot: "/repo-b",
    });

    // Bye session-a — should NOT be suppressed because session-b is in a different repo/cwd
    const resultA = await server.bye("session-a");
    expect(resultA.worktree).toBe("claude-shared");
    expect(resultA.cwd).toBe("/repo-a/.claude/worktrees/claude-shared");
    expect(resultA.repoRoot).toBe("/repo-a");

    const resultB = await server.bye("session-b");
    expect(resultB.worktree).toBe("claude-shared");
    expect(resultB.cwd).toBe("/repo-b/.claude/worktrees/claude-shared");
    expect(resultB.repoRoot).toBe("/repo-b");
  });

  test("sessionCount tracks active sessions", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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

  test("stop() cleans up all sessions", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("currentSeq starts at 0", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();
    expect(server.currentSeq).toBe(0);
  });

  test("events increment currentSeq and include seq in event", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

      // Send a follow-up prompt so the session is active (not idle).
      // Without this, findImmediateEvent would detect the idle session
      // and return immediately instead of blocking.
      server.sendPrompt("test-session", "follow up");

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    // No events will fire — should timeout and return empty
    const result: WaitResult = await server.waitForEventsSince("test-session", 0, 100);
    expect(result.events).toHaveLength(0);
    expect(result.seq).toBe(0); // No events ever fired
  });

  test("waitForEventsSince filters by sessionId from buffer", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

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

  test("waitForEventsSince returns immediately when session is already idle (fixes #978)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Drive session to idle state
      ws.send(systemInitMessage("test-session"));
      ws.send(resultMessage("test-session"));

      // Wait for events to be processed and get the current seq
      await pollUntil(() => (server?.currentSeq ?? 0) > 0);
      const currentSeq = server.currentSeq;

      // Call waitForEventsSince with cursor AT current seq (event already consumed).
      // Before fix, this would block until timeout because the buffer has no events
      // past the cursor and findImmediateEvent wasn't checked.
      const result: WaitResult = await server.waitForEventsSince("test-session", currentSeq, 1000);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe("session:result");
      expect(result.events[0].session?.state).toBe("idle");
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince returns immediately when any session is idle with null filter (fixes #978)", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("s1", { prompt: "Hello" });
    server.spawnClaude("s1");

    const ws1 = await connectMockClaude(port, "s1");
    try {
      await waitForMessage(ws1);

      // Drive s1 to idle
      ws1.send(systemInitMessage("s1"));
      ws1.send(resultMessage("s1"));

      // Wait for result event to be processed
      await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));
      const currentSeq = server.currentSeq;

      // Create a second session that stays active
      server.prepareSession("s2", { prompt: "World" });
      server.spawnClaude("s2");
      const ws2 = await connectMockClaude(port, "s2");
      try {
        await waitForMessage(ws2);
        ws2.send(systemInitMessage("s2"));

        // waitForEventsSince with null sessionId and cursor past all events
        // should detect s1 is idle and return immediately
        const result: WaitResult = await server.waitForEventsSince(null, currentSeq, 1000);
        expect(result.events).toHaveLength(1);
        expect(result.events[0].event).toBe("session:result");
        expect(result.events[0].sessionId).toBe("s1");
      } finally {
        ws2.close();
      }
    } finally {
      ws1.close();
    }
  });

  test("waitForEventsSince rejects for unknown session", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

    await expect(server.waitForEventsSince("nonexistent", 0, 100)).rejects.toThrow("Unknown session");
  });

  test("waitForEventsSince rejects with no active sessions", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

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

    server = new ClaudeWsServer({ spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    // Connect and send init but NOT result, so session stays in active/init state (not idle)
    // This prevents findImmediateEvent from short-circuiting with session:result
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(10);

    const before = Date.now();
    // waitForEvent blocks — session is not idle
    const eventPromise = server.waitForEvent("test-session", 5000);
    server.sendPrompt("test-session", "/clear");

    const event = await eventPromise;
    expect(event.event).toBe("session:cleared");
    expect(event.session).toBeDefined();
    expect(event.session?.sessionId).toBe("test-session");
    expect(typeof event.session?.snapshotTs).toBe("number");
    expect(event.session?.snapshotTs).toBeGreaterThanOrEqual(before);
    ws.close();
  });

  test("waitForEvent session:model_changed event includes session snapshot with snapshotTs", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);

      const before = Date.now();
      const eventPromise = server.waitForEvent("test-session", 5000);
      server.sendPrompt("test-session", "/model claude-opus-4-6");

      const event = await eventPromise;
      expect(event.event).toBe("session:model_changed");
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(typeof event.session?.snapshotTs).toBe("number");
      expect(event.session?.snapshotTs).toBeGreaterThanOrEqual(before);
    } finally {
      ws.close();
    }
  });

  test("waitForEvent session:disconnected event includes session snapshot with snapshotTs", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);

      const before = Date.now();
      const eventPromise = server.waitForEvent("test-session", 5000);
      // Trigger process exit — this routes through handleSessionEvent which calls resolveEventWaiters
      ms.exitResolve(0);

      const event = await eventPromise;
      expect(event.event).toBe("session:disconnected");
      expect(event.session).toBeDefined();
      expect(event.session?.sessionId).toBe("test-session");
      expect(typeof event.session?.snapshotTs).toBe("number");
      expect(event.session?.snapshotTs).toBeGreaterThanOrEqual(before);
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

    server = new ClaudeWsServer({ spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws); // initial prompt
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(10);
    ws.send(resultMessage("test-session"));
    await Bun.sleep(10);

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // initial prompt
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);

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
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(10);
      ws.send(resultMessage("test-session"));
      await Bun.sleep(10);

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

    server = new ClaudeWsServer({ spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    await waitForMessage(ws);
    ws.send(systemInitMessage("test-session"));
    await Bun.sleep(10);
    ws.send(assistantMessage("test-session"));
    await Bun.sleep(10);
    ws.send(resultMessage("test-session"));
    await Bun.sleep(10);

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
    const server = new ClaudeWsServer({ spawn: spawnState.spawn, logger: silentLogger });
    server.onSessionEvent = (_sid, event) => events.push(event);
    const port = await server.start();

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

  // ── Error isolation in handleSessionEvent and handleMessage ──

  test("resolveWaiters still runs when a waiting resolve callback throws on session:result", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // consume initial prompt

      // Inject a throwing EventWaiter into the class-level eventWaiters array.
      // When resolveEventWaiters iterates, this waiter's resolve throws — simulating
      // the bug where a bad eventWaiter previously blocked resolveWaiters from running.
      const srv = server as unknown as {
        eventWaiters: Array<{
          sessionId: string | null;
          resolve: (e: unknown) => void;
          reject: (e: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }>;
      };
      const dummyDelayMs = 60_000; // far-future timer — won't fire; satisfies the timer field type
      srv.eventWaiters.push({
        sessionId: "test-session",
        resolve: () => {
          throw new Error("simulated eventWaiter resolve failure");
        },
        reject: () => {},
        timer: setTimeout(() => {}, dummyDelayMs),
      });

      // waitForResult registers a resultWaiter — it must resolve even if the eventWaiter above throws
      const resultPromise = server.waitForResult("test-session", 5000);
      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const result = await resultPromise;
      expect(result.success).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("resolveWaiters still runs when a waiting resolve callback throws on session:error", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // consume initial prompt

      // Inject a throwing EventWaiter
      const srv = server as unknown as {
        eventWaiters: Array<{
          sessionId: string | null;
          resolve: (e: unknown) => void;
          reject: (e: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }>;
      };
      const dummyDelayMs = 60_000; // far-future timer — won't fire; satisfies the timer field type
      srv.eventWaiters.push({
        sessionId: "test-session",
        resolve: () => {
          throw new Error("simulated eventWaiter resolve failure");
        },
        reject: () => {},
        timer: setTimeout(() => {}, dummyDelayMs),
      });

      const resultPromise = server.waitForResult("test-session", 5000);
      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      ws.send(
        serialize({
          type: "result",
          subtype: "error",
          is_error: true,
          errors: ["Something went wrong"],
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.001,
          uuid: "err-uuid",
          session_id: "test-session",
        }),
      );

      const result = await resultPromise;
      expect(result.success).toBe(false);
    } finally {
      ws.close();
    }
  });

  test("handleSessionEvent throw does not drop remaining events in the same NDJSON frame", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    // Make handleSessionEvent throw on session:init but delegate normally for all other events.
    // This simulates an unexpected exception in the event handler for one event type.
    // biome-ignore lint/suspicious/noExplicitAny: testing private method via monkeypatching
    const original = (server as any).handleSessionEvent.bind(server);
    // biome-ignore lint/suspicious/noExplicitAny: testing private method via monkeypatching
    (server as any).handleSessionEvent = (sessionId: string, session: unknown, event: { type: string }) => {
      if (event.type === "session:init") {
        throw new Error("simulated handleSessionEvent failure on session:init");
      }
      return original(sessionId, session, event);
    };

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // consume initial prompt

      // Send all three messages as a SINGLE WebSocket frame (concatenated NDJSON).
      // parseFrame splits them, so handleMessage processes all three in one call.
      // session:init handler will throw, but session:result must still be processed.
      const resultPromise = server.waitForResult("test-session", 5000);
      ws.send(systemInitMessage("test-session") + assistantMessage("test-session") + resultMessage("test-session"));

      const result = await resultPromise;
      expect(result.success).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("throwing onSessionEvent callback does not prevent handleSessionEvent from running", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    // onSessionEvent that always throws — must not block handleSessionEvent from resolving waiters
    server.onSessionEvent = () => {
      throw new Error("callback error");
    };

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws); // consume initial prompt

      // waitForResult relies on handleSessionEvent running — if the onSessionEvent throw
      // propagated and blocked it, this would hang until timeout
      const resultPromise = server.waitForResult("test-session", 5000);
      ws.send(systemInitMessage("test-session"));
      ws.send(assistantMessage("test-session"));
      ws.send(resultMessage("test-session"));

      const result = await resultPromise;
      expect(result.success).toBe(true);
    } finally {
      ws.close();
    }
  });

  // ── repoRoot filtering (#607) ──

  test("listSessions includes repoRoot from session config", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    server.start();

    server.prepareSession("s-repo", { prompt: "Hello", repoRoot: "/projects/my-repo" });
    server.prepareSession("s-norepo", { prompt: "World" });

    const sessions = server.listSessions();
    const sRepo = sessions.find((s) => s.sessionId === "s-repo");
    const sNoRepo = sessions.find((s) => s.sessionId === "s-norepo");

    expect(sRepo?.repoRoot).toBe("/projects/my-repo");
    expect(sNoRepo?.repoRoot).toBeNull();
  });

  test("listSessions repoRoot filter: matching and non-matching sessions", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    server.start();

    server.prepareSession("s1", { prompt: "A", repoRoot: "/repo/a" });
    server.prepareSession("s2", { prompt: "B", repoRoot: "/repo/b" });

    const allSessions = server.listSessions();
    expect(allSessions).toHaveLength(2);

    // Apply the same filter predicate used in handleSessionList
    const repoRoot = "/repo/a";
    const filtered = allSessions.filter((s) => {
      if (s.repoRoot) return s.repoRoot === repoRoot;
      return s.cwd !== null && (s.cwd === repoRoot || s.cwd.startsWith(`${repoRoot}/`));
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("s1");
  });

  test("handleSessionList predicate: null repoRoot falls back to cwd prefix (#1242)", () => {
    // Mirror the predicate used in handleSessionList. Prior buggy version
    // (`!s.repoRoot || s.repoRoot === repoRoot`) let null-repoRoot sessions
    // leak across every repo; the fix scopes them by cwd prefix instead.
    type S = { sessionId: string; repoRoot: string | null; cwd: string | null };
    const predicate = (s: S, repoRoot: string) => {
      if (s.repoRoot) return s.repoRoot === repoRoot;
      return s.cwd !== null && (s.cwd === repoRoot || s.cwd.startsWith(`${repoRoot}/`));
    };

    const sessions: S[] = [
      { sessionId: "leaky-a", repoRoot: null, cwd: "/repo/a/sub" },
      { sessionId: "healthy-b", repoRoot: "/repo/b", cwd: "/repo/b/sub" },
      { sessionId: "healthy-a", repoRoot: "/repo/a", cwd: "/repo/a/wt" },
      { sessionId: "no-cwd", repoRoot: null, cwd: null },
    ];

    // From /repo/b: null-repoRoot session under /repo/a must NOT leak in.
    expect(sessions.filter((s) => predicate(s, "/repo/b")).map((s) => s.sessionId)).toEqual(["healthy-b"]);

    // From /repo/a: null-repoRoot session under /repo/a IS included (via cwd).
    expect(sessions.filter((s) => predicate(s, "/repo/a")).map((s) => s.sessionId)).toEqual(["leaky-a", "healthy-a"]);

    // Session with null repoRoot AND null cwd is filtered out from every repo.
    expect(sessions.filter((s) => predicate(s, "/repo/c")).map((s) => s.sessionId)).toEqual([]);
  });

  test("listSessions repoRoot filter: no filter returns all sessions", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    server.start();

    server.prepareSession("s1", { prompt: "A", repoRoot: "/repo/a" });
    server.prepareSession("s2", { prompt: "B", repoRoot: "/repo/b" });

    const allSessions = server.listSessions();
    // Without repoRoot filter, all sessions should be returned
    expect(allSessions).toHaveLength(2);
  });

  test("waitForEvent repoRoot filter: mismatched event is detectable", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("s-mismatch", { prompt: "Hello", repoRoot: "/repo/other" });
    server.spawnClaude("s-mismatch");

    const ws = await connectMockClaude(port, "s-mismatch");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("s-mismatch"));
      ws.send(resultMessage("s-mismatch"));
      await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

      // waitForEvent resolves immediately since session is idle
      const event = await server.waitForEvent("s-mismatch", 1000);
      expect(event.session?.repoRoot).toBe("/repo/other");

      // Apply the legacy path filter from handleWait:
      // if (repoRoot && event.session?.repoRoot && event.session.repoRoot !== repoRoot)
      const requestedRepoRoot = "/repo/mine";
      const isMismatch =
        Boolean(requestedRepoRoot) && Boolean(event.session?.repoRoot) && event.session?.repoRoot !== requestedRepoRoot;
      expect(isMismatch).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("waitForEvent repoRoot filter: matching event passes through", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("s-match", { prompt: "Hello", repoRoot: "/repo/mine" });
    server.spawnClaude("s-match");

    const ws = await connectMockClaude(port, "s-match");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("s-match"));
      ws.send(resultMessage("s-match"));
      await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

      const event = await server.waitForEvent("s-match", 1000);
      expect(event.session?.repoRoot).toBe("/repo/mine");

      // Same repoRoot — should NOT be filtered
      const requestedRepoRoot = "/repo/mine";
      const isMismatch =
        Boolean(requestedRepoRoot) && Boolean(event.session?.repoRoot) && event.session?.repoRoot !== requestedRepoRoot;
      expect(isMismatch).toBe(false);
    } finally {
      ws.close();
    }
  });

  test("waitForEvent repoRoot filter: event without repoRoot passes through", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    server.prepareSession("s-none", { prompt: "Hello" }); // no repoRoot
    server.spawnClaude("s-none");

    const ws = await connectMockClaude(port, "s-none");
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage("s-none"));
      ws.send(resultMessage("s-none"));
      await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

      const event = await server.waitForEvent("s-none", 1000);
      expect(event.session?.repoRoot).toBeNull();

      // Null repoRoot on event — should NOT be filtered (passes through)
      const requestedRepoRoot = "/repo/mine";
      const isMismatch =
        Boolean(requestedRepoRoot) && Boolean(event.session?.repoRoot) && event.session?.repoRoot !== requestedRepoRoot;
      expect(isMismatch).toBe(false);
    } finally {
      ws.close();
    }
  });

  test("waitForEventsSince repoRoot filter: filters events by repoRoot", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    const port = await server.start();

    // Set up session A with repoRoot /repo/a
    server.prepareSession("s-a", { prompt: "A", repoRoot: "/repo/a" });
    server.spawnClaude("s-a");

    const wsA = await connectMockClaude(port, "s-a");
    try {
      await waitForMessage(wsA);
      wsA.send(systemInitMessage("s-a"));
      wsA.send(resultMessage("s-a"));
      await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "s-a" && s.state === "idle"));

      // Set up session B with repoRoot /repo/b
      server.prepareSession("s-b", { prompt: "B", repoRoot: "/repo/b" });
      server.spawnClaude("s-b");

      const wsB = await connectMockClaude(port, "s-b");
      try {
        await waitForMessage(wsB);
        wsB.send(systemInitMessage("s-b"));
        wsB.send(resultMessage("s-b"));
        await pollUntil(() => server?.listSessions().some((s) => s.sessionId === "s-b" && s.state === "idle"));

        // Get all events via cursor-based wait
        const result: WaitResult = await server.waitForEventsSince(null, 0, 5000);
        expect(result.events.length).toBeGreaterThan(0);

        // Apply the same filter from handleWait cursor path:
        // result.events.filter((e) => !e.session?.repoRoot || e.session.repoRoot === repoRoot)
        const repoRoot = "/repo/a";
        const filtered = result.events.filter((e) => !e.session?.repoRoot || e.session.repoRoot === repoRoot);

        // Only events from s-a should remain (or events without repoRoot)
        for (const e of filtered) {
          if (e.session?.repoRoot) {
            expect(e.session.repoRoot).toBe("/repo/a");
          }
        }

        // Events from s-b should have been filtered out
        const sBEvents = filtered.filter((e) => e.session?.repoRoot === "/repo/b");
        expect(sBEvents).toHaveLength(0);
      } finally {
        wsB.close();
      }
    } finally {
      wsA.close();
    }
  });

  test("transitions to idle via fallback when result message has unrecognized schema (fixes #978)", async () => {
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => errors.push(msg) };
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));

      // Send a result message with unrecognized schema (missing strict fields
      // like is_error, result, usage, etc.) — the fallback should still
      // transition the session to idle instead of leaving it stuck in active.
      ws.send(
        serialize({
          type: "result",
          subtype: "unknown_subtype",
          uuid: "test-uuid",
          session_id: "test-session",
        }),
      );

      // Session should transition to idle via fallback
      await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));
      const status = server.getStatus("test-session");
      expect(status.state).toBe("idle");

      // Should log schema mismatch diagnostic
      expect(errors.some((e) => e.includes("Schema mismatch") && e.includes("fallback"))).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("logs schema mismatch when system/init is missing fields", async () => {
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => errors.push(msg) };
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);

      // Send a minimal system/init missing most required fields
      ws.send(
        serialize({
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "test-session",
          model: "claude-sonnet-4-6",
          // Missing: tools, mcp_servers, permissionMode, apiKeySource,
          // claude_code_version, uuid
        }),
      );

      // Should still transition to init (not stuck in connecting)
      await pollUntil(() => server?.listSessions().some((s) => s.state === "init"));
      expect(server.listSessions()[0].state).toBe("init");

      // Should log schema mismatch
      await pollUntil(() => errors.some((e) => e.includes("Schema mismatch") && e.includes("system/init")));
    } finally {
      ws.close();
    }
  });

  test("logs unrecognized message type", async () => {
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (msg: string) => errors.push(msg) };
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger });
    const port = await server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const ws = await connectMockClaude(port, "test-session");
    try {
      await waitForMessage(ws);
      ws.send(systemInitMessage("test-session"));

      // Send a completely unknown message type
      ws.send(
        serialize({
          type: "new_feature_type",
          data: "something",
          session_id: "test-session",
        }),
      );

      await pollUntil(() => errors.some((e) => e.includes("Unrecognized message type")));
      expect(errors.some((e) => e.includes('"new_feature_type"'))).toBe(true);
    } finally {
      ws.close();
    }
  });
});

// ── summarizeInput ──

describe("summarizeInput", () => {
  test("returns key=value for string input", async () => {
    expect(summarizeInput({ command: "echo hello" })).toBe("command=echo hello");
  });

  test("returns empty string for empty input", async () => {
    expect(summarizeInput({})).toBe("");
  });

  test("truncates long values to 80 chars", async () => {
    const longValue = "x".repeat(100);
    const result = summarizeInput({ command: longValue });
    expect(result.length).toBe(80);
    expect(result.endsWith("...")).toBe(true);
  });

  test("JSON-stringifies non-string values", async () => {
    expect(summarizeInput({ count: 42 })).toBe("count=42");
  });
});

// ── JSONL fallback tests ──

describe("resolveJsonlPath", () => {
  test("encodes cwd with dashes and appends session ID", async () => {
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

  test("returns null when cwd is null", async () => {
    expect(readJsonlTranscript(null, sessionId, 10)).toBeNull();
  });

  test("returns null when claudeSessionId is null", async () => {
    expect(readJsonlTranscript("/tmp/jsonl-test", null, 10)).toBeNull();
  });

  test("returns null when file does not exist", async () => {
    expect(readJsonlTranscript("/tmp/nonexistent-dir-xyz", sessionId, 10)).toBeNull();
  });

  test("reads user and assistant messages from JSONL file", async () => {
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

  test("filters out non-transcript types", async () => {
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

  test("returns last N entries when file has more", async () => {
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

  test("skips malformed lines gracefully", async () => {
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
    server = new ClaudeWsServer({ spawn: spawnState.spawn, logger: silentLogger });
    await server.start();

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
    server = new ClaudeWsServer({ spawn: spawnState.spawn, logger: silentLogger });
    await server.start();

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

// ── Stderr drain (pipe buffer deadlock prevention, #546) ──

describe("stderr drain", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  /**
   * Create a mock spawn that returns a ReadableStream for stderr.
   * The returned `writeStderr` function pushes text into the stream.
   * Call `closeStderr` to close the stream (simulates process exit).
   */
  function mockSpawnWithStderr(): {
    spawn: SpawnFn;
    exitResolve: (code: number) => void;
    writeStderr: (text: string) => void;
    closeStderr: () => void;
    killed: boolean;
    lastCmd: string[];
    lastOpts: { cwd?: string };
  } {
    let exitResolve: (code: number) => void = () => {};
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const state = {
      spawn: ((cmd: string[], opts: { cwd?: string }) => {
        state.lastCmd = cmd;
        state.lastOpts = { cwd: opts.cwd };
        const stderrStream = new ReadableStream<Uint8Array>({
          start(controller) {
            stderrController = controller;
          },
        });
        return {
          pid: 99999,
          exited: new Promise<number>((r) => {
            exitResolve = r;
          }),
          kill: () => {
            state.killed = true;
            exitResolve(143);
          },
          stderr: stderrStream,
        };
      }) as SpawnFn,
      exitResolve: (code: number) => exitResolve(code),
      writeStderr: (text: string) => stderrController?.enqueue(encoder.encode(text)),
      closeStderr: () => stderrController?.close(),
      killed: false,
      lastCmd: [] as string[],
      lastOpts: {} as { cwd?: string },
    };
    return state;
  }

  test("stderr is drained and captured — session transitions to disconnected on exit", async () => {
    const errors: string[] = [];
    const capturingLogger = { ...silentLogger, error: (...args: unknown[]) => errors.push(args.join(" ")) };
    const ms = mockSpawnWithStderr();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: capturingLogger });
    await server.start();

    server.prepareSession("stderr-test", { prompt: "Hello", cwd: "/test/worktree" });
    server.spawnClaude("stderr-test");

    // Write some stderr lines
    ms.writeStderr("line 1\nline 2\nline 3\n");

    // Close stderr and exit process — drain completes before exit handler reads buffer
    ms.closeStderr();
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s: { state: string }) => s.state === "disconnected"));

    // Session should have transitioned to disconnected (not stuck in connecting)
    const sessions = server.listSessions();
    expect(sessions[0].state).toBe("disconnected");

    // Stderr lines should appear in the exit log
    const exitLog = errors.find((e) => e.includes("Spawn exited"));
    expect(exitLog).toContain("line 1");
    expect(exitLog).toContain("line 3");
  });

  test("stderr drain prevents pipe buffer deadlock with large output", async () => {
    const ms = mockSpawnWithStderr();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("large-stderr", { prompt: "Hello", cwd: "/test/worktree" });
    server.spawnClaude("large-stderr");

    // Simulate >64KB of stderr (would deadlock without drain)
    const bigLine = "X".repeat(1000);
    for (let i = 0; i < 100; i++) {
      ms.writeStderr(`${bigLine}\n`);
    }

    // Close stderr and resolve exit — if drain wasn't consuming, the writes above
    // would have blocked (deadlock). Reaching this point proves the drain works.
    ms.closeStderr();
    ms.exitResolve(0);
    await pollUntil(() => server?.listSessions().some((s: { state: string }) => s.state === "disconnected"));
  });

  test("stderrLines ring buffer limits to 50 lines", async () => {
    const errors: string[] = [];
    const capturingLogger = { ...silentLogger, error: (...args: unknown[]) => errors.push(args.join(" ")) };
    const ms = mockSpawnWithStderr();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: capturingLogger });
    await server.start();

    server.prepareSession("ring-buffer-test", { prompt: "Hello" });
    server.spawnClaude("ring-buffer-test");

    // Write 80 lines — only last 50 should be kept
    for (let i = 0; i < 80; i++) {
      ms.writeStderr(`line ${i}\n`);
    }

    ms.closeStderr();
    ms.exitResolve(1);
    await pollUntil(() => server?.listSessions().some((s: { state: string }) => s.state === "disconnected"));

    // The exit handler logs all buffered stderr lines — verify ring buffer behavior
    const exitLog = errors.find((e) => e.includes("Spawn exited"));
    expect(exitLog).toBeDefined();
    // Should NOT contain early lines (0-29) — they were evicted
    expect(exitLog).not.toContain("line 0\n");
    expect(exitLog).not.toContain("line 29\n");
    // Should contain the last 50 lines (30-79)
    expect(exitLog).toContain("line 30");
    expect(exitLog).toContain("line 79");
    // Count the lines in the logged suffix (after ": ")
    const suffix = exitLog?.split(": ").slice(1).join(": ") ?? "";
    const lineCount = suffix.split("\n").filter((l: string) => l.startsWith("line ")).length;
    expect(lineCount).toBe(50);
  });

  test("spawnClaude passes cwd to spawn for hook-created worktrees", async () => {
    const ms = mockSpawnWithStderr();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("cwd-test", {
      prompt: "Hello",
      worktree: "my-tree",
      cwd: "/external/worktree/my-tree",
    });
    server.spawnClaude("cwd-test");

    // Verify cwd was passed to the spawn function
    expect(ms.lastOpts.cwd).toBe("/external/worktree/my-tree");
    // --worktree should NOT be in the command (hook pre-created)
    expect(ms.lastCmd).not.toContain("--worktree");
  });

  test("connect timeout transitions session to disconnected when CLI does not connect", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger, connectTimeoutMs: 100 });
    const port = await server.start();

    const events: SessionEvent[] = [];
    server.onSessionEvent = (_id, event) => events.push(event);

    server.prepareSession("timeout-test", { prompt: "Hello" });
    server.spawnClaude("timeout-test");

    // Session starts in connecting state
    expect(server.listSessions()[0].state).toBe("connecting");

    // Wait for the connect timeout to fire
    await pollUntil(() => {
      const s = server?.listSessions()[0];
      return s?.state === "disconnected";
    }, 2_000);

    expect(server.listSessions()[0].state).toBe("disconnected");
    expect(events.some((e) => e.type === "session:disconnected")).toBe(true);
    const disconnectEvent = events.find((e) => e.type === "session:disconnected") as {
      type: "session:disconnected";
      reason: string;
    };
    expect(disconnectEvent.reason).toBe("connect timeout");
    // Process should have been killed
    expect(ms.killed).toBe(true);
  });

  test("connect timeout is cleared when WS connection arrives", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger, connectTimeoutMs: 50 });
    const port = await server.start();

    server.prepareSession("connect-ok", { prompt: "Hello" });
    server.spawnClaude("connect-ok");

    // Connect before timeout fires
    const ws = await connectMockClaude(port, "connect-ok");
    const initMsg = await waitForMessage(ws);
    expect(initMsg).toContain('"type":"user"');

    // Wait past the timeout period — session should NOT transition to disconnected
    await Bun.sleep(60);
    expect(server.listSessions()[0].state).toBe("connecting"); // still waiting for system/init

    ws.close();
  });

  test("connect timeout does not fire for sessions that already received WS open", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger, connectTimeoutMs: 50 });
    const port = await server.start();

    server.prepareSession("no-timeout", { prompt: "Hello" });
    server.spawnClaude("no-timeout");

    // Connect and send system/init to move past connecting state
    const ws = await connectMockClaude(port, "no-timeout");
    await waitForMessage(ws);
    ws.send(systemInitMessage("no-timeout"));

    // Wait past timeout — should still be in init state, not disconnected
    await pollUntil(() => {
      const s = server?.listSessions()[0];
      return s?.state === "init";
    }, 1_000);

    await Bun.sleep(60);
    expect(server.listSessions()[0].state).toBe("init");
    expect(ms.killed).toBe(false);

    ws.close();
  });
});

// ── restoreSessions ──

describe("restoreSessions", () => {
  let server: ClaudeWsServer;

  afterEach(async () => {
    await server?.stop();
  });

  test("restores sessions into disconnected state", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

    const count = server.restoreSessions([
      {
        sessionId: "restored-1",
        pid: 9999,
        state: "idle",
        model: "claude-opus-4-6",
        cwd: "/test/dir",
        worktree: null,
        totalCost: 0.05,
        totalTokens: 1500,
      },
    ]);

    expect(count).toBe(1);
    expect(server.sessionCount).toBe(1);

    const sessions = server.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("restored-1");
    expect(sessions[0].state).toBe("disconnected");
    expect(sessions[0].model).toBe("claude-opus-4-6");
    expect(sessions[0].cwd).toBe("/test/dir");
    expect(sessions[0].cost).toBe(0.05);
    expect(sessions[0].tokens).toBe(1500);
    expect(sessions[0].processAlive).toBe(false);
    expect(sessions[0].wsConnected).toBe(false);
  });

  test("skips sessions already in the map", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    // Prepare a session normally
    server.prepareSession("existing-1", { prompt: "hello" });

    // Try to restore the same session ID
    const count = server.restoreSessions([
      {
        sessionId: "existing-1",
        pid: null,
        state: "connecting",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    expect(count).toBe(0);
    // Original session still there, only 1 total
    expect(server.sessionCount).toBe(1);
  });

  test("restored session accepts WS reconnection without resending prompt", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    const port = await server.start();

    server.restoreSessions([
      {
        sessionId: "reconnect-1",
        pid: null,
        state: "idle",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    // Simulate Claude CLI reconnecting — should NOT receive a prompt
    const ws = await connectMockClaude(port, "reconnect-1");
    // Negative assertion: race a real message against a 50ms deadline.
    const msg = await Promise.race([waitForMessage(ws), Bun.sleep(50).then((): null => null)]);
    expect(msg).toBeNull(); // No prompt sent on reconnect

    // Session should transition from disconnected → connecting
    const sessions = server.listSessions();
    const session = sessions.find((s) => s.sessionId === "reconnect-1");
    expect(session).toBeDefined();
    expect(session?.state).not.toBe("disconnected");
    expect(session?.wsConnected).toBe(true);

    ws.close();
  });

  test("reconnect is logged at info level, not error", async () => {
    const infos: string[] = [];
    const errors: string[] = [];
    const capturingLogger = {
      ...silentLogger,
      info: (...args: unknown[]) => infos.push(args.join(" ")),
      error: (...args: unknown[]) => errors.push(args.join(" ")),
    };
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: capturingLogger });
    const port = await server.start();

    server.restoreSessions([
      {
        sessionId: "log-level-1",
        pid: null,
        state: "idle",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    const ws = await connectMockClaude(port, "log-level-1");
    // Negative assertion: no observable condition to poll for — wait for handleOpen to finish.
    await Bun.sleep(50);

    // Reconnect should be logged at info, not error
    expect(infos.some((m) => m.includes("reconnected"))).toBe(true);
    expect(errors.some((m) => m.includes("reconnected"))).toBe(false);

    ws.close();
  });

  test("bye on restored session with pid sends SIGTERM to process", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

    server.restoreSessions([
      {
        sessionId: "orphan-kill-1",
        pid: 999999, // Non-existent PID — process.kill will throw ESRCH, which is caught
        state: "idle",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    // bye should not throw even though pid doesn't exist (ESRCH caught)
    const result = await server.bye("orphan-kill-1");
    expect(result).toEqual({ worktree: null, cwd: null, repoRoot: null });
    expect(server.sessionCount).toBe(0);
  });

  test("bye on restored session escalates to SIGKILL when SIGTERM is ignored", async () => {
    // Spawn a real process that traps SIGTERM (ignores it)
    const stubborn = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], { stdio: ["ignore", "ignore", "ignore"] });

    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, killTimeoutMs: 200, logger: silentLogger });
    await server.start();

    server.restoreSessions([
      {
        sessionId: "sigkill-restore-1",
        pid: stubborn.pid,
        state: "idle",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    // bye should escalate to SIGKILL and complete
    const result = await server.bye("sigkill-restore-1");
    expect(result).toEqual({ worktree: null, cwd: null, repoRoot: null });
    expect(server.sessionCount).toBe(0);

    // Process should be dead (SIGKILL can't be caught)
    const exitCode = await stubborn.exited;
    expect(exitCode).not.toBe(0);
  });

  test("bye on restored session with null pid does not throw", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

    server.restoreSessions([
      {
        sessionId: "null-pid-1",
        pid: null,
        state: "idle",
        model: null,
        cwd: null,
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
      },
    ]);

    const result = await server.bye("null-pid-1");
    expect(result).toEqual({ worktree: null, cwd: null, repoRoot: null });
    expect(server.sessionCount).toBe(0);
  });

  test("restores multiple sessions", async () => {
    server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
    await server.start();

    const count = server.restoreSessions([
      {
        sessionId: "multi-1",
        pid: 1001,
        state: "idle",
        model: "claude-sonnet-4-6",
        cwd: "/a",
        worktree: null,
        totalCost: 0.01,
        totalTokens: 100,
      },
      {
        sessionId: "multi-2",
        pid: 1002,
        state: "active",
        model: "claude-opus-4-6",
        cwd: "/b",
        worktree: "/b-wt",
        totalCost: 0.1,
        totalTokens: 5000,
      },
    ]);

    expect(count).toBe(2);
    expect(server.sessionCount).toBe(2);

    const sessions = server.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "multi-1");
    const s2 = sessions.find((s) => s.sessionId === "multi-2");
    expect(s1?.state).toBe("disconnected");
    expect(s2?.state).toBe("disconnected");
    expect(s2?.worktree).toBe("/b-wt");
  });

  // ── Session ID prefix matching ──

  describe("resolveSessionId", () => {
    test("exact match returns the session ID", async () => {
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
      await server.start();
      server.prepareSession("abc-123-full-id", { prompt: "test" });
      expect(server.resolveSessionId("abc-123-full-id")).toBe("abc-123-full-id");
    });

    test("unique prefix resolves to full session ID", async () => {
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
      await server.start();
      server.prepareSession("abc-123-full-id", { prompt: "test" });
      expect(server.resolveSessionId("abc-1")).toBe("abc-123-full-id");
      expect(server.resolveSessionId("abc")).toBe("abc-123-full-id");
    });

    test("ambiguous prefix throws with matching IDs", async () => {
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
      await server.start();
      server.prepareSession("abc-111", { prompt: "test" });
      server.prepareSession("abc-222", { prompt: "test" });
      expect(() => server?.resolveSessionId("abc")).toThrow(/Ambiguous session prefix "abc"/);
    });

    test("no match throws unknown session", async () => {
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
      await server.start();
      server.prepareSession("abc-123", { prompt: "test" });
      expect(() => server?.resolveSessionId("xyz")).toThrow(/Unknown session: xyz/);
    });

    test("prefix matching works for getStatus", async () => {
      server = new ClaudeWsServer({ spawn: mockSpawn().spawn, logger: silentLogger });
      await server.start();
      server.prepareSession("prefix-test-session-long-id", { prompt: "Hello" });

      // getStatus works with prefix even in "spawning" state
      const status = server.getStatus("prefix-test");
      expect(status.sessionId).toBe("prefix-test-session-long-id");
    });
  });

  // ── pendingImmediate: wait blocks on stale idle sessions (#985) ──

  describe("pendingImmediate prevents stale immediate returns (#985)", () => {
    test("waitForEvent returns immediately for newly idle session", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      const port = await server.start();

      server.prepareSession("s-new", { prompt: "Hello" });
      server.spawnClaude("s-new");

      const ws = await connectMockClaude(port, "s-new");
      try {
        await waitForMessage(ws);
        ws.send(systemInitMessage("s-new"));
        ws.send(resultMessage("s-new"));
        await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

        // First wait should return immediately — the idle event is pending
        const event = await server.waitForEvent("s-new", 1000);
        expect(event.event).toBe("session:result");
        expect(event.sessionId).toBe("s-new");
      } finally {
        ws.close();
      }
    });

    test("second waitForEvent blocks after idle already reported", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      const port = await server.start();

      server.prepareSession("s-stale", { prompt: "Hello" });
      server.spawnClaude("s-stale");

      const ws = await connectMockClaude(port, "s-stale");
      try {
        await waitForMessage(ws);
        ws.send(systemInitMessage("s-stale"));
        ws.send(resultMessage("s-stale"));
        await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

        // First wait returns immediately (consumes the pending flag)
        await server.waitForEvent("s-stale", 500);

        // Second wait should timeout — the idle state is stale
        await expect(server.waitForEvent("s-stale", 200)).rejects.toThrow(WaitTimeoutError);
      } finally {
        ws.close();
      }
    });

    test("restored sessions do not trigger immediate return", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      // Restore a session as disconnected (simulates daemon restart)
      server.restoreSessions([
        {
          sessionId: "s-restored",
          pid: null,
          state: "disconnected",
          model: "claude-sonnet-4-6",
          cwd: "/test",
          worktree: null,
          totalCost: 0.5,
          totalTokens: 1000,
        },
      ]);

      // Wait should timeout — restored sessions have pendingImmediate=false
      // (they're also disconnected, so validateWaitTarget may reject,
      // but this test confirms the pendingImmediate flag is false)
      await expect(server.waitForEvent("s-restored", 200)).rejects.toThrow(/disconnected/);
    });

    test("waitForEvent with null sessionId blocks when all idle sessions already reported", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      const port = await server.start();

      server.prepareSession("s-any", { prompt: "Hello" });
      server.spawnClaude("s-any");

      const ws = await connectMockClaude(port, "s-any");
      try {
        await waitForMessage(ws);
        ws.send(systemInitMessage("s-any"));
        ws.send(resultMessage("s-any"));
        await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

        // First wait (any session) — returns immediately
        const event = await server.waitForEvent(null, 500);
        expect(event.event).toBe("session:result");

        // Second wait (any session) — should timeout since the idle is stale
        await expect(server.waitForEvent(null, 200)).rejects.toThrow(WaitTimeoutError);
      } finally {
        ws.close();
      }
    });

    test("event waiter delivery clears pendingImmediate flag", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      const port = await server.start();

      server.prepareSession("s-waiter", { prompt: "Hello" });
      server.spawnClaude("s-waiter");

      const ws = await connectMockClaude(port, "s-waiter");
      try {
        await waitForMessage(ws);
        ws.send(systemInitMessage("s-waiter"));

        // Start waiting BEFORE the result arrives
        const waitPromise = server.waitForEvent("s-waiter", 5000);

        // Now send the result — the waiter should be resolved
        ws.send(resultMessage("s-waiter"));
        const event = await waitPromise;
        expect(event.event).toBe("session:result");

        // Next wait should timeout — the event was delivered to the waiter
        await expect(server.waitForEvent("s-waiter", 200)).rejects.toThrow(WaitTimeoutError);
      } finally {
        ws.close();
      }
    });
  });

  // ── Work item event support ──

  describe("work item events", () => {
    test("waitForWorkItemEvent resolves on dispatched event", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      const promise = server.waitForWorkItemEvent(null, false, 5000);

      // Dispatch a work item event
      server.dispatchWorkItemEvent({ type: "checks:passed", prNumber: 42 });

      const result = await promise;
      expect(result.source).toBe("work_item");
      expect(result.workItemEvent.type).toBe("checks:passed");
      expect("prNumber" in result.workItemEvent && result.workItemEvent.prNumber).toBe(42);
    });

    test("waitForWorkItemEvent filters by PR number", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      // Wait for PR #42 specifically
      const promise = server.waitForWorkItemEvent(42, false, 5000);

      // Dispatch event for wrong PR — should NOT resolve
      server.dispatchWorkItemEvent({ type: "checks:passed", prNumber: 99 });

      // Dispatch event for correct PR — should resolve
      server.dispatchWorkItemEvent({ type: "pr:merged", prNumber: 42, mergeSha: null });

      const result = await promise;
      expect(result.workItemEvent.type).toBe("pr:merged");
      expect("prNumber" in result.workItemEvent && result.workItemEvent.prNumber).toBe(42);
    });

    test("waitForWorkItemEvent filters checks-only events", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      // Wait for checks events only
      const promise = server.waitForWorkItemEvent(null, true, 5000);

      // Dispatch non-checks event — should NOT resolve
      server.dispatchWorkItemEvent({ type: "pr:merged", prNumber: 42, mergeSha: null });

      // Dispatch checks event — should resolve
      server.dispatchWorkItemEvent({ type: "checks:failed", prNumber: 42, failedJob: "test" });

      const result = await promise;
      expect(result.workItemEvent.type).toBe("checks:failed");
    });

    test("waitForWorkItemEvent times out", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      await expect(server.waitForWorkItemEvent(null, false, 100)).rejects.toThrow(WaitTimeoutError);
    });

    test("waitForWorkItemEvent with PR filter and checks-only", async () => {
      const ms = mockSpawn();
      server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
      await server.start();

      const promise = server.waitForWorkItemEvent(42, true, 5000);

      // Wrong PR, right type — no match
      server.dispatchWorkItemEvent({ type: "checks:passed", prNumber: 99 });
      // Right PR, wrong type — no match
      server.dispatchWorkItemEvent({ type: "pr:merged", prNumber: 42, mergeSha: null });
      // Right PR, right type — match
      server.dispatchWorkItemEvent({ type: "checks:passed", prNumber: 42 });

      const result = await promise;
      expect(result.workItemEvent.type).toBe("checks:passed");
      expect("prNumber" in result.workItemEvent && result.workItemEvent.prNumber).toBe(42);
    });
  });
});

// ── publishSessionMonitorEvent mapping (#1567) ──

describe("monitor event mapping", () => {
  type WsServerPrivate = {
    publishSessionMonitorEvent: (sessionId: string, event: SessionEvent) => void;
    publishWorkItemMonitorEvent: (event: WorkItemEvent) => void;
  };

  function makeServer(): ClaudeWsServer {
    return new ClaudeWsServer({ logger: silentLogger });
  }

  function collect(server: ClaudeWsServer): MonitorEventInput[] {
    const events: MonitorEventInput[] = [];
    server.onMonitorEvent = (input) => events.push(input);
    return events;
  }

  function priv(server: ClaudeWsServer): WsServerPrivate {
    return server as unknown as WsServerPrivate;
  }

  describe("publishSessionMonitorEvent", () => {
    test("session:result emits session.result + session.idle with cost/tokens/numTurns/resultPreview", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s1", {
        type: "session:result",
        cost: 0.42,
        tokens: 1234,
        numTurns: 3,
        result: "done",
      });

      expect(events).toHaveLength(2);

      const resultEvt = events[0];
      expect(resultEvt.src).toBe("daemon.claude-server");
      expect(resultEvt.event).toBe("session.result");
      expect(resultEvt.category).toBe("session");
      expect(resultEvt.sessionId).toBe("s1");
      expect(resultEvt.cost).toBe(0.42);
      expect(resultEvt.tokens).toBe(1234);
      expect(resultEvt.numTurns).toBe(3);
      expect(resultEvt.result).toBe("done");
      expect(resultEvt.resultPreview).toBe("done");

      const idleEvt = events[1];
      expect(idleEvt.src).toBe("daemon.claude-server");
      expect(idleEvt.event).toBe("session.idle");
      expect(idleEvt.category).toBe("session");
      expect(idleEvt.sessionId).toBe("s1");
      expect(idleEvt.cost).toBe(0.42);
      expect(idleEvt.tokens).toBe(1234);
      expect(idleEvt.numTurns).toBe(3);
      expect(idleEvt.resultPreview).toBe("done");
      expect(idleEvt.result).toBeUndefined();
    });

    test("resultPreview truncates long result to ≤200 chars with ellipsis", () => {
      const server = makeServer();
      const events = collect(server);
      const longResult = "a".repeat(300);

      priv(server).publishSessionMonitorEvent("s1a", {
        type: "session:result",
        cost: 0,
        tokens: 0,
        numTurns: 1,
        result: longResult,
      });

      const preview = events[0].resultPreview as string;
      expect(preview.length).toBe(200);
      expect(preview.endsWith("…")).toBe(true);
      expect(preview.slice(0, 199)).toBe("a".repeat(199));
    });

    test("resultPreview collapses newlines to spaces", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s1b", {
        type: "session:result",
        cost: 0,
        tokens: 0,
        numTurns: 1,
        result: "line one\nline two\nline three",
      });

      expect(events[0].resultPreview).toBe("line one line two line three");
      expect(events[1].resultPreview).toBe("line one line two line three");
    });

    test("session:result with empty result preserves empty resultPreview on both events", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s1c", {
        type: "session:result",
        cost: 1.0,
        tokens: 500,
        numTurns: 5,
        result: "",
      });

      expect(events).toHaveLength(2);
      // empty string is falsy but still a string — resultPreview is ""
      expect(events[0].resultPreview).toBe("");
      expect(events[1].resultPreview).toBe("");
      // cost/tokens/numTurns present on idle
      expect(events[1].cost).toBe(1.0);
      expect(events[1].tokens).toBe(500);
      expect(events[1].numTurns).toBe(5);
      expect(events[1].result).toBeUndefined();
    });

    test("session:ended maps to session.ended with no extra fields", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s2", { type: "session:ended" });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.ended");
      expect(events[0].cost).toBeUndefined();
      expect(events[0].tokens).toBeUndefined();
    });

    test("session:containment_warning maps with strikes and reason", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s3", {
        type: "session:containment_warning",
        toolName: "bash",
        reason: "not allowed",
        strikes: 2,
      });

      expect(events[0].event).toBe("session.containment_warning");
      expect(events[0].strikes).toBe(2);
      expect(events[0].reason).toBe("not allowed");
    });

    test("session:permission_request extracts toolName from request.tool_name", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s4", {
        type: "session:permission_request",
        requestId: "req1",
        request: { tool_name: "bash", input: {} } as never,
      });

      expect(events[0].event).toBe("session.permission_request");
      expect(events[0].toolName).toBe("bash");
    });

    test("unmapped session event type is silently dropped", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s5", {
        type: "session:response",
        message: {} as never,
      });

      expect(events).toHaveLength(0);
    });

    test("null onMonitorEvent callback causes silent drop", () => {
      const server = makeServer();
      server.onMonitorEvent = null;

      expect(() => {
        priv(server).publishSessionMonitorEvent("s6", { type: "session:ended" });
      }).not.toThrow();
    });

    test("session:error maps to session.error with errors and cost", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s7", {
        type: "session:error",
        errors: ["timeout", "parse error"],
        cost: 0.01,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.error");
      expect(events[0].category).toBe("session");
      expect(events[0].errors).toEqual(["timeout", "parse error"]);
      expect(events[0].cost).toBe(0.01);
    });

    test("session:cleared maps to session.cleared with no extra fields", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s8", { type: "session:cleared" });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.cleared");
      expect(events[0].cost).toBeUndefined();
      expect(events[0].errors).toBeUndefined();
    });

    test("session:model_changed maps to session.model_changed with model field", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s9", {
        type: "session:model_changed",
        model: "claude-opus-4-7",
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.model_changed");
      expect(events[0].model).toBe("claude-opus-4-7");
    });

    test("session:rate_limited does not emit duplicate session event (worker.ratelimited is canonical)", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s10", {
        type: "session:rate_limited",
        sessionId: "s10",
      });

      expect(events).toHaveLength(0);
    });

    test("session:disconnected maps to session.disconnected with reason", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s11", {
        type: "session:disconnected",
        reason: "network error",
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.disconnected");
      expect(events[0].reason).toBe("network error");
    });

    test("session:containment_denied maps with strikes and reason", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s12", {
        type: "session:containment_denied",
        toolName: "bash",
        reason: "blocked",
        strikes: 3,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.containment_denied");
      expect(events[0].category).toBe("session");
      expect(events[0].strikes).toBe(3);
      expect(events[0].reason).toBe("blocked");
    });

    test("session:containment_escalated maps with strikes and reason", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s13", {
        type: "session:containment_escalated",
        toolName: "bash",
        reason: "escalated",
        strikes: 5,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.containment_escalated");
      expect(events[0].category).toBe("session");
      expect(events[0].strikes).toBe(5);
      expect(events[0].reason).toBe("escalated");
    });

    test("session:containment_reset maps with strikes and reason", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishSessionMonitorEvent("s14", {
        type: "session:containment_reset",
        toolName: "bash",
        reason: "operator reset",
        strikes: 0,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("session.containment_reset");
      expect(events[0].category).toBe("session");
      expect(events[0].strikes).toBe(0);
      expect(events[0].reason).toBe("operator reset");
    });
  });

  describe("publishWorkItemMonitorEvent", () => {
    test("pr:opened maps to pr.opened with prNumber", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({
        type: "pr:opened",
        prNumber: 42,
        branch: "feat/test",
        base: "main",
        commits: 3,
        srcChurn: 100,
      });

      expect(events).toHaveLength(1);
      expect(events[0].src).toBe("daemon.work-item-poller");
      expect(events[0].event).toBe("pr.opened");
      expect(events[0].category).toBe("work_item");
      expect(events[0].prNumber).toBe(42);
    });

    test("checks:failed maps to checks.failed with failedJob", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "checks:failed", prNumber: 7, failedJob: "typecheck" });

      expect(events[0].event).toBe("checks.failed");
      expect(events[0].prNumber).toBe(7);
      expect(events[0].failedJob).toBe("typecheck");
    });

    test("review:changes_requested maps with reviewer", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "review:changes_requested", prNumber: 99, reviewer: "alice" });

      expect(events[0].event).toBe("review.changes_requested");
      expect(events[0].reviewer).toBe("alice");
    });

    test("phase:changed maps itemId to workItemId with from/to", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "phase:changed", itemId: "wi-123", from: "impl", to: "review" });

      expect(events[0].event).toBe("phase.changed");
      expect(events[0].workItemId).toBe("wi-123");
      expect(events[0].from).toBe("impl");
      expect(events[0].to).toBe("review");
    });

    test("unmapped work-item event type is silently dropped", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "unknown:event" } as never);

      expect(events).toHaveLength(0);
    });

    test("null onMonitorEvent callback causes silent drop", () => {
      const server = makeServer();
      server.onMonitorEvent = null;

      expect(() => {
        priv(server).publishWorkItemMonitorEvent({ type: "pr:merged", prNumber: 1, mergeSha: null });
      }).not.toThrow();
    });

    test("pr:merged maps to pr.merged with prNumber", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "pr:merged", prNumber: 55, mergeSha: "abc123" });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("pr.merged");
      expect(events[0].category).toBe("work_item");
      expect(events[0].prNumber).toBe(55);
      expect(events[0].mergeSha).toBe("abc123");
    });

    test("pr:opened forwards enriched fields", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({
        type: "pr:opened",
        prNumber: 42,
        branch: "feat/my-feature",
        base: "main",
        commits: 3,
        srcChurn: 120,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("pr.opened");
      expect(events[0].branch).toBe("feat/my-feature");
      expect(events[0].base).toBe("main");
      expect(events[0].commits).toBe(3);
      expect(events[0].srcChurn).toBe(120);
    });

    test("pr:pushed maps to pr.pushed with enriched fields", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({
        type: "pr:pushed",
        prNumber: 42,
        branch: "feat/my-feature",
        base: "main",
        commits: 5,
        srcChurn: 200,
      });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("pr.pushed");
      expect(events[0].prNumber).toBe(42);
      expect(events[0].branch).toBe("feat/my-feature");
      expect(events[0].commits).toBe(5);
      expect(events[0].srcChurn).toBe(200);
    });

    test("pr:closed maps to pr.closed with prNumber", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "pr:closed", prNumber: 77 });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("pr.closed");
      expect(events[0].prNumber).toBe(77);
    });

    test("checks:started maps to checks.started with prNumber and runId", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "checks:started", prNumber: 12, runId: 9876 });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("checks.started");
      expect(events[0].prNumber).toBe(12);
      expect(events[0].runId).toBe(9876);
    });

    test("checks:started without runId emits no runId field", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "checks:started", prNumber: 13 });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("checks.started");
      expect(events[0].prNumber).toBe(13);
      expect(events[0].runId).toBeUndefined();
    });

    test("checks:passed maps to checks.passed with prNumber", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "checks:passed", prNumber: 33 });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("checks.passed");
      expect(events[0].prNumber).toBe(33);
    });

    test("review:approved maps to review.approved with prNumber", () => {
      const server = makeServer();
      const events = collect(server);

      priv(server).publishWorkItemMonitorEvent({ type: "review:approved", prNumber: 44 });

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("review.approved");
      expect(events[0].prNumber).toBe(44);
    });
  });
});

// ── Stuck detector integration (#1585) ──

describe("stuck detector integration", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("session.stuck fires after stall threshold", async () => {
    const spawnState = mockSpawn();
    const monitorEvents: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: spawnState.spawn,
      logger: silentLogger,
      stuckConfig: { thresholdsMs: [100, 200, 300], repeatMs: 300 },
    });
    server.onMonitorEvent = (input) => monitorEvents.push(input);

    const port = await server.start();
    const sessionId = "stuck-test-1";
    server.prepareSession(sessionId, { prompt: "test", permissionStrategy: "auto" });
    server.spawnClaude(sessionId);

    // Connect and drive to active state
    const ws = await connectMockClaude(port, sessionId);
    await waitForMessage(ws);
    ws.send(systemInitMessage(sessionId));
    ws.send(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    // Now session is active — wait for stuck event
    await pollUntil(() => monitorEvents.some((e) => e.event === "session.stuck"), 2000);

    const stuckEvt = monitorEvents.find((e) => e.event === "session.stuck");
    expect(stuckEvt).toBeDefined();
    expect(stuckEvt?.tier).toBe(1);
    expect(stuckEvt?.sessionId).toBe(sessionId);
    expect(typeof stuckEvt?.sinceMs).toBe("number");

    ws.close();
  });

  test("no timer leak after session:result", async () => {
    const spawnState = mockSpawn();
    const monitorEvents: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: spawnState.spawn,
      logger: silentLogger,
      stuckConfig: { thresholdsMs: [100, 200, 300], repeatMs: 300 },
    });
    server.onMonitorEvent = (input) => monitorEvents.push(input);

    const port = await server.start();
    const sessionId = "stuck-leak-test";
    server.prepareSession(sessionId, { prompt: "test", permissionStrategy: "auto" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    await waitForMessage(ws);
    ws.send(systemInitMessage(sessionId));
    ws.send(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    // Send result — session goes idle, stuck detector should be disposed
    ws.send(resultMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "idle"));

    const stuckBefore = monitorEvents.filter((e) => e.event === "session.stuck").length;

    // Wait past all thresholds — no stuck events should fire
    await Bun.sleep(400);
    const stuckAfter = monitorEvents.filter((e) => e.event === "session.stuck").length;
    expect(stuckAfter).toBe(stuckBefore);

    ws.close();
  });

  test("no timer leak after session:ended via bye", async () => {
    const spawnState = mockSpawn();
    const monitorEvents: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: spawnState.spawn,
      logger: silentLogger,
      stuckConfig: { thresholdsMs: [150, 300, 450], repeatMs: 450 },
    });
    server.onMonitorEvent = (input) => monitorEvents.push(input);

    const port = await server.start();
    const sessionId = "stuck-bye-test";
    server.prepareSession(sessionId, { prompt: "test", permissionStrategy: "auto" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    await waitForMessage(ws);
    ws.send(systemInitMessage(sessionId));
    ws.send(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    // End session via bye — terminateSession disposes detector
    await server.bye(sessionId);

    const stuckBefore = monitorEvents.filter((e) => e.event === "session.stuck").length;
    await Bun.sleep(400);
    const stuckAfter = monitorEvents.filter((e) => e.event === "session.stuck").length;
    expect(stuckAfter).toBe(stuckBefore);

    ws.close();
  });

  test("stuck event includes workItemId from session config", async () => {
    const spawnState = mockSpawn();
    const monitorEvents: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: spawnState.spawn,
      logger: silentLogger,
      stuckConfig: { thresholdsMs: [80, 160, 240], repeatMs: 240 },
    });
    server.onMonitorEvent = (input) => monitorEvents.push(input);

    const port = await server.start();
    const sessionId = "stuck-wi-test";
    server.prepareSession(sessionId, {
      prompt: "test",
      permissionStrategy: "auto",
      worktree: "/tmp/wt-1585",
    });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    await waitForMessage(ws);
    ws.send(systemInitMessage(sessionId));
    ws.send(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    await pollUntil(() => monitorEvents.some((e) => e.event === "session.stuck"), 2000);

    const stuckEvt = monitorEvents.find((e) => e.event === "session.stuck");
    expect(stuckEvt?.workItemId).toBe("/tmp/wt-1585");

    ws.close();
  });

  test("waitForEvent resolves with stuck diagnostic fields", async () => {
    const spawnState = mockSpawn();
    server = new ClaudeWsServer({
      spawn: spawnState.spawn,
      logger: silentLogger,
      stuckConfig: { thresholdsMs: [80, 160, 240], repeatMs: 240 },
    });

    const port = await server.start();
    const sessionId = "stuck-waiter-test";
    server.prepareSession(sessionId, { prompt: "test", permissionStrategy: "auto" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    await waitForMessage(ws);
    ws.send(systemInitMessage(sessionId));
    ws.send(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active"));

    const waitedEvent = await server.waitForEvent(sessionId, 2000);
    expect(waitedEvent.event).toBe("session:stuck");
    expect(typeof waitedEvent.tier).toBe("number");
    expect(typeof waitedEvent.sinceMs).toBe("number");
    expect(typeof waitedEvent.tokenDelta).toBe("number");

    ws.close();
  });
});

// ── #1836: parallel spawn race ──

describe("parallel spawn (#1836)", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("prepareSession pre-populates state.cwd from config", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("cwd-pre-pop", { prompt: "Hello", cwd: "/my/worktree" });
    const sessions = server.listSessions();
    expect(sessions[0].cwd).toBe("/my/worktree");
  });

  test("removeUnspawnedSession removes session from map", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.prepareSession("dead-session", { prompt: "Hello", cwd: "/tmp/wt" });
    expect(server.listSessions()).toHaveLength(1);

    server.removeUnspawnedSession("dead-session");
    expect(server.listSessions()).toHaveLength(0);
  });

  test("removeUnspawnedSession is no-op for unknown session", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn, logger: silentLogger });
    await server.start();

    server.removeUnspawnedSession("nonexistent");
    expect(server.listSessions()).toHaveLength(0);
  });

  test("3 sessions prepared before any spawn — all coexist with cwd set (#1836)", async () => {
    let spawnCount = 0;
    const spawnFn: SpawnFn = () => {
      spawnCount++;
      const pid = 10000 + spawnCount;
      let resolveExited: ((code: number) => void) | undefined;
      let killed = false;
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });
      return {
        pid,
        exited,
        kill: () => {
          if (killed) return;
          killed = true;
          resolveExited?.(0);
        },
      };
    };
    server = new ClaudeWsServer({ spawn: spawnFn, logger: silentLogger });
    const port = await server.start();

    const sessionIds = ["s-parallel-1", "s-parallel-2", "s-parallel-3"];

    // Prepare all sessions before spawning any — mirrors the interleaved ordering
    // that occurs during parallel `mcx claude spawn` calls (#1836).
    for (const id of sessionIds) {
      server.prepareSession(id, {
        prompt: `Task for ${id}`,
        cwd: `/worktree/${id}`,
        worktree: id,
      });
    }
    for (const id of sessionIds) {
      server.spawnClaude(id);
    }

    expect(server.listSessions()).toHaveLength(3);

    // All sessions should show cwd from config (not null)
    for (const info of server.listSessions()) {
      expect(info.cwd).not.toBeNull();
      expect(info.state).toBe("connecting");
    }

    // Connect each mock client sequentially to avoid message-delivery race
    // in the test harness (server sends user message on open; if we
    // Promise.all the connections, a message can arrive before the next
    // waitForMessage sets its handler).
    const wsConnections: WebSocket[] = [];
    for (const id of sessionIds) {
      const ws = await connectMockClaude(port, id);
      const msg = await waitForMessage(ws);
      expect(msg).toContain('"type":"user"');
      wsConnections.push(ws);
    }

    // Send system/init from all 3 and verify they all reach init state
    for (let i = 0; i < sessionIds.length; i++) {
      wsConnections[i].send(systemInitMessage(sessionIds[i]));
    }
    await pollUntil(() => {
      const sessions = server?.listSessions() ?? [];
      return sessions.every((s) => s.state === "init");
    }, 2_000);

    const sessions = server.listSessions();
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      expect(s.state).toBe("init");
      expect(s.cwd).not.toBeNull();
    }

    for (const ws of wsConnections) ws.close();
  });

  test("spawnClaude failure — removeUnspawnedSession cleans up ghost", async () => {
    const failingSpawn: SpawnFn = () => {
      throw new Error("spawn failed: too many processes");
    };
    server = new ClaudeWsServer({ spawn: failingSpawn, logger: silentLogger });
    await server.start();

    server.prepareSession("fail-session", { prompt: "Hello", cwd: "/tmp/wt" });
    expect(server.listSessions()).toHaveLength(1);

    // spawnClaude should throw — caller (handlePrompt) catches and cleans up
    const srv = server;
    expect(() => srv?.spawnClaude("fail-session")).toThrow("spawn failed");

    // Session is still in map until caller cleans up
    expect(server.listSessions()).toHaveLength(1);

    server.removeUnspawnedSession("fail-session");
    expect(server.listSessions()).toHaveLength(0);
  });
});
