import { afterEach, describe, expect, mock, test } from "bun:test";
import { serialize } from "./ndjson";
import type { SessionEvent } from "./session-state";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer, WaitTimeoutError, summarizeInput } from "./ws-server";

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

      // Send system/init
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(50);

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

      // Send system/init + assistant + result
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);
      ws.send(assistantMessage("test-session"));
      await Bun.sleep(20);
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

      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      // Set up message listener before sending can_use_tool
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
      await Bun.sleep(20);

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
      await Bun.sleep(20);

      const transcript = server.getTranscript("test-session");
      // Should have at least: outbound user message + inbound system/init
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
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);
      ws.send(assistantMessage("test-session"));
      await Bun.sleep(20);

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

      // system/init to move to init state
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      // Send result to move to idle
      ws.send(resultMessage("test-session"));
      await Bun.sleep(20);

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

  test("process exit resolves waiters with error", async () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("test-session", { prompt: "Hello" });
    server.spawnClaude("test-session");

    const resultPromise = server.waitForResult("test-session", 5000);

    // Simulate process exit
    ms.exitResolve(0);

    try {
      await resultPromise;
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("exited before producing a result");
    }
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

      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      // Send can_use_tool — delegate strategy won't auto-respond
      ws.send(canUseToolMessage("req-perm-1"));
      await Bun.sleep(20);

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
      await Bun.sleep(20);

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

      // Start waiting for event
      const eventPromise = server.waitForEvent("test-session", 5000);

      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);
      ws.send(assistantMessage("test-session"));
      await Bun.sleep(20);
      ws.send(resultMessage("test-session"));

      const event = await eventPromise;
      expect(event.sessionId).toBe("test-session");
      expect(event.event).toBe("session:result");
      expect(event.cost).toBe(0.01);
      expect(event.result).toBe("Done!");
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
      await Bun.sleep(20);
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
      await Bun.sleep(20);

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
    server.bye("test-session");

    await expect(eventPromise).rejects.toThrow("Session ended by user");
  });

  test("bye returns worktree info", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("wt-session", { prompt: "Hello", worktree: "claude-test1", cwd: "/repo" });
    server.spawnClaude("wt-session");

    const result = server.bye("wt-session");
    expect(result).toEqual({ worktree: "claude-test1", cwd: "/repo" });
  });

  test("bye returns null worktree for non-worktree session", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    server.prepareSession("plain-session", { prompt: "Hello" });
    server.spawnClaude("plain-session");

    const result = server.bye("plain-session");
    expect(result).toEqual({ worktree: null, cwd: null });
  });

  test("sessionCount tracks active sessions", () => {
    const ms = mockSpawn();
    server = new ClaudeWsServer({ spawn: ms.spawn });
    server.start();

    expect(server.sessionCount).toBe(0);

    server.prepareSession("s1", { prompt: "Hello" });
    expect(server.sessionCount).toBe(1);

    server.prepareSession("s2", { prompt: "World" });
    expect(server.sessionCount).toBe(2);

    server.bye("s1");
    expect(server.sessionCount).toBe(1);

    server.bye("s2");
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
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      ws.send(canUseToolMessage("req-detail-1"));
      await Bun.sleep(20);

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
      ws.send(systemInitMessage("test-session"));
      await Bun.sleep(20);

      ws.send(canUseToolMessage("req-clear-1"));
      await Bun.sleep(20);

      // Approve it
      server.respondToPermission("test-session", "req-clear-1", true);
      await Bun.sleep(20);

      const sessions = server.listSessions();
      const session = sessions.find((s) => s.sessionId === "test-session");
      expect(session?.pendingPermissions).toBe(0);
      expect(session?.pendingPermissionDetails).toHaveLength(0);
    } finally {
      ws.close();
    }
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
