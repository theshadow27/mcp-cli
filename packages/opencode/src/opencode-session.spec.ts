import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@mcp-cli/core";
import { OpenCodeSession } from "./opencode-session";
import type { OpenCodeSseEvent } from "./opencode-sse";

/** Drive the private SSE handler directly — no process/SSE connection needed. */
function feedSseEvent(session: OpenCodeSession, event: OpenCodeSseEvent): void {
  (session as unknown as { handleSseEvent(e: OpenCodeSseEvent): void }).handleSseEvent(event);
}

function makeSession(overrides: Partial<ConstructorParameters<typeof OpenCodeSession>[1]> = {}): {
  session: OpenCodeSession;
  events: AgentSessionEvent[];
} {
  const events: AgentSessionEvent[] = [];
  const session = new OpenCodeSession("test-session", { cwd: process.cwd(), prompt: "hello", ...overrides }, (e) =>
    events.push(e),
  );
  return { session, events };
}

function permissionAsked(filePath: string): OpenCodeSseEvent {
  return {
    type: "permission.asked",
    data: { id: "perm-1", permission: "write", metadata: { file_path: filePath } },
  };
}

const POLL_MS = 5;

/** Poll a predicate until it holds or the deadline elapses — condition-based, not time-based. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Read the private watchdog timer handle for assertions about timer lifecycle. */
function watchdogTimer(session: OpenCodeSession): unknown {
  return (session as unknown as { watchdogTimer: unknown }).watchdogTimer;
}

// ── Lifecycle / accessors (no process) ──

describe("OpenCodeSession (no process)", () => {
  test("getInfo() returns initial state before start", () => {
    const { session } = makeSession({ name: "my-session" });
    const info = session.getInfo();
    expect(info.sessionId).toBe("test-session");
    expect(info.provider).toBe("opencode");
    expect(info.state).toBe("connecting");
    expect(info.name).toBe("my-session");
    expect(info.cost).toBeNull();
    expect(info.tokens).toBe(0);
    expect(info.numTurns).toBe(0);
    expect(info.pendingPermissions).toBe(0);
    expect(info.processAlive).toBe(false);
    expect(info.rateLimited).toBe(false);
  });

  test("currentState getter mirrors internal state", () => {
    const { session } = makeSession();
    expect(session.currentState).toBe("connecting");
  });

  test("getTranscript() is empty before start, appendNote() adds an entry", () => {
    const { session } = makeSession();
    expect(session.getTranscript()).toHaveLength(0);
    session.appendNote("closing note");
    const transcript = session.getTranscript();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe("user");
    expect(transcript[0].content).toBe("closing note");
  });

  test("terminate() before start emits session:ended and is idempotent", () => {
    const { session, events } = makeSession();
    session.terminate();
    expect(session.currentState).toBe("ended");
    const endedCount1 = events.filter((e) => e.type === "session:ended").length;
    session.terminate();
    const endedCount2 = events.filter((e) => e.type === "session:ended").length;
    expect(endedCount1).toBe(1);
    expect(endedCount2).toBe(1);
  });

  test("waitForResult() rejects on timeout", async () => {
    const { session } = makeSession();
    await expect(session.waitForResult(10)).rejects.toThrow(/waitForResult timeout/);
  });

  test("waitForResult() rejects when already ended", async () => {
    const { session } = makeSession();
    session.terminate();
    await expect(session.waitForResult(10)).rejects.toThrow(/already ended/);
  });

  test("waitForResult() resolves with session:ended on terminate", async () => {
    const { session } = makeSession();
    const p = session.waitForResult(5000);
    session.terminate();
    const event = await p;
    expect(event.type).toBe("session:ended");
  });

  test("waitForEvent() rejects on timeout", async () => {
    const { session } = makeSession();
    await expect(session.waitForEvent(10)).rejects.toThrow(/waitForEvent timeout/);
  });

  test("waitForEvent() can be cancelled", async () => {
    const { session } = makeSession();
    const p = session.waitForEvent(5000);
    p.cancel?.();
    await expect(p).rejects.toThrow(/cancelled/);
  });

  test("waitForEvent() resolves with the next emitted event", async () => {
    const { session } = makeSession();
    const p = session.waitForEvent(5000);
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "hi" } } });
    const event = await p;
    expect(event.type).toBe("session:response");
  });

  test("send() throws when there is no active session", async () => {
    const { session } = makeSession();
    await expect(session.send("follow-up")).rejects.toThrow(/No active session/);
  });

  test("interrupt() is a no-op without a client", async () => {
    const { session } = makeSession();
    await expect(session.interrupt()).resolves.toBeUndefined();
  });

  test("approve()/deny() are no-ops without a client", () => {
    const { session } = makeSession();
    expect(() => session.approve("nope")).not.toThrow();
    expect(() => session.deny("nope")).not.toThrow();
  });
});

// ── SSE event handling (no process) ──

describe("OpenCodeSession SSE handling", () => {
  test("message.part.updated emits session:response and accumulates transcript", () => {
    const { session, events } = makeSession();
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "Hello " } } });
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "world!" } } });
    const responses = events.filter((e) => e.type === "session:response");
    expect(responses.length).toBeGreaterThanOrEqual(2);
  });

  test("unresolved permission queues as pending and emits permission_request", () => {
    const { session, events } = makeSession();
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    expect(session.currentState).toBe("waiting_permission");
    expect(session.getInfo().pendingPermissions).toBe(1);
    expect(events.some((e) => e.type === "session:permission_request")).toBe(true);
  });

  test("permission with allow rule auto-resolves without a manual request", () => {
    const { session, events } = makeSession({ allowedTools: ["Write"] });
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
  });

  test("permission.replied clears pending and resumes active", () => {
    const { session } = makeSession();
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    expect(session.currentState).toBe("waiting_permission");
    feedSseEvent(session, { type: "permission.replied", data: { id: "perm-1" } });
    expect(session.getInfo().pendingPermissions).toBe(0);
    expect(session.currentState).toBe("active");
  });

  test("session.status idle while active completes the turn with a result", () => {
    const { session, events } = makeSession();
    // Drive to active via permission ask + reply.
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    feedSseEvent(session, { type: "permission.replied", data: { id: "perm-1" } });
    expect(session.currentState).toBe("active");

    feedSseEvent(session, { type: "session.diff", data: { diff: "diff --git a b" } });
    feedSseEvent(session, { type: "session.status", data: { status: "idle" } });

    expect(session.currentState).toBe("idle");
    const result = events.find((e) => e.type === "session:result");
    expect(result).toBeDefined();
    if (result?.type === "session:result") {
      expect(result.result.diff).toBe("diff --git a b");
    }
  });
});

// ── Watchdog (no process) ──

describe("OpenCodeSession watchdog", () => {
  test("watchdog fires after silence and emits session:error then ended", async () => {
    const { session, events } = makeSession({ watchdogTimeoutMs: 40 });
    // Any SSE event arms the watchdog via resetWatchdog().
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "tick" } } });

    await waitFor(() => session.currentState === "ended");

    const err = events.find((e) => e.type === "session:error");
    expect(err).toBeDefined();
    if (err?.type === "session:error") {
      expect(err.errors[0]).toMatch(/watchdog timeout/i);
    }
  });

  test("watchdog disabled when watchdogTimeoutMs is 0", () => {
    const { session } = makeSession({ watchdogTimeoutMs: 0 });
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "tick" } } });
    // Disabled watchdog never arms a timer (resetWatchdog early-returns).
    expect(watchdogTimer(session)).toBeNull();
    session.terminate();
  });

  test("terminate() clears the armed watchdog timer", () => {
    const { session } = makeSession({ watchdogTimeoutMs: 5000 });
    feedSseEvent(session, { type: "message.part.updated", data: { part: { type: "text", text: "tick" } } });
    expect(watchdogTimer(session)).not.toBeNull();
    session.terminate();
    expect(watchdogTimer(session)).toBeNull();
  });
});

// ── Injected-client paths (send / interrupt / approve / deny / exit) ──

interface FakeClientCalls {
  prompts: Array<{ sessionId: string; text: string }>;
  replies: Array<{ requestId: string; reply: string }>;
  aborts: string[];
}

function injectFakeClient(session: OpenCodeSession): FakeClientCalls {
  const calls: FakeClientCalls = { prompts: [], replies: [], aborts: [] };
  const fakeClient = {
    sendPromptAsync: (sessionId: string, text: string) => {
      calls.prompts.push({ sessionId, text });
      return Promise.resolve();
    },
    replyPermission: (requestId: string, reply: string) => {
      calls.replies.push({ requestId, reply });
      return Promise.resolve();
    },
    abortSession: (sessionId: string) => {
      calls.aborts.push(sessionId);
      return Promise.resolve();
    },
  };
  const internals = session as unknown as {
    client: unknown;
    openCodeSessionId: string;
    proc: unknown;
    setState(s: string): void;
    handleExit(code: number | null, signal: string | null): void;
  };
  internals.client = fakeClient;
  internals.openCodeSessionId = "oc-session-1";
  internals.proc = { kill: () => {}, alive: true };
  return calls;
}

describe("OpenCodeSession with injected client", () => {
  test("send() starts a follow-up prompt when idle", async () => {
    const { session } = makeSession();
    const calls = injectFakeClient(session);
    (session as unknown as { setState(s: string): void }).setState("idle");

    await session.send("follow-up message");

    expect(calls.prompts).toHaveLength(1);
    expect(calls.prompts[0].text).toBe("follow-up message");
    expect(session.currentState).toBe("active");
  });

  test("send() rejects when in an unsendable state", async () => {
    const { session } = makeSession();
    injectFakeClient(session);
    (session as unknown as { setState(s: string): void }).setState("active");
    await expect(session.send("nope")).rejects.toThrow(/Cannot send in state/);
  });

  test("interrupt() aborts the active session", async () => {
    const { session } = makeSession();
    const calls = injectFakeClient(session);
    await session.interrupt();
    expect(calls.aborts).toEqual(["oc-session-1"]);
  });

  test("approve() replies 'always' and resumes active", () => {
    const { session } = makeSession();
    const calls = injectFakeClient(session);
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    expect(session.currentState).toBe("waiting_permission");

    session.approve("perm-1");

    expect(calls.replies).toContainEqual({ requestId: "perm-1", reply: "always" });
    expect(session.getInfo().pendingPermissions).toBe(0);
    expect(session.currentState).toBe("active");
  });

  test("deny() replies 'reject' and resumes active", () => {
    const { session } = makeSession();
    const calls = injectFakeClient(session);
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));

    session.deny("perm-1");

    expect(calls.replies).toContainEqual({ requestId: "perm-1", reply: "reject" });
    expect(session.currentState).toBe("active");
  });

  test("handleExit with a non-zero code emits session:error then session:ended", () => {
    const { session, events } = makeSession();
    injectFakeClient(session);
    (session as unknown as { handleExit(code: number | null, signal: string | null): void }).handleExit(2, null);

    expect(session.currentState).toBe("ended");
    const err = events.find((e) => e.type === "session:error");
    expect(err).toBeDefined();
    if (err?.type === "session:error") {
      expect(err.errors[0]).toMatch(/exited with code 2/);
    }
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });

  test("send() surfaces a prompt-send failure as session:error", async () => {
    const { session, events } = makeSession();
    const internals = session as unknown as {
      client: unknown;
      openCodeSessionId: string;
      proc: unknown;
      setState(s: string): void;
    };
    internals.client = {
      sendPromptAsync: () => Promise.reject(new Error("network down")),
      replyPermission: () => Promise.reject(new Error("reply failed")),
      abortSession: () => Promise.resolve(),
    };
    internals.openCodeSessionId = "oc-session-1";
    internals.proc = { kill: () => {}, alive: true };
    internals.setState("idle");

    await session.send("will fail");
    await waitFor(() => events.some((e) => e.type === "session:error"));

    const err = events.find((e) => e.type === "session:error");
    expect(err).toBeDefined();
    if (err?.type === "session:error") {
      expect(err.errors[0]).toBe("network down");
    }
    expect(session.currentState).toBe("idle");
  });

  test("approve() tolerates a rejected reply without throwing", async () => {
    const { session } = makeSession();
    const internals = session as unknown as {
      client: unknown;
      openCodeSessionId: string;
      proc: unknown;
    };
    internals.client = {
      sendPromptAsync: () => Promise.resolve(),
      replyPermission: () => Promise.reject(new Error("reply failed")),
      abortSession: () => Promise.resolve(),
    };
    internals.openCodeSessionId = "oc-session-1";
    internals.proc = { kill: () => {}, alive: true };

    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd.txt")));
    expect(() => session.approve("perm-1")).not.toThrow();
    feedSseEvent(session, permissionAsked(join(process.cwd(), "in-cwd2.txt")));
    expect(() => session.deny("perm-1")).not.toThrow();
    // Drain the rejected-reply microtasks so the production catch handlers run.
    await Promise.resolve();
    await Promise.resolve();
  });

  test("handleExit with code 0 ends cleanly without an error event", () => {
    const { session, events } = makeSession();
    injectFakeClient(session);
    (session as unknown as { handleExit(code: number | null, signal: string | null): void }).handleExit(0, null);

    expect(session.currentState).toBe("ended");
    expect(events.some((e) => e.type === "session:error")).toBe(false);
    expect(events.some((e) => e.type === "session:ended")).toBe(true);
  });
});

// ── Worktree containment (#2519) ──

describe("OpenCodeSession worktree containment (#2519)", () => {
  test("denies a write that escapes the worktree root before permission rules", () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-containment-"));
    const events: AgentSessionEvent[] = [];
    try {
      const session = new OpenCodeSession("test-session", { cwd: worktree, prompt: "hello", worktree }, (e) =>
        events.push(e),
      );

      feedSseEvent(session, permissionAsked("/etc/opencode-escape-probe.txt"));

      expect(events.some((e) => e.type === "session:containment_denied")).toBe(true);
      // Must NOT fall through to a manual-review permission request.
      expect(events.some((e) => e.type === "session:permission_request")).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a write inside the worktree is not gated by containment", () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-containment-"));
    const events: AgentSessionEvent[] = [];
    try {
      const session = new OpenCodeSession("test-session", { cwd: worktree, prompt: "hello", worktree }, (e) =>
        events.push(e),
      );

      feedSseEvent(session, permissionAsked(join(worktree, "ok.txt")));

      expect(events.some((e) => e.type === "session:containment_denied")).toBe(false);
      // No rules → unresolved → surfaced for manual review.
      expect(events.some((e) => e.type === "session:permission_request")).toBe(true);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a non-worktree session does not gate the same out-of-bounds write", () => {
    const events: AgentSessionEvent[] = [];
    const session = new OpenCodeSession("test-session", { cwd: process.cwd(), prompt: "hello" }, (e) => events.push(e));

    feedSseEvent(session, permissionAsked("/etc/opencode-escape-probe.txt"));

    expect(events.some((e) => e.type === "session:containment_denied")).toBe(false);
    expect(events.some((e) => e.type === "session:permission_request")).toBe(true);
  });
});
