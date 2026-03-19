import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mcp-cli/core";
import { AcpSession, WATCHDOG_TIMEOUT_MS } from "./acp-session";

const FAKE_AGENT = join(import.meta.dirname, "fake-acp-agent.ts");
const TEST_CWD = process.cwd();

function makeSession(
  overrides: Partial<ConstructorParameters<typeof AcpSession>[1]> = {},
  onEvent?: (e: AgentSessionEvent) => void,
): { session: AcpSession; events: AgentSessionEvent[] } {
  const events: AgentSessionEvent[] = [];
  const session = new AcpSession(
    "test-session",
    {
      cwd: TEST_CWD,
      prompt: "hello",
      agent: "test",
      customCommand: fakeCommand(overrides.agent ?? "simple"),
      ...overrides,
    },
    onEvent ?? ((e) => events.push(e)),
  );
  return { session, events };
}

function fakeCommand(mode = "simple"): string[] {
  return ["bun", FAKE_AGENT, mode];
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Non-process tests ──

describe("AcpSession (no process)", () => {
  test("getInfo() returns initial state before start", () => {
    const { session } = makeSession();
    const info = session.getInfo();
    expect(info.sessionId).toBe("test-session");
    expect(info.provider).toBe("acp");
    expect(info.state).toBe("connecting");
    expect(info.cost).toBeNull();
    expect(info.tokens).toBe(0);
    expect(info.reasoningTokens).toBe(0);
    expect(info.numTurns).toBe(0);
    expect(info.pendingPermissions).toBe(0);
    expect(info.pendingPermissionDetails).toHaveLength(0);
  });

  test("currentState getter mirrors internal state", () => {
    const { session } = makeSession();
    expect(session.currentState).toBe("connecting");
  });

  test("getTranscript() returns empty array before start", () => {
    const { session } = makeSession();
    expect(session.getTranscript()).toHaveLength(0);
  });

  test("terminate() before start emits session:ended", () => {
    const { session, events } = makeSession();
    session.terminate();
    expect(session.currentState).toBe("ended");
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("waitForResult() rejects on timeout", async () => {
    const { session } = makeSession();
    await expect(session.waitForResult(10)).rejects.toThrow("waitForResult timeout");
  });

  test("waitForEvent() rejects on timeout", async () => {
    const { session } = makeSession();
    await expect(session.waitForEvent(10)).rejects.toThrow("waitForEvent timeout");
  });

  test("terminate() resolves pending waitForResult with session:ended", async () => {
    const { session } = makeSession();
    const p = session.waitForResult(5000);
    session.terminate();
    const event = await p;
    expect(event.type).toBe("session:ended");
  });

  test("terminate() resolves pending waitForEvent with session:ended", async () => {
    const { session } = makeSession();
    const p = session.waitForEvent(5000);
    session.terminate();
    const event = await p;
    expect(event.type).toBe("session:ended");
  });
});

// ── Process-based tests ──

describe("AcpSession (with fake ACP agent)", () => {
  test("start() completes handshake and prompt resolves via waitForResult", async () => {
    const { session, events } = makeSession({ agent: "simple" });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(session.currentState).toBe("idle");
    expect(events.some((e) => e.type === "session:init")).toBe(true);
  });

  test("getInfo() reports acp provider after start", async () => {
    const { session } = makeSession({ agent: "simple" });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;

    const info = session.getInfo();
    expect(info.provider).toBe("acp");
    expect(info.numTurns).toBe(1);
  });

  test("streaming updates accumulate into result text", async () => {
    const { session, events } = makeSession({ agent: "with-updates" });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    if (result.type === "session:result") {
      expect(result.result.result).toBe("Hello world!");
    }

    // Should have gotten session:response events
    const responseEvents = events.filter((e) => e.type === "session:response");
    expect(responseEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("terminate() during active session ends it cleanly", async () => {
    const { session, events } = makeSession({ agent: "simple" });

    await session.start();
    session.terminate();

    expect(session.currentState).toBe("ended");
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("process crash (non-zero exit) emits session:error then session:ended", async () => {
    const { session, events } = makeSession({ agent: "crash-after-prompt" });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;

    await waitFor(() => session.currentState === "ended");

    expect(events.some((e) => e.type === "session:error")).toBe(true);
    expect(events.some((e) => e.type === "session:ended")).toBe(true);

    const errEvent = events.find(
      (e): e is Extract<AgentSessionEvent, { type: "session:error" }> => e.type === "session:error",
    );
    expect(errEvent?.errors[0]).toMatch(/exited with code 2/);
  });

  test("permission request with allow rule auto-approves", async () => {
    const { session, events } = makeSession({
      agent: "permission",
      allowedTools: ["Bash(npm:*)"],
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    // Should NOT have emitted a permission_request (auto-approved)
    expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
  });

  test("unresolved permission emits permission_request and queues as pending", async () => {
    const { session, events } = makeSession({
      agent: "permission",
      // No rules → unresolved → manual review
    });

    await session.start();

    await waitFor(() => events.some((e) => e.type === "session:permission_request"));

    expect(session.currentState).toBe("waiting_permission");
    const info = session.getInfo();
    expect(info.pendingPermissions).toBe(1);
    expect(info.pendingPermissionDetails).toHaveLength(1);
    expect(info.pendingPermissionDetails[0].toolName).toBe("Bash");
  });

  test("approve() responds to pending permission and resumes session", async () => {
    const { session, events } = makeSession({ agent: "permission" });

    await session.start();
    await waitFor(() => events.some((e) => e.type === "session:permission_request"));

    const permEvent = events.find(
      (e): e is Extract<AgentSessionEvent, { type: "session:permission_request" }> =>
        e.type === "session:permission_request",
    );
    if (!permEvent) throw new Error("Expected permission_request event");

    const resultPromise = session.waitForResult(10000);
    session.approve(permEvent.request.requestId);

    expect(session.currentState).toBe("active");
    expect(session.getInfo().pendingPermissions).toBe(0);

    const result = await resultPromise;
    expect(result.type).toBe("session:result");
  });

  test("deny() responds to pending permission and resumes session", async () => {
    const { session, events } = makeSession({ agent: "permission" });

    await session.start();
    await waitFor(() => events.some((e) => e.type === "session:permission_request"));

    const permEvent = events.find(
      (e): e is Extract<AgentSessionEvent, { type: "session:permission_request" }> =>
        e.type === "session:permission_request",
    );
    if (!permEvent) throw new Error("Expected permission_request event");

    const resultPromise = session.waitForResult(10000);
    session.deny(permEvent.request.requestId);

    expect(session.currentState).toBe("active");

    const result = await resultPromise;
    expect(result.type).toBe("session:result");
  });

  test("send() starts a follow-up prompt after first completes", async () => {
    const { session } = makeSession({ agent: "simple" });

    const first = session.waitForResult(10000);
    await session.start();
    await first;

    expect(session.currentState).toBe("idle");

    const second = session.waitForResult(10000);
    await session.send("follow-up message");
    const result = await second;

    expect(result.type).toBe("session:result");
    expect(session.getInfo().numTurns).toBe(2);
  });

  test("transcript includes user and assistant entries", async () => {
    const { session } = makeSession({ agent: "with-updates" });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;

    const transcript = session.getTranscript();
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript[0].role).toBe("user");
    expect(transcript[0].content).toBe("hello");
    // Last entry should be assistant
    const lastEntry = transcript[transcript.length - 1];
    expect(lastEntry.role).toBe("assistant");
  });
});

// ── Server request tests (fs, terminal) ──

describe("AcpSession server requests", () => {
  test("fs/write_text_file writes to cwd and completes", async () => {
    const probePath = join(TEST_CWD, "acp-test-probe.txt");
    try {
      const { session } = makeSession({ agent: "fs-write" });
      const resultPromise = session.waitForResult(10000);
      await session.start();
      await resultPromise;

      const content = await Bun.file(probePath).text();
      expect(content).toBe("hello from acp");
    } finally {
      try {
        await Bun.write(probePath, ""); // cleanup
        const { unlinkSync } = await import("node:fs");
        unlinkSync(probePath);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  test("fs/read_text_file reads file under cwd and completes", async () => {
    const { session } = makeSession({ agent: "fs-read" });
    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;
    expect(result.type).toBe("session:result");
  });

  test("fs/write_text_file rejects path traversal outside cwd", async () => {
    const { session } = makeSession({ agent: "fs-write-traversal" });
    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;

    // The traversal target should NOT have been written
    const { existsSync } = await import("node:fs");
    expect(existsSync("/tmp/acp-traversal-probe.txt")).toBe(false);
  });

  test("terminal/create runs async command and completes", async () => {
    const { session } = makeSession({ agent: "terminal" });
    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;
    expect(result.type).toBe("session:result");
  });

  test("terminate() is idempotent — second call is no-op", () => {
    const { session, events } = makeSession();
    session.terminate();
    const endedCount1 = events.filter((e) => e.type === "session:ended").length;
    session.terminate();
    const endedCount2 = events.filter((e) => e.type === "session:ended").length;
    expect(endedCount2).toBe(endedCount1);
  });
});

// ── Watchdog tests ──

describe("AcpSession watchdog", () => {
  test("WATCHDOG_TIMEOUT_MS is 5 minutes", () => {
    expect(WATCHDOG_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test("watchdog fires when process goes silent", async () => {
    const { session, events } = makeSession({
      agent: "silent",
      watchdogTimeoutMs: 200,
    });

    const resultPromise = session.waitForResult(5000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:error");
    if (result.type === "session:error") {
      expect(result.errors[0]).toMatch(/watchdog timeout/i);
    }
    expect(session.currentState).toBe("ended");
  });

  test("watchdog disabled when watchdogTimeoutMs is 0", async () => {
    const { session, events } = makeSession({
      agent: "silent",
      watchdogTimeoutMs: 0,
    });

    await session.start();
    await Bun.sleep(100);

    expect(session.currentState).not.toBe("ended");
    expect(events.some((e) => e.type === "session:error")).toBe(false);

    session.terminate();
  });

  test("terminate() clears watchdog without firing", async () => {
    const { session, events } = makeSession({
      agent: "silent",
      watchdogTimeoutMs: 100,
    });

    await session.start();
    session.terminate();

    await Bun.sleep(150);

    const errorEvents = events.filter(
      (e): e is Extract<AgentSessionEvent, { type: "session:error" }> => e.type === "session:error",
    );
    expect(errorEvents.some((e) => e.errors[0]?.includes("watchdog"))).toBe(false);
  });
});
