/**
 * Integration test: session.result carries cost+preview via /events SSE (#1681).
 *
 * Exercises the full cross-thread dispatch path:
 *   WS message → ws-server (Bun Worker) → postMessage → main thread
 *   → EventBus → GET /events NDJSON stream
 *
 * Contrast: ws-server-enrichment.spec.ts tests WS→EventBus in the same
 * thread (no worker, no cross-thread messaging, no SSE stream). This test
 * is the only way to catch regressions in the worker→main postMessage bridge.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type TestDaemon, createTestDir, rpc, startTestDaemon } from "./harness";

setDefaultTimeout(30_000);

// ---------------------------------------------------------------------------
// Test suite — single shared daemon to avoid per-test startup overhead
// ---------------------------------------------------------------------------

let daemon: TestDaemon | undefined;

beforeAll(async () => {
  const dir = createTestDir();

  // Create a fake "claude" binary that delegates to mock-claude.ts
  const mockBinDir = join(dir, "bin");
  mkdirSync(mockBinDir, { recursive: true });
  const mockClaudePath = resolve("test/mock-claude.ts");
  const claudeScript = join(mockBinDir, "claude");
  writeFileSync(claudeScript, `#!/bin/sh\nexec bun "${mockClaudePath}" "$@"\n`);
  chmodSync(claudeScript, 0o755);

  daemon = await startTestDaemon({}, { dir, pathPrefix: mockBinDir });
});

afterAll(async () => {
  await daemon?.kill();
});

describe("session.result via /events — cross-thread integration (#1681)", () => {
  test("session.result + session.idle events carry enriched fields end-to-end", async () => {
    if (!daemon) throw new Error("daemon not started");

    // Subscribe to the NDJSON event stream before spawning the session so we
    // don't miss events. Reading the initial flush newline confirms the
    // EventBus subscription is active (no await between enqueue + subscribe).
    const controller = new AbortController();
    const res = await fetch("http://localhost/events", {
      method: "GET",
      unix: daemon.socketPath,
      signal: controller.signal,
    } as RequestInit);

    expect(res.status).toBe(200);
    if (!res.body) throw new Error("Expected streaming response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Drain the initial flush newline — EventBus subscription is now active.
    await reader.read();

    // Spawn session via _claude tool (RPC blocks internally until _claude
    // virtual server is registered, which happens after the WS worker starts).
    // wait=false (default): returns session ID immediately; mock claude runs
    // in background and sends init → assistant → result over WS.
    const callRes = await rpc(daemon.socketPath, "callTool", {
      server: "_claude",
      tool: "claude_prompt",
      arguments: { prompt: "hello", cwd: daemon.dir },
    });
    expect(callRes.error).toBeUndefined();

    // Collect NDJSON events until we have both session.result and session.idle.
    const received: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.event === "session.result" || ev.event === "session.idle") {
            received.push(ev);
          }
        } catch {
          // non-JSON line (heartbeat, etc.) — ignore
        }
      }
      const hasResult = received.some((e) => e.event === "session.result");
      const hasIdle = received.some((e) => e.event === "session.idle");
      if (hasResult && hasIdle) break;
    }

    controller.abort();
    reader.releaseLock();

    const resultEvt = received.find((e) => e.event === "session.result");
    const idleEvt = received.find((e) => e.event === "session.idle");

    expect(resultEvt).toBeDefined();
    expect(idleEvt).toBeDefined();

    // session.result must carry all enriched fields
    expect(resultEvt?.cost).toBe(0.042);
    expect(resultEvt?.tokens).toBe(150); // 100 input + 50 output from assistant message
    expect(resultEvt?.numTurns).toBe(3);
    expect(resultEvt?.result).toBe("task done");
    expect(resultEvt?.resultPreview).toBe("task done");
    expect(resultEvt?.category).toBe("session");
    expect(resultEvt?.src).toBe("daemon.claude-server");

    // session.idle carries cost/tokens/numTurns/resultPreview but NOT result
    expect(idleEvt?.cost).toBe(0.042);
    expect(idleEvt?.tokens).toBe(150);
    expect(idleEvt?.numTurns).toBe(3);
    expect(idleEvt?.resultPreview).toBe("task done");
    expect(idleEvt?.result).toBeUndefined();
    expect(idleEvt?.category).toBe("session");
  });
});
