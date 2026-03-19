import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mcp-cli/core";
import { CodexSession, WATCHDOG_TIMEOUT_MS } from "./codex-session";

const FAKE_SERVER = join(import.meta.dirname, "fake-codex-server.ts");
const TEST_CWD = process.cwd();

function makeSession(
  overrides: Partial<ConstructorParameters<typeof CodexSession>[1]> = {},
  onEvent?: (e: AgentSessionEvent) => void,
): { session: CodexSession; events: AgentSessionEvent[] } {
  const events: AgentSessionEvent[] = [];
  const session = new CodexSession(
    "test-session",
    { cwd: TEST_CWD, prompt: "hello", ...overrides },
    onEvent ?? ((e) => events.push(e)),
  );
  return { session, events };
}

function fakeCommand(mode = "simple"): string[] {
  return ["bun", FAKE_SERVER, mode];
}

// Poll until predicate is true or deadline is exceeded
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Non-process tests ─────────────────────────────────────────────────────

describe("CodexSession (no process)", () => {
  test("getInfo() returns initial state before start", () => {
    const { session } = makeSession();
    const info = session.getInfo();
    expect(info.sessionId).toBe("test-session");
    expect(info.provider).toBe("codex");
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

  test("terminate() before start does not throw", () => {
    const { session } = makeSession();
    expect(() => session.terminate()).not.toThrow();
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

  test("multiple waitForResult waiters all resolve on terminate", async () => {
    const { session } = makeSession();
    const p1 = session.waitForResult(5000);
    const p2 = session.waitForResult(5000);
    session.terminate();
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1.type).toBe("session:ended");
    expect(e2.type).toBe("session:ended");
  });
});

// ── Process-based tests ───────────────────────────────────────────────────

describe("CodexSession (with fake codex server)", () => {
  test("start() completes handshake and turn resolves via waitForResult", async () => {
    const { session, events } = makeSession({ command: fakeCommand("simple") });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(session.currentState).toBe("idle");
    expect(events.some((e) => e.type === "session:init")).toBe(true);
  });

  test("getInfo() reflects model name from initResult", async () => {
    const { session } = makeSession({ command: fakeCommand("simple") });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;

    const info = session.getInfo();
    expect(info.model).toBe("codex-fake");
    expect(info.numTurns).toBe(1);
  });

  test("getTranscript() is empty for simple turn (no items)", async () => {
    const { session } = makeSession({ command: fakeCommand("simple") });
    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise;
    // Fake server does not emit item/completed events
    expect(session.getTranscript()).toHaveLength(0);
  });

  test("terminate() during active session ends it cleanly", async () => {
    const { session, events } = makeSession({ command: fakeCommand("simple") });

    await session.start();
    session.terminate();

    expect(session.currentState).toBe("ended");
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("terminate() resolves pending waitForResult with session:ended", async () => {
    const { session } = makeSession({ command: fakeCommand("simple") });

    await session.start();
    const p = session.waitForResult(10000);
    session.terminate();

    const event = await p;
    expect(event.type).toBe("session:ended");
  });

  test("process crash (non-zero exit) emits session:error then session:ended", async () => {
    const { session, events } = makeSession({ command: fakeCommand("crash-after-turn") });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    await resultPromise; // session:result from turn/completed

    // Wait for the process to crash and emit session:ended
    await waitFor(() => session.currentState === "ended");

    expect(events.some((e) => e.type === "session:error")).toBe(true);
    expect(events.some((e) => e.type === "session:ended")).toBe(true);

    const errEvent = events.find(
      (e): e is Extract<AgentSessionEvent, { type: "session:error" }> => e.type === "session:error",
    );
    expect(errEvent?.errors[0]).toMatch(/exited with code 2/);
  });

  test("approvalPolicy 'never' auto-approves all server requests", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "never",
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
    expect(session.getInfo().pendingPermissions).toBe(0);
  });

  test("matching allow rule auto-approves commandExecution request", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "on-request",
      allowedTools: ["Bash(npm:*)"],
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
  });

  test("deny rule auto-denies commandExecution request without escalation", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "on-request",
      disallowedTools: ["Bash"],
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    // Turn still completes (fake server ignores the decline response)
    expect(result.type).toBe("session:result");
    expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
  });

  test("unresolved approval emits permission_request and queues as pending", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "on-request",
      // No rules → unresolved → manual review
    });

    await session.start();

    // Wait for permission_request event
    await waitFor(() => events.some((e) => e.type === "session:permission_request"));

    expect(session.currentState).toBe("waiting_permission");
    const info = session.getInfo();
    expect(info.pendingPermissions).toBe(1);
    expect(info.pendingPermissionDetails).toHaveLength(1);
    expect(info.pendingPermissionDetails[0].toolName).toBe("Bash");
    expect((info.pendingPermissionDetails[0].input as { command: string }).command).toBe("npm test");
  });

  test("approve() responds to pending permission and resumes session", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "on-request",
    });

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
    const { session, events } = makeSession({
      command: fakeCommand("approval"),
      approvalPolicy: "on-request",
    });

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
    expect(session.getInfo().pendingPermissions).toBe(0);

    const result = await resultPromise;
    expect(result.type).toBe("session:result");
  });

  test("approve() with unknown requestId is a no-op", () => {
    const { session } = makeSession({ command: fakeCommand("simple") });
    // Session not started — rpc is null, should not throw
    expect(() => session.approve("no-such-id")).not.toThrow();
  });

  test("deny() with unknown requestId is a no-op", () => {
    const { session } = makeSession({ command: fakeCommand("simple") });
    expect(() => session.deny("no-such-id")).not.toThrow();
  });

  test("send() starts a follow-up turn after first turn completes", async () => {
    const { session } = makeSession({ command: fakeCommand("simple") });

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

  test("turn/start sends threadId and input array in Codex protocol shape (regressions #666, #845)", async () => {
    // The Codex app-server expects turn/start to include threadId plus
    // input: [{type:"text", text, text_elements}]. validate-input exits(1)
    // if either field is missing or malformed.
    const { session } = makeSession({ command: fakeCommand("validate-input") });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
  });

  test("send() before start throws 'No active thread'", async () => {
    const { session } = makeSession();
    await expect(session.send("msg")).rejects.toThrow("No active thread");
  });

  test("send() in 'connecting' state throws", async () => {
    const events: AgentSessionEvent[] = [];
    // Create a session whose thread is set by patching after start
    // Easier: start a real session and check state guard
    const { session } = makeSession({ command: fakeCommand("simple") });
    // Don't start — state is "connecting", thread is null
    await expect(session.send("msg")).rejects.toThrow("No active thread");
  });

  test("interrupt() before start is a no-op (rpc is null)", async () => {
    const { session } = makeSession();
    await expect(session.interrupt()).resolves.toBeUndefined();
  });

  test("interrupt() after turn completes is a no-op (no currentTurn)", async () => {
    const { session } = makeSession({ command: fakeCommand("simple") });

    const result = session.waitForResult(10000);
    await session.start();
    await result;

    // currentTurn is null after turn/completed
    await expect(session.interrupt()).resolves.toBeUndefined();
  });
});

// ── Watchdog tests ─────────────────────────────────────────────────────────

describe("CodexSession watchdog", () => {
  test("WATCHDOG_TIMEOUT_MS is 5 minutes", () => {
    expect(WATCHDOG_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test("watchdog fires when process goes silent", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("silent"),
      watchdogTimeoutMs: 200, // 200ms for testing
    });

    const resultPromise = session.waitForResult(5000);
    await session.start();
    const result = await resultPromise;

    // Should have fired watchdog → session:error + session:ended
    expect(result.type).toBe("session:error");
    if (result.type === "session:error") {
      expect(result.errors[0]).toMatch(/watchdog timeout/i);
    }
    expect(session.currentState).toBe("ended");
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("watchdog does not fire when events arrive in time", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("simple"),
      watchdogTimeoutMs: 5000, // generous — turn completes in ~30ms
    });

    const resultPromise = session.waitForResult(10000);
    await session.start();
    const result = await resultPromise;

    expect(result.type).toBe("session:result");
    // No watchdog error
    expect(events.some((e) => e.type === "session:error")).toBe(false);
  });

  test("watchdog disabled when watchdogTimeoutMs is 0", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("silent"),
      watchdogTimeoutMs: 0,
    });

    await session.start();

    // Wait a bit — watchdog should NOT fire
    await Bun.sleep(100);

    expect(session.currentState).not.toBe("ended");
    expect(events.some((e) => e.type === "session:error")).toBe(false);

    // Cleanup
    session.terminate();
  });

  test("terminate() clears watchdog without firing", async () => {
    const { session, events } = makeSession({
      command: fakeCommand("silent"),
      watchdogTimeoutMs: 100,
    });

    await session.start();
    // Terminate before watchdog fires
    session.terminate();

    // Wait past the watchdog timeout
    await Bun.sleep(150);

    // Should only have the terminate-caused events, no watchdog error
    const errorEvents = events.filter(
      (e): e is Extract<AgentSessionEvent, { type: "session:error" }> => e.type === "session:error",
    );
    expect(errorEvents.some((e) => e.errors[0]?.includes("watchdog"))).toBe(false);
  });
});
