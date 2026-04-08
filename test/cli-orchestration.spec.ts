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
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  opts?: { timeout?: number; cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", MCX_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
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

    test("--allow does not eat --task positional arg (#910 regression)", async () => {
      // Regression guard for #910 P1-3: --allow must stop consuming args
      // at the next non-tool-name token. If --allow eats --task, the spawn
      // will fail because no task is provided.
      const result = await mcx(daemon.dir, [
        "agent",
        "mock",
        "spawn",
        "--allow",
        "Bash",
        "Read",
        "--task",
        scriptPath,
        "--wait",
      ]);
      expect(result.stdout).toContain("session:result");
      expect(result.exitCode).toBe(0);

      // Double-check: parse the sessionId and verify transcript shows
      // the script path as the user prompt (not "Bash" or "Read")
      const waitResult = JSON.parse(result.stdout.trim());
      const sessionId: string = waitResult.sessionId;

      const transcriptRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_transcript",
        arguments: { sessionId },
      });
      const transcript = JSON.parse((transcriptRes.result as { content: Array<{ text: string }> }).content[0].text);
      // First entry is the user prompt — should be the script file path
      expect(transcript[0].role).toBe("user");
      expect(transcript[0].text).toBe(scriptPath);

      await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_bye",
        arguments: { sessionId },
      });
    });

    test("--model flag is accepted and forwarded", async () => {
      const result = await mcx(daemon.dir, [
        "agent",
        "mock",
        "spawn",
        "--model",
        "haiku",
        "--task",
        scriptPath,
        "--wait",
      ]);
      // Spawn should succeed — model flag parsed without error
      expect(result.stdout).toContain("session:result");
      expect(result.exitCode).toBe(0);
    });

    test("--resume rejected for provider without native resume", async () => {
      // Mock provider has resume: false — --resume should be rejected at parse time
      const result = await mcx(daemon.dir, [
        "agent",
        "mock",
        "spawn",
        "--resume",
        "fake-session-id",
        "--task",
        scriptPath,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--resume is not supported");
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

  // ── Worktree flag ──────────────────────────────────────────────────

  describe("--worktree flag", () => {
    let gitDir: string;

    beforeAll(() => {
      // Create a bare git repo in a temp directory for worktree tests
      gitDir = mkdtempSync(join(tmpdir(), "mcp-wt-test-"));
      execSync("git init && git commit --allow-empty -m init", {
        cwd: gitDir,
        stdio: "pipe",
      });
      // Enable worktree creation without branch prefix
      writeFileSync(join(gitDir, ".mcx-worktree.json"), JSON.stringify({ worktree: { branchPrefix: false } }));
    });

    afterAll(() => {
      // Clean up worktrees before removing the dir (git requires this order)
      try {
        execSync("git worktree prune", { cwd: gitDir, stdio: "pipe" });
      } catch {
        // best-effort
      }
      rmSync(gitDir, { recursive: true, force: true });
    });

    test("--worktree creates worktree and session runs in it", async () => {
      const wtName = `test-wt-${Date.now().toString(36)}`;
      const result = await mcx(
        daemon.dir,
        ["agent", "mock", "spawn", "--worktree", wtName, "--task", scriptPath, "--wait"],
        { cwd: gitDir },
      );

      expect(result.stderr).toContain("Created worktree:");
      expect(result.stdout).toContain("session:result");
      expect(result.exitCode).toBe(0);

      // Verify worktree directory was created
      const wtPath = join(gitDir, ".claude", "worktrees", wtName);
      expect(existsSync(wtPath)).toBe(true);

      // Verify session ran inside the worktree (cwd should be the worktree path)
      const waitResult = JSON.parse(result.stdout.trim());
      const sessionId: string = waitResult.sessionId;

      const statusRes = await rpc(daemon.socketPath, "callTool", {
        server: "_mock",
        tool: "mock_session_status",
        arguments: { sessionId },
      });
      const status = JSON.parse((statusRes.result as { content: Array<{ text: string }> }).content[0].text);
      // macOS /var → /private/var symlink: normalize both paths
      const { realpathSync } = await import("node:fs");
      expect(realpathSync(status.cwd)).toBe(realpathSync(wtPath));

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

      // Wait a bit for the script to start, then interrupt
      await Bun.sleep(100);
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
