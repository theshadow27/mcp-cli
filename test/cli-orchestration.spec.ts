/**
 * CLI→daemon orchestration smoke tests using the mock agent provider.
 *
 * Exercises the full orchestration surface: CLI arg parsing, flag forwarding,
 * daemon tool calls, session state machine, and event subscriptions.
 * Uses real `mcx` CLI process, real daemon, mock sessions.
 *
 * @see https://github.com/theshadow27/mcp-cli/issues/1007
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestDaemon } from "./harness";
import { pollUntil, rpc, startTestDaemon } from "./harness";

// Integration tests with real daemon + CLI processes
setDefaultTimeout(30_000);

const MCX_SCRIPT = resolve("packages/command/src/main.ts");

/** Run `mcx` as a child process with isolated MCP_CLI_DIR */
async function mcx(
  dir: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", MCX_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MCP_CLI_DIR: dir },
  });

  const timeout = opts?.timeout ?? 15_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr: timedOut ? `[TIMEOUT after ${timeout}ms] ${stderr}` : stderr,
  };
}

/** Write a mock script JSON file and return its absolute path */
function writeScript(dir: string, name: string, entries: Array<{ delay: number; text: string }>): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("CLI→daemon orchestration (mock provider)", () => {
  let daemon: TestDaemon;
  let scriptPath: string;

  beforeAll(async () => {
    // Start daemon with no external servers — mock is built-in
    daemon = await startTestDaemon({});
    // Write a simple mock script: two entries, no delays
    scriptPath = writeScript(daemon.dir, "simple", [
      { delay: 0, text: "Hello from mock" },
      { delay: 0, text: "Done" },
    ]);
  });

  afterAll(async () => {
    await daemon.kill();
  });

  // ── Session lifecycle ──────────────────────────────────────────────

  describe("session lifecycle", () => {
    test("spawn → ls → wait → bye", async () => {
      // Spawn a mock session via RPC (exercises daemon tool dispatch)
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: scriptPath, cwd: daemon.dir },
      });
      expect(spawnRes.error).toBeUndefined();
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;
      expect(sessionId).toBeTruthy();

      // Wait for script to complete (state → idle)
      await pollUntil(async () => {
        const statusRes = await rpc(daemon.socketPath, "callTool", {
          server: "_mock",
          tool: "mock_session_status",
          arguments: { sessionId },
        });
        const status = JSON.parse((statusRes.result as { content: Array<{ text: string }> }).content[0].text);
        return status.state === "idle";
      });

      // Session list shows the session
      const listRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_session_list",
        arguments: {},
      });
      const list = JSON.parse((listRes.result as { content: Array<{ text: string }> }).content[0].text);
      expect(list.length).toBeGreaterThanOrEqual(1);
      const found = list.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(found).toBeTruthy();
      expect(found.state).toBe("idle");

      // Bye ends the session
      const byeRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
      const byeResult = JSON.parse((byeRes.result as { content: Array<{ text: string }> }).content[0].text);
      expect(byeResult.ended).toBe(true);
    });

    test("transcript returns script output", async () => {
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: scriptPath, cwd: daemon.dir, wait: true },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      const transcriptRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_transcript",
        arguments: { sessionId },
      });
      const transcript = JSON.parse((transcriptRes.result as { content: Array<{ text: string }> }).content[0].text);
      // First entry is the user prompt, rest are assistant responses
      expect(transcript.length).toBe(3);
      expect(transcript[0].role).toBe("user");
      expect(transcript[1]).toEqual({ role: "assistant", text: "Hello from mock" });
      expect(transcript[2]).toEqual({ role: "assistant", text: "Done" });

      // Clean up
      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });
  });

  // ── CLI flag forwarding ────────────────────────────────────────────

  describe("CLI flag forwarding", () => {
    test("mcx agent mock spawn --wait blocks until complete", async () => {
      const result = await mcx(daemon.dir, ["agent", "mock", "spawn", "--task", scriptPath, "--wait"]);
      // --wait should block until done and print the result
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("session:result");
    });

    test("mcx agent mock ls shows sessions", async () => {
      // Spawn a session first
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: scriptPath, cwd: daemon.dir, wait: true },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      const result = await mcx(daemon.dir, ["agent", "mock", "ls", "--json"]);
      expect(result.exitCode).toBe(0);

      const sessions = JSON.parse(result.stdout);
      expect(Array.isArray(sessions)).toBe(true);
      const found = sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(found).toBeTruthy();

      // Clean up
      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });
  });

  // ── Wait behavior (#913 regression suite) ──────────────────────────

  describe("wait behavior", () => {
    test("wait returns immediately when session already idle", async () => {
      // Spawn with wait=true so session completes before we call wait
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: scriptPath, cwd: daemon.dir, wait: true },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      const start = Date.now();
      const waitRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_wait",
        arguments: { sessionId, timeout: 5000 },
      });
      const elapsed = Date.now() - start;
      const waitResult = JSON.parse((waitRes.result as { content: Array<{ text: string }> }).content[0].text);

      // Should return immediately (well under timeout) with session:result
      expect(elapsed).toBeLessThan(3000);
      expect(waitResult.type).toBe("session:result");

      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });

    test("wait --timeout returns after timeout when no events", async () => {
      // Wait for a non-existent session — should timeout
      const start = Date.now();
      const waitRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_wait",
        arguments: { afterSeq: 999999, timeout: 500 },
      });
      const elapsed = Date.now() - start;

      // Should take approximately the timeout duration
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(waitRes.error).toBeUndefined();
    });

    test("wait detects state change from running script", async () => {
      // Write a slow script with a delay
      const slowScript = writeScript(daemon.dir, "slow", [
        { delay: 200, text: "Step 1" },
        { delay: 200, text: "Step 2" },
      ]);

      // Spawn without wait
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: slowScript, cwd: daemon.dir },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      // Wait should return when script completes (before timeout)
      const waitRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_wait",
        arguments: { sessionId, timeout: 10000 },
      });
      const waitResult = JSON.parse((waitRes.result as { content: Array<{ text: string }> }).content[0].text);
      expect(waitResult.type).toBe("session:result");

      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });
  });

  // ── Interrupt ──────────────────────────────────────────────────────

  describe("interrupt", () => {
    test("interrupt stops a running script", async () => {
      // Write a script with long delays
      const longScript = writeScript(daemon.dir, "long", [
        { delay: 50, text: "Entry 1" },
        { delay: 5000, text: "Entry 2 - should be skipped" },
        { delay: 5000, text: "Entry 3 - should be skipped" },
      ]);

      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: longScript, cwd: daemon.dir },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      // Wait for the session to enter running state before interrupting
      await pollUntil(async () => {
        const statusRes = await rpc(daemon.socketPath, "callTool", {
          server: "_mock",
          tool: "mock_session_status",
          arguments: { sessionId },
        });
        const status = JSON.parse((statusRes.result as { content: Array<{ text: string }> }).content[0].text);
        return status.state === "running";
      });

      const intRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_interrupt",
        arguments: { sessionId },
      });
      const intResult = JSON.parse((intRes.result as { content: Array<{ text: string }> }).content[0].text);
      expect(intResult.interrupted).toBe(true);

      // Wait for script to finish (should be fast since interrupted)
      await pollUntil(async () => {
        const statusRes = await rpc(daemon.socketPath, "callTool", {
          server: "_mock",
          tool: "mock_session_status",
          arguments: { sessionId },
        });
        const status = JSON.parse((statusRes.result as { content: Array<{ text: string }> }).content[0].text);
        return status.state === "idle";
      });

      // Transcript should NOT have all entries
      const transcriptRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_transcript",
        arguments: { sessionId },
      });
      const transcript = JSON.parse((transcriptRes.result as { content: Array<{ text: string }> }).content[0].text);
      // Should have user prompt + at most entry 1 (entry 2 and 3 skipped)
      expect(transcript.length).toBeLessThan(4); // fewer than all 3 entries + user prompt

      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });
  });

  // ── afterSeq cursor-based wait ─────────────────────────────────────

  describe("afterSeq cursor", () => {
    test("afterSeq returns buffered events immediately", async () => {
      // Spawn and wait for completion to generate events
      const spawnRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_prompt",
        arguments: { prompt: scriptPath, cwd: daemon.dir, wait: true },
      });
      const spawnResult = JSON.parse((spawnRes.result as { content: Array<{ text: string }> }).content[0].text);
      const sessionId: string = spawnResult.sessionId;

      // afterSeq=0 should return the first buffered event immediately
      const start = Date.now();
      const waitRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_wait",
        arguments: { afterSeq: 0, sessionId, timeout: 5000 },
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000);

      const event = JSON.parse((waitRes.result as { content: Array<{ text: string }> }).content[0].text);
      expect(event.seq).toBeGreaterThan(0);
      expect(event.sessionId).toBe(sessionId);

      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });
  });
});
