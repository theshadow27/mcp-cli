import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@mcp-cli/core";
import { pollUntil } from "../../../../test/harness";
import type { SpawnFn } from "./ws-server";
import { ClaudeWsServer } from "./ws-server";

// Real subprocess startup × N concurrent sessions; the burst itself drains in
// well under a second once spawned.
setDefaultTimeout(15_000);

function ndjson(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Build a full stdio stream-json transcript: system/init → N large assistant
 * messages → result. The result line is emitted LAST, so a session that
 * reaches session:result has provably drained every preceding burst byte.
 */
function burstTranscript(lines: number, lineBytes: number): string {
  const sessionId = "burst";
  let out = ndjson({
    type: "system",
    subtype: "init",
    cwd: "/test",
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    apiKeySource: "test",
    claude_code_version: "2.1.130",
    uuid: "burst-init",
  });
  const blob = "x".repeat(lineBytes);
  for (let i = 0; i < lines; i++) {
    out += ndjson({
      type: "assistant",
      message: {
        id: `burst-msg-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: blob }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      uuid: `burst-assistant-${i}`,
      session_id: sessionId,
    });
  }
  out += ndjson({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "burst done",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: "burst-result",
    session_id: sessionId,
  });
  return out;
}

/**
 * Real-pipe spawn: streams the pre-generated transcript through a subprocess,
 * so the daemon's stdio drain loop reads from a genuine OS pipe (not an
 * in-memory ReadableStream stub) and the child blocks on a full pipe if the
 * drain stalls. This is the only way to exercise real pipe-buffer backpressure
 * — the deadlock #2234 flagged lives in that path — while keeping per-spawn CPU
 * cost low enough to avoid starving the parallel test runner (a heavier `bun`
 * fixture tipped neighbour tests over their timeouts).
 *
 * The child MUST keep stdin open until it exits, to be faithful to the stdio
 * contract a real `claude` child honors: the daemon writes the initial prompt
 * to stdin (startStdioReader → sendToSession) before wiring the reader. A bare
 * `cat <file>` exits the instant it finishes streaming the file and never reads
 * stdin, so under runner contention its stdin pipe is already closed when that
 * write lands → EPIPE → failSend → disconnectSession flips the session to
 * `disconnected` before drain starts, and the #2814 handleStdioLine guard then
 * drops the buffered trailing `result` line — session:result never fires and
 * the test dead-waits to its 12s budget (#2825 round 2). `cat "$1"; cat
 * >/dev/null` streams the transcript, then drains stdin to EOF so the prompt
 * write cannot EPIPE (proven 0/10 stalls vs 8/10 for bare cat at load avg 340).
 */
function catSpawn(transcriptPath: string): SpawnFn {
  return (() => {
    const proc = Bun.spawn(["sh", "-c", 'cat "$1"; cat >/dev/null', "_", transcriptPath], {
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
    });
    return {
      pid: proc.pid,
      exited: proc.exited.then((code) => code ?? 0),
      kill: (signal?: number) => proc.kill(signal),
      stdout: proc.stdout,
      stdin: proc.stdin,
      stderrTail: () => "",
    };
  }) as SpawnFn;
}

describe("ClaudeWsServer — stdio multi-session load/drain (#2739)", () => {
  let server: ClaudeWsServer;
  let tmpDir: string;

  afterEach(async () => {
    await server?.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("N concurrent stdio sessions each drain a large burst with no pipe stall", async () => {
    const N = 8;
    const LINES = 64;
    // 64 × 8 KiB ≈ 512 KiB per session — ~8× the typical 64 KiB pipe buffer,
    // so a stalled drain blocks the child before its trailing result line.
    const LINE_BYTES = 8 * 1024;

    tmpDir = mkdtempSync(join(tmpdir(), "mcx-stdio-load-"));
    const transcriptPath = join(tmpDir, "burst.ndjson");
    writeFileSync(transcriptPath, burstTranscript(LINES, LINE_BYTES));

    server = new ClaudeWsServer({
      spawn: catSpawn(transcriptPath),
      logger: silentLogger,
      connectTimeoutMs: 10_000,
    });
    await server.start(0);

    const responses = new Map<string, number>();
    const done = new Set<string>();
    server.onSessionEvent = (sid, ev) => {
      if (ev.type === "session:response") responses.set(sid, (responses.get(sid) ?? 0) + 1);
      if (ev.type === "session:result") done.add(sid);
    };

    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      server.prepareSession(id, { prompt: `burst ${i}`, transport: "stdio" });
      server.spawnClaude(id);
    }

    // NDJSON over a pipe is ordered and result is last, so done.size === N
    // proves every session drained its entire burst — no stall, no truncation.
    await pollUntil(() => done.size === N, 12_000);

    for (const id of ids) {
      expect(done.has(id)).toBe(true);
      // Sanity: the burst was parsed and dispatched, not silently dropped.
      expect(responses.get(id) ?? 0).toBeGreaterThan(0);
    }
  });
});
