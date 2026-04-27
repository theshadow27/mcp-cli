/**
 * Integration tests for session.result / session.idle enrichment (#1660).
 *
 * These tests drive the full WS message path (mock Claude → ws-server state
 * machine → publishSessionMonitorEvent → onMonitorEvent callback → EventBus)
 * to verify that cost, tokens, numTurns, and resultPreview are correctly
 * populated on both events when a real result message arrives.
 *
 * Contrast with the unit tests in ws-server.spec.ts that call
 * publishSessionMonitorEvent() directly — those don't exercise the message
 * parsing and state-machine path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorEvent } from "@mcp-cli/core";
import { silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../../test/harness";
import { EventBus } from "../event-bus";
import { serialize } from "./ndjson";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

// ── Mock spawn (no real Claude process; resolves exited on kill) ──

function mockSpawn(): SpawnFn {
  return ((_cmd: string[], _opts: unknown) => {
    let exitResolve: (code: number) => void = () => {};
    return {
      pid: 99999,
      exited: new Promise<number>((r) => {
        exitResolve = r;
      }),
      kill: () => exitResolve(143),
    };
  }) as SpawnFn;
}

// ── Mock Claude WS client helpers ──

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

// ── Message builders ──

function systemInitMessage(sessionId: string): string {
  return serialize({
    type: "system",
    subtype: "init",
    cwd: "/test",
    session_id: sessionId,
    tools: ["Read"],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
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
      content: [{ type: "text", text: "Working on it." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
    uuid: "test-uuid",
    session_id: sessionId,
  });
}

function resultMessage(sessionId: string, result: string, costUsd: number, numTurns: number): string {
  return serialize({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: numTurns,
    total_cost_usd: costUsd,
    usage: { input_tokens: 0, output_tokens: 0 },
    uuid: "test-uuid",
    session_id: sessionId,
  });
}

// ── Collect EventBus events by type ──

function collectByType(bus: EventBus): { result: MonitorEvent[]; idle: MonitorEvent[] } {
  const collected = { result: [] as MonitorEvent[], idle: [] as MonitorEvent[] };
  bus.subscribe((e) => {
    if (e.event === "session.result") collected.result.push(e);
    else if (e.event === "session.idle") collected.idle.push(e);
  });
  return collected;
}

// ── Tests ──

describe("session.result/session.idle enrichment (integration)", () => {
  let server: ClaudeWsServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("real WS result message produces session.result + session.idle with enriched fields", async () => {
    const bus = new EventBus();
    const events = collectByType(bus);

    server = new ClaudeWsServer({ spawn: mockSpawn(), logger: silentLogger });
    server.onMonitorEvent = (input) => bus.publish(input);

    const port = await server.start();
    const sessionId = "enrich-test-1";

    server.prepareSession(sessionId, { prompt: "test prompt" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    try {
      await waitForMessage(ws); // initial user message

      // Drive the full session lifecycle: init → assistant turn → result
      ws.send(systemInitMessage(sessionId));
      ws.send(assistantMessage(sessionId)); // accumulates 150 tokens
      ws.send(resultMessage(sessionId, "task done", 0.042, 3));

      await pollUntil(() => events.idle.length >= 1, 5000);
    } finally {
      ws.close();
    }

    expect(events.result).toHaveLength(1);
    expect(events.idle).toHaveLength(1);

    const re = events.result[0];
    const ie = events.idle[0];

    // session.result must carry all enriched fields
    expect(re.cost).toBe(0.042);
    expect(re.tokens).toBe(150); // 100 + 50 from assistant message
    expect(re.numTurns).toBe(3);
    expect(re.result).toBe("task done");
    expect(re.resultPreview).toBe("task done");
    expect(re.sessionId).toBe(sessionId);
    expect(re.category).toBe("session");

    // session.idle must carry cost/tokens/numTurns/resultPreview but NOT result
    expect(ie.cost).toBe(0.042);
    expect(ie.tokens).toBe(150);
    expect(ie.numTurns).toBe(3);
    expect(ie.resultPreview).toBe("task done");
    expect(ie.result).toBeUndefined();
    expect(ie.sessionId).toBe(sessionId);
    expect(ie.category).toBe("session");
  });

  test("long result is truncated in resultPreview (≤200 chars with ellipsis) on both events", async () => {
    const bus = new EventBus();
    const events = collectByType(bus);

    server = new ClaudeWsServer({ spawn: mockSpawn(), logger: silentLogger });
    server.onMonitorEvent = (input) => bus.publish(input);

    const port = await server.start();
    const sessionId = "enrich-test-2";

    server.prepareSession(sessionId, { prompt: "test" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    try {
      await waitForMessage(ws);

      const longResult = "x".repeat(300);
      ws.send(systemInitMessage(sessionId));
      ws.send(resultMessage(sessionId, longResult, 0.001, 1));

      await pollUntil(() => events.idle.length >= 1, 5000);
    } finally {
      ws.close();
    }

    expect(events.result).toHaveLength(1);
    expect(events.idle).toHaveLength(1);

    const re = events.result[0];
    const ie = events.idle[0];

    // Full result is preserved on session.result
    expect(re.result).toBe("x".repeat(300));

    // Preview is truncated on both events
    const rePreview = re.resultPreview as string;
    const iePreview = ie.resultPreview as string;

    expect(rePreview.length).toBe(200);
    expect(rePreview.endsWith("…")).toBe(true);

    expect(iePreview.length).toBe(200);
    expect(iePreview.endsWith("…")).toBe(true);
    expect(ie.result).toBeUndefined();
  });

  test("multiline result has newlines collapsed to spaces in resultPreview", async () => {
    const bus = new EventBus();
    const events = collectByType(bus);

    server = new ClaudeWsServer({ spawn: mockSpawn(), logger: silentLogger });
    server.onMonitorEvent = (input) => bus.publish(input);

    const port = await server.start();
    const sessionId = "enrich-test-3";

    server.prepareSession(sessionId, { prompt: "test" });
    server.spawnClaude(sessionId);

    const ws = await connectMockClaude(port, sessionId);
    try {
      await waitForMessage(ws);

      ws.send(systemInitMessage(sessionId));
      ws.send(resultMessage(sessionId, "line one\nline two\nline three", 0.001, 1));

      await pollUntil(() => events.idle.length >= 1, 5000);
    } finally {
      ws.close();
    }

    expect(events.result).toHaveLength(1);
    expect(events.idle).toHaveLength(1);

    expect(events.result[0].resultPreview).toBe("line one line two line three");
    expect(events.idle[0].resultPreview).toBe("line one line two line three");
  });
});
