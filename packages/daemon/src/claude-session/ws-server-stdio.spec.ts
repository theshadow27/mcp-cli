import { afterEach, describe, expect, test } from "bun:test";
import { type MonitorEventInput, silentLogger } from "@mcp-cli/core";
import { serialize } from "./ndjson";
import type { StuckDetectorClock } from "./stuck-detector";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

import { pollUntil } from "../../../../test/harness";

/** Deterministic clock for StuckDetector — virtual time advances only on advance(). */
class FakeClock implements StuckDetectorClock {
  private _now = 0;
  private nextId = 1;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number {
    return this._now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this._now + ms, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== timer);
  }

  /** Advance virtual time by `ms`, firing expired timers in order. */
  advance(ms: number): void {
    const target = this._now + ms;
    while (true) {
      const next = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this._now = next.at;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      next.callback();
    }
    this._now = target;
  }
}

const SETTLE_MS = 10;
const PAST_CONNECT_TIMEOUT_MS = 300;
const DEDUPE_SETTLE_MS = 50;

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
    claude_code_version: "2.1.130",
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
    usage: { input_tokens: 200, output_tokens: 100 },
    uuid: "test-uuid",
    session_id: sessionId,
  });
}

function streamEventMessage(sessionId: string): string {
  return serialize({
    type: "stream_event",
    event: {},
    parent_tool_use_id: null,
    uuid: "stream-uuid",
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

/**
 * Mock spawn that exposes stdin/stdout streams for stdio transport testing.
 * The mock stdout is a ReadableStream that the test can push NDJSON lines into.
 * The mock stdin captures writes for assertion.
 */
function mockStdioSpawn(): {
  spawn: SpawnFn;
  exitResolve: (code: number) => void;
  killed: boolean;
  lastCmd: string[];
  lastOpts: Record<string, unknown>;
  pushStdout: (data: string) => void;
  closeStdout: () => void;
  stdinWrites: string[];
  failWrites: (err: Error) => void;
} {
  let exitResolve: (code: number) => void = () => {};
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stdinWrites: string[] = [];
  let writeError: Error | null = null;

  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const mockStdin = {
    write(data: string | Uint8Array): number {
      if (writeError) throw writeError;
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);
      stdinWrites.push(str);
      return typeof data === "string" ? data.length : data.byteLength;
    },
    flush(): number {
      return 0;
    },
  };

  const state = {
    spawn: ((cmd: string[], opts: Record<string, unknown>) => {
      state.lastCmd = cmd;
      state.lastOpts = opts;
      return {
        pid: 54321,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => {
          state.killed = true;
          // Guard: only close if not already closed (ReadableStream tracks locked state)
          if (stdoutController !== null) {
            const ctrl = stdoutController;
            stdoutController = null;
            ctrl.close();
          }
          exitResolve(143);
        },
        stdout: stdoutStream,
        stdin: mockStdin,
        stderrTail: () => "",
      };
    }) as SpawnFn,
    exitResolve: (code: number) => exitResolve(code),
    killed: false,
    lastCmd: [] as string[],
    lastOpts: {} as Record<string, unknown>,
    pushStdout: (data: string) => {
      stdoutController?.enqueue(encoder.encode(data));
    },
    closeStdout: () => {
      if (stdoutController !== null) {
        const ctrl = stdoutController;
        stdoutController = null;
        ctrl.close();
      }
    },
    stdinWrites,
    failWrites: (err: Error) => {
      writeError = err;
    },
  };
  return state;
}

// ── Tests ──

describe("ClaudeWsServer — stdio transport", () => {
  let server: ClaudeWsServer;

  afterEach(async () => {
    await server?.stop();
  });

  test("stdio session sends initial prompt via stdin and receives messages via stdout", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    const port = await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, {
      prompt: "Hello Claude",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // Verify spawn args don't include --sdk-url
    expect(mock.lastCmd).not.toContain("--sdk-url");
    expect(mock.lastCmd).toContain("--print");
    expect(mock.lastCmd).toContain("--output-format");
    expect(mock.lastCmd).toContain("--input-format");
    // stream-json print mode requires --verbose or claude exits immediately (#2688);
    // --include-partial-messages restores the stream_event StuckDetector signal.
    expect(mock.lastCmd).toContain("--verbose");
    expect(mock.lastCmd).toContain("--include-partial-messages");

    // Spawn opts should have stdin/stdout piped
    expect(mock.lastOpts).toMatchObject({ stdin: "pipe", stdout: "pipe" });

    // Verify initial prompt was sent via stdin
    await pollUntil(() => mock.stdinWrites.length > 0, 1000);
    const firstWrite = mock.stdinWrites[0];
    expect(firstWrite).toBeDefined();
    const parsed = JSON.parse(firstWrite?.trim() ?? "");
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toBe("Hello Claude");
  });

  test("stdio session processes system/init from stdout", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => {
      events.push(event);
    };

    server.prepareSession(sessionId, {
      prompt: "Hello",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // Push system/init through mock stdout
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);

    const sessions = server.listSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    expect(session).toBeDefined();
    expect(session?.model).toBe("claude-sonnet-4-6");
  });

  test("stdio session full lifecycle: init → assistant → result", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => {
      events.push(event);
    };

    server.prepareSession(sessionId, {
      prompt: "Do something",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // Simulate full conversation
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);

    mock.pushStdout(`${assistantMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:response"), 1000);

    mock.pushStdout(`${resultMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:result"), 1000);

    const resultEvent = events.find((e) => e.type === "session:result");
    expect(resultEvent).toBeDefined();
  });

  test("stdio session that completes-then-exits still emits session:result when proc.exited wins the race (#2825)", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => {
      events.push(event);
    };

    server.prepareSession(sessionId, { prompt: "Do something", transport: "stdio" });
    server.spawnClaude(sessionId);

    // init + assistant are readable first and fully drained; the reader then
    // parks on read() with an empty buffer.
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);
    mock.pushStdout(`${assistantMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:response"), 1000);

    // Resolve proc.exited and let its handler run to completion BEFORE the
    // trailing result line is delivered — the CI race where exit "wins the
    // schedule" (faithful to `cat`: final bytes still in the kernel pipe buffer
    // at exit). Flushing microtasks here is deterministic ordering, not a
    // time-based wait: the reader is parked (no data), so only the exit
    // handler runs. Without the drain-await fix (ws-server.ts:983) the handler
    // flips the session to `disconnected`, and the #2814 handleStdioLine guard
    // then drops the buffered result — session:result never fires.
    mock.exitResolve(0);
    const flush = () => new Promise<void>((r) => queueMicrotask(r));
    await flush();
    await flush();

    // Deliver the buffered result line + EOF, exactly as `cat` does at exit.
    mock.pushStdout(`${resultMessage(sessionId)}\n`);
    mock.closeStdout();

    await pollUntil(() => events.some((e) => e.type === "session:result"), 1000);
    expect(events.some((e) => e.type === "session:result")).toBe(true);
  });

  test("stdio session still emits session:result when the initial prompt write EPIPEs before the reader is wired (#2838)", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => {
      events.push(event);
    };

    // The child produced its full transcript into the pipe buffer before the daemon
    // ever wrote the prompt — enqueue init + result up front so they survive the kill
    // that disconnectSession issues (already-enqueued chunks drain before EOF).
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    mock.pushStdout(`${resultMessage(sessionId)}\n`);

    // Make the initial stdin prompt write throw EPIPE. startStdioReader writes the
    // prompt (sendToSession) BEFORE wiring the reader, so this flips the session to
    // `disconnected` synchronously — the reader then drains the buffered result into
    // the #2814 guard. This is the deterministic form of the load-induced EPIPE that
    // #2825 round-2 proved (bare `cat` exits without reading stdin); using DI keeps it
    // race-free instead of depending on runner contention.
    mock.failWrites(new Error("EPIPE: broken pipe, send"));

    server.prepareSession(sessionId, { prompt: "Do something", transport: "stdio" });
    server.spawnClaude(sessionId);

    // The buffered result must still fire session:result despite the disconnect.
    await pollUntil(() => events.some((e) => e.type === "session:result"), 1000);
    expect(events.some((e) => e.type === "session:result")).toBe(true);

    // The #2793 protection survives: the late `init` (a non-result line arriving after
    // teardown) is still dropped — only `result` is honored past disconnect.
    expect(events.some((e) => e.type === "session:init")).toBe(false);
  });

  test("stdio session clears connect timeout on first stdout line", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 200,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, {
      prompt: "Hello",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // Push init quickly — should clear the connect timeout
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => {
      const sessions = server.listSessions();
      const s = sessions.find((x) => x.sessionId === sessionId);
      return s?.state !== "connecting";
    }, 1000);

    // Wait past the connect timeout — should NOT disconnect
    await Bun.sleep(PAST_CONNECT_TIMEOUT_MS);
    const sessions = server.listSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    expect(session?.state).not.toBe("disconnected");
  });

  test("stdio session sendPrompt writes to stdin", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, {
      prompt: "Initial",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // Drive through init → idle so sendPrompt works
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await Bun.sleep(SETTLE_MS);
    mock.pushStdout(`${assistantMessage(sessionId)}\n`);
    await Bun.sleep(SETTLE_MS);
    mock.pushStdout(`${resultMessage(sessionId)}\n`);
    await Bun.sleep(SETTLE_MS);

    const beforeCount = mock.stdinWrites.length;
    server.sendPrompt(sessionId, "Follow-up question");
    await Bun.sleep(SETTLE_MS);

    const newWrites = mock.stdinWrites.slice(beforeCount);
    expect(newWrites.length).toBeGreaterThan(0);
    const follow = JSON.parse(newWrites[0]?.trim() ?? "");
    expect(follow.type).toBe("user");
    expect(follow.message.content).toBe("Follow-up question");
  });

  test("system/init dedupe: second init from stdout produces no event", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => {
      events.push(event);
    };

    server.prepareSession(sessionId, {
      prompt: "Hello",
      transport: "stdio",
    });
    server.spawnClaude(sessionId);

    // First init
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);

    const initCount = events.filter((e) => e.type === "session:init").length;
    expect(initCount).toBe(1);

    // Second init (stdio re-emits per turn)
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await Bun.sleep(DEDUPE_SETTLE_MS);

    const finalInitCount = events.filter((e) => e.type === "session:init").length;
    expect(finalInitCount).toBe(1);
  });

  test("buildSpawnCmd omits -p and --sdk-url for stdio", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "test", transport: "stdio" });
    server.spawnClaude(sessionId);

    expect(mock.lastCmd).not.toContain("-p");
    expect(mock.lastCmd).not.toContain("--sdk-url");
    expect(mock.lastCmd).toContain("--print");
    expect(mock.lastCmd).toContain("stream-json");
    expect(mock.lastCmd).toContain("--verbose");
    expect(mock.lastCmd).toContain("--include-partial-messages");
  });

  test("restoreSessions with explicit transport:'stdio' revives with stdio args", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    await server.start(0);

    const sessionId = "restored-stdio-1";
    server.restoreSessions([
      {
        sessionId,
        pid: null,
        state: "idle",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        claudeSessionId: "claude-sess-abc",
        transport: "stdio",
      },
    ]);

    const sessions = server.listSessions();
    const restored = sessions.find((s) => s.sessionId === sessionId);
    expect(restored).toBeDefined();
    expect(restored?.state).toBe("disconnected");

    server.reviveSession(sessionId, "follow-up prompt");

    expect(mock.lastCmd).not.toContain("--sdk-url");
    expect(mock.lastCmd).toContain("--print");
    expect(mock.lastCmd).toContain("--output-format");
    expect(mock.lastCmd).toContain("stream-json");
    expect(mock.lastOpts).toMatchObject({ stdin: "pipe", stdout: "pipe" });
  });

  test("production restore path: stdio transport persisted in DB survives restore (fixes #2602)", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    await server.start(0);

    const sessionId = "restored-stdio-from-db";
    server.restoreSessions([
      {
        sessionId,
        pid: null,
        state: "idle",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        claudeSessionId: "claude-sess-def",
        transport: "stdio",
      },
    ]);

    server.reviveSession(sessionId, "follow-up prompt");

    expect(mock.lastCmd).not.toContain("--sdk-url");
    expect(mock.lastCmd).toContain("--print");
    expect(mock.lastCmd).toContain("stream-json");
  });

  test("forwards line-buffered child stderr keyed by session, flushing trailing partial on exit (#2738)", async () => {
    let onStderr: ((chunk: string) => void) | undefined;
    let onStderrEnd: (() => void) | undefined;
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (_cmd, opts) => {
      onStderr = opts.onStderr;
      onStderrEnd = opts.onStderrEnd;
      return {
        pid: 6001,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => exitResolve(143),
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stdin: { write: () => 0, flush: () => 0 },
        stderrTail: () => "",
      };
    };
    server = new ClaudeWsServer({ spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const captured: Array<{ sessionId: string; line: string }> = [];
    server.onStderrLine = (sessionId, line) => captured.push({ sessionId, line });

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" });
    server.spawnClaude(sessionId);

    expect(onStderr).toBeDefined();
    // Chunk boundaries split mid-line — the buffer must reassemble across chunks.
    onStderr?.("auth error: token ");
    onStderr?.("expired\nversion mis");
    onStderr?.("match\n");
    // A final line with NO trailing newline — must NOT be emitted until EOF.
    onStderr?.("fatal: no trailing newline");
    expect(captured.map((c) => c.line)).toEqual(["auth error: token expired", "version mismatch"]);

    // Stream EOF flushes the trailing partial — the canary's first/only bytes.
    onStderrEnd?.();
    expect(captured.map((c) => c.line)).toEqual([
      "auth error: token expired",
      "version mismatch",
      "fatal: no trailing newline",
    ]);
    expect(captured.every((c) => c.sessionId === sessionId)).toBe(true);
  });

  test("a single partial stderr line with no newline is flushed on exit, not dropped (#2738)", async () => {
    let onStderr: ((chunk: string) => void) | undefined;
    let onStderrEnd: (() => void) | undefined;
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (_cmd, opts) => {
      onStderr = opts.onStderr;
      onStderrEnd = opts.onStderrEnd;
      return {
        pid: 6002,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => exitResolve(143),
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stdin: { write: () => 0, flush: () => 0 },
        stderrTail: () => "",
      };
    };
    server = new ClaudeWsServer({ spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const captured: string[] = [];
    server.onStderrLine = (_sid, line) => captured.push(line);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" });
    server.spawnClaude(sessionId);

    onStderr?.("spawn failed: ENOENT claude");
    expect(captured).toEqual([]);
    onStderrEnd?.();
    expect(captured).toEqual(["spawn failed: ENOENT claude"]);
  });

  test("a child spewing bytes with no newline is force-flushed in capped slices, bounding the buffer (#2769)", async () => {
    let onStderr: ((chunk: string) => void) | undefined;
    let onStderrEnd: (() => void) | undefined;
    let exitResolve: (code: number) => void = () => {};
    const spawn: SpawnFn = (_cmd, opts) => {
      onStderr = opts.onStderr;
      onStderrEnd = opts.onStderrEnd;
      return {
        pid: 6003,
        exited: new Promise<number>((r) => {
          exitResolve = r;
        }),
        kill: () => exitResolve(143),
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stdin: { write: () => 0, flush: () => 0 },
        stderrTail: () => "",
      };
    };
    server = new ClaudeWsServer({ spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const captured: string[] = [];
    server.onStderrLine = (_sid, line) => captured.push(line);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "hi", transport: "stdio" });
    server.spawnClaude(sessionId);

    const CAP = 64 * 1024;
    // 200 KiB with no newline — must NOT accumulate unbounded; it is force-split.
    onStderr?.("X".repeat(CAP * 3 + 100));
    // Slices emitted while over the cap; a sub-cap remainder waits for EOF.
    expect(captured.length).toBe(3);
    expect(captured.every((l) => l.length === CAP)).toBe(true);
    onStderrEnd?.();
    // The trailing remainder is flushed on exit; no bytes are dropped.
    expect(captured.length).toBe(4);
    expect(captured[3]?.length).toBe(100);
    expect(captured.reduce((n, l) => n + l.length, 0)).toBe(CAP * 3 + 100);
  });

  test("restored session without transport defaults to ws (fallback path)", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    const port = await server.start(0);

    const sessionId = "restored-no-transport";
    server.restoreSessions([
      {
        sessionId,
        pid: null,
        state: "idle",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        worktree: null,
        totalCost: 0,
        totalTokens: 0,
        claudeSessionId: "claude-sess-fallback",
      },
    ]);

    server.reviveSession(sessionId, "follow-up prompt");

    expect(mock.lastCmd).toContain("--sdk-url");
    expect(mock.lastCmd.some((a: string) => a.startsWith(`ws://localhost:${port}/`))).toBe(true);
    // WS uses --sdk-url and must not carry the stdio-only flags.
    expect(mock.lastCmd).not.toContain("--verbose");
    expect(mock.lastCmd).not.toContain("--include-partial-messages");
  });

  test("contained/worktree spawn over stdio is refused fail-closed (#2688)", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, {
      prompt: "test",
      transport: "stdio",
      worktree: "/tmp/wt",
      cwd: "/tmp/wt",
    });

    expect(() => server.spawnClaude(sessionId)).toThrow("stdio transport does not support ContainmentGuard — use ws");
    // Refusal must happen before spawn — no child process started.
    expect(mock.lastCmd).toEqual([]);
  });

  test("non-worktree stdio spawn is allowed", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
    });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "test", transport: "stdio" });

    expect(() => server.spawnClaude(sessionId)).not.toThrow();
    expect(mock.lastCmd).toContain("--print");
  });

  test("stdio stream_event advances the StuckDetector liveness window (#2688)", async () => {
    const mock = mockStdioSpawn();
    const clock = new FakeClock();
    const monitorEvents: MonitorEventInput[] = [];
    server = new ClaudeWsServer({
      spawn: mock.spawn,
      logger: silentLogger,
      connectTimeoutMs: 5000,
      stuckConfig: { thresholdsMs: [100, 200, 300], repeatMs: 300 },
      stuckClock: clock,
    });
    server.onMonitorEvent = (input) => monitorEvents.push(input);
    await server.start(0);

    const sessionId = crypto.randomUUID();
    server.prepareSession(sessionId, { prompt: "test", transport: "stdio" });
    server.spawnClaude(sessionId);

    // Drive the session to "active" — records initial progress at virtual t=0,
    // scheduling the tier-1 stuck timer for t=100.
    mock.pushStdout(systemInitMessage(sessionId));
    mock.pushStdout(assistantMessage(sessionId));
    await pollUntil(() => server?.listSessions().some((s) => s.state === "active") ?? false, 1000);

    const stuckCount = () => monitorEvents.filter((e) => e.event === "session.stuck").length;

    // Just shy of the threshold: no stuck event yet.
    clock.advance(99);
    expect(stuckCount()).toBe(0);

    // A stream_event arrives — its handler records progress at t=99, which must
    // reschedule the tier-1 timer to t=199 (cancelling the original t=100 timer).
    mock.pushStdout(streamEventMessage(sessionId));
    await pollUntil(
      () =>
        server?.getTranscript(sessionId).some((e) => e.direction === "inbound" && e.message.type === "stream_event") ??
        false,
      1000,
    );

    // Past the ORIGINAL threshold (t=149) but before the advanced one: still no
    // stuck — proves the window moved forward because of the stream_event.
    clock.advance(50);
    expect(stuckCount()).toBe(0);

    // Past the advanced threshold (t=209 ≥ 199): the tier-1 stuck now fires.
    clock.advance(60);
    expect(stuckCount()).toBe(1);
    expect(monitorEvents.find((e) => e.event === "session.stuck")?.tier).toBe(1);
  });

  // ── Transport write-failure handling (#2562) ──
  // A failed stdio write (SIGPIPE / broken pipe on child crash) must not leave
  // the state machine believing a prompt is being processed. The session is
  // transitioned to disconnected and the error is surfaced to the caller.

  async function driveToIdle(
    mock: ReturnType<typeof mockStdioSpawn>,
    server: ClaudeWsServer,
    sessionId: string,
    events: Array<{ type: string }>,
  ): Promise<void> {
    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);
    mock.pushStdout(`${resultMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:result"), 1000);
  }

  test("sendPrompt throws and disconnects when stdio write fails", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => events.push(event);

    server.prepareSession(sessionId, { prompt: "first", transport: "stdio" });
    server.spawnClaude(sessionId);
    await driveToIdle(mock, server, sessionId, events);

    // Pipe breaks before the follow-up prompt is written.
    mock.failWrites(new Error("EPIPE: broken pipe"));

    expect(() => server.sendPrompt(sessionId, "second")).toThrow(/transport write failed/);

    // State machine must not be left in active/processing — it is disconnected.
    const session = server.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.state).toBe("disconnected");
    expect(events.some((e) => e.type === "session:disconnected")).toBe(true);

    // stdio has no reconnect path — the child must be killed, not orphaned. (#2793)
    await pollUntil(() => mock.killed, 1000);
    expect(mock.killed).toBe(true);
  });

  test("interrupt throws and disconnects when stdio write fails", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => events.push(event);

    server.prepareSession(sessionId, { prompt: "first", transport: "stdio" });
    server.spawnClaude(sessionId);
    await driveToIdle(mock, server, sessionId, events);

    mock.failWrites(new Error("EPIPE: broken pipe"));

    expect(() => server.interrupt(sessionId, "stop")).toThrow(/transport write failed/);

    const session = server.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.state).toBe("disconnected");
    // A failed interrupt must not stash a pending reason on a dead session.
    expect(events.some((e) => e.type === "session:disconnected")).toBe(true);
  });

  test("respondToPermission throws and disconnects when stdio write fails", async () => {
    const mock = mockStdioSpawn();
    server = new ClaudeWsServer({ spawn: mock.spawn, logger: silentLogger, connectTimeoutMs: 5000 });
    await server.start(0);

    const sessionId = crypto.randomUUID();
    const events: Array<{ type: string }> = [];
    server.onSessionEvent = (_sid, event) => events.push(event);

    // `delegate` strategy leaves the can_use_tool request pending for an external
    // responder instead of auto-answering it, so the public respondToPermission
    // path is the one exercised below.
    server.prepareSession(sessionId, { prompt: "first", transport: "stdio", permissionStrategy: "delegate" });
    server.spawnClaude(sessionId);

    mock.pushStdout(`${systemInitMessage(sessionId)}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:init"), 1000);
    mock.pushStdout(`${canUseToolMessage("req-1")}\n`);
    await pollUntil(() => events.some((e) => e.type === "session:permission_request"), 1000);

    // Pipe breaks before the permission response is written.
    mock.failWrites(new Error("EPIPE: broken pipe"));

    expect(() => server.respondToPermission(sessionId, "req-1", true)).toThrow(/transport write failed/);

    const session = server.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.state).toBe("disconnected");
    expect(events.some((e) => e.type === "session:disconnected")).toBe(true);
  });
});
