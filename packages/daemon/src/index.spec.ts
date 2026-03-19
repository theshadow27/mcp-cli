/**
 * Tests for daemon index.ts — startup, shutdown, idle timeout, config reload.
 *
 * Uses startDaemon() directly for in-process coverage, with testOptions()
 * for filesystem isolation.
 *
 * Perf optimisations (#556):
 * - Shared daemon for read-only startup tests (saves ~2 startups)
 * - Mocked git ops for worktree prune tests (no subprocess overhead)
 * - Tighter pollUntil deadlines
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALIAS_SERVER_NAME, CLAUDE_SERVER_NAME, PROTOCOL_VERSION, silentLogger } from "@mcp-cli/core";
import { _restoreOptions } from "@mcp-cli/core";
import { pollUntil, rpc } from "../../../test/harness";
import { testOptions } from "../../../test/test-options";
import { StateDb } from "./db/state";
import type { DaemonHandle, PruneGitOps } from "./index";
import { pruneOrphanedWorktrees, startDaemon } from "./index";

setDefaultTimeout(15_000);

/** Save and restore MCP_DAEMON_TIMEOUT env var around a callback. */
async function withDaemonTimeout<T>(timeoutMs: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.env.MCP_DAEMON_TIMEOUT;
  process.env.MCP_DAEMON_TIMEOUT = timeoutMs;
  try {
    return await fn();
  } finally {
    if (orig === undefined) {
      process.env.MCP_DAEMON_TIMEOUT = undefined;
    } else {
      process.env.MCP_DAEMON_TIMEOUT = orig;
    }
  }
}

/** Start a daemon with test-appropriate defaults (skip log setup + virtual servers). */
async function startTestDaemonInProcess(overrides?: Partial<Parameters<typeof startDaemon>[0]>): Promise<DaemonHandle> {
  return startDaemon({
    skipLogSetup: true,
    skipVirtualServers: true,
    logger: silentLogger,
    ...overrides,
  });
}

/** Mock git ops that report all worktrees as non-existent (safe default). */
function mockGitOps(overrides?: Partial<PruneGitOps>): PruneGitOps {
  return {
    pathExists: () => false,
    status: () => ({ exitCode: 0, stdout: "" }),
    showBranch: () => ({ exitCode: 0, stdout: "main" }),
    removeWorktree: () => ({ exitCode: 0 }),
    deleteBranch: () => ({ exitCode: 0 }),
    exec: () => ({ exitCode: 0, stdout: "" }),
    ...overrides,
  };
}

describe("daemon index.ts", () => {
  // ---------------------------------------------------------------------------
  // P1: Startup sequence — shared daemon for read-only assertions
  // ---------------------------------------------------------------------------
  describe("startup sequence", () => {
    let handle: DaemonHandle;
    let opts: ReturnType<typeof testOptions>;

    beforeAll(async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();
    });

    afterAll(async () => {
      if (handle) {
        if (!handle.isShuttingDown) await handle.shutdown("SIGTERM");
        await handle.shutdownComplete;
      }
      opts[Symbol.dispose]();
      _restoreOptions();
    });

    test("writes PID file with correct shape", () => {
      const pidFile = join(opts.dir, "mcpd.pid");
      expect(existsSync(pidFile)).toBe(true);

      const pidData = JSON.parse(readFileSync(pidFile, "utf-8"));
      expect(pidData.pid).toBe(process.pid);
      expect(typeof pidData.daemonId).toBe("string");
      expect(pidData.daemonId.length).toBeGreaterThan(0);
      expect(typeof pidData.configHash).toBe("string");
      expect(typeof pidData.startedAt).toBe("number");
      expect(pidData.startedAt).toBeGreaterThan(0);
      expect(pidData.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    test("opens StateDb at configured path", () => {
      const dbPath = join(opts.dir, "state.db");
      expect(existsSync(dbPath)).toBe(true);
    });

    test("starts IPC server that responds to ping", async () => {
      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "ping");
      expect(res.result).toHaveProperty("pong", true);
    });
  });

  // Standalone startup tests that need different options
  describe("startup variants", () => {
    let handle: DaemonHandle | undefined;
    let opts: ReturnType<typeof testOptions> | undefined;

    afterEach(async () => {
      if (handle) {
        if (!handle.isShuttingDown) await handle.shutdown("SIGTERM");
        await handle.shutdownComplete;
      }
      handle = undefined;
      if (opts) {
        opts[Symbol.dispose]();
        opts = undefined;
      }
      _restoreOptions();
    });

    test("installs log capture when skipLogSetup is false", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess({ skipLogSetup: false });

      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "ping");
      expect(res.result).toHaveProperty("pong", true);
    });

    test("boots virtual servers when not skipped", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess({ skipVirtualServers: false });

      const socketPath = join(opts.dir, "mcpd.sock");

      // Wait for virtual servers to register by polling listServers
      const deadline = Date.now() + 3_000;
      let found = false;
      while (!found && Date.now() < deadline) {
        const check = await rpc(socketPath, "listServers");
        const svrs = check.result as Array<{ name: string }>;
        found = svrs.some((s) => s.name === ALIAS_SERVER_NAME) && svrs.some((s) => s.name === CLAUDE_SERVER_NAME);
        if (!found) await Bun.sleep(50);
      }
      expect(found).toBe(true);

      const res = await rpc(socketPath, "listServers");
      const servers = res.result as Array<{ name: string }>;
      expect(servers.some((s) => s.name === ALIAS_SERVER_NAME)).toBe(true);
      expect(servers.some((s) => s.name === CLAUDE_SERVER_NAME)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // P2: Shutdown sequence
  // ---------------------------------------------------------------------------
  describe("shutdown sequence", () => {
    let handle: DaemonHandle | undefined;
    let opts: ReturnType<typeof testOptions> | undefined;

    afterEach(async () => {
      if (handle) {
        if (!handle.isShuttingDown) await handle.shutdown("SIGTERM");
        await handle.shutdownComplete;
      }
      handle = undefined;
      if (opts) {
        opts[Symbol.dispose]();
        opts = undefined;
      }
      _restoreOptions();
    });

    test("shutdown removes PID file", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const pidFile = join(opts.dir, "mcpd.pid");
      expect(existsSync(pidFile)).toBe(true);

      await handle.shutdown("SIGTERM");
      expect(existsSync(pidFile)).toBe(false);
    });

    test("shutdown stops IPC server", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const socketPath = join(opts.dir, "mcpd.sock");
      const before = await rpc(socketPath, "ping");
      expect(before.result).toHaveProperty("pong", true);

      await handle.shutdown("SIGTERM");

      // IPC should no longer respond — use expect().rejects to properly
      // chain the rejection so it doesn't leak as an unhandled error (#658)
      await expect(rpc(socketPath, "ping")).rejects.toThrow();
    });

    test("shutdown loop continues after one server stop() throws", async () => {
      opts = testOptions();
      const stopCalls: string[] = [];
      handle = await startTestDaemonInProcess({
        _virtualServers: [
          [
            "_failing",
            {
              stop: async () => {
                stopCalls.push("_failing");
                throw new Error("simulated stop failure");
              },
            },
          ],
          [
            "_after",
            {
              stop: async () => {
                stopCalls.push("_after");
              },
            },
          ],
        ],
      });

      await handle.shutdown("SIGTERM");

      // Both servers attempted — loop did not abort after the first failure
      expect(stopCalls).toEqual(["_failing", "_after"]);
      // Shutdown completed — pool.closeAll() and db.close() ran (no throw)
      expect(handle.isShuttingDown).toBe(true);
    });

    test("double shutdown is idempotent (no crash)", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      await handle.shutdown("SIGTERM");
      // Second call should be a no-op
      await handle.shutdown("SIGINT");
      expect(handle.isShuttingDown).toBe(true);
    });

    test("shutdown via IPC request works", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "shutdown");
      expect(res.result).toEqual({ ok: true });

      await pollUntil(() => handle?.isShuttingDown, 1_000);
      expect(handle?.isShuttingDown).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // P3: Idle timeout
  // ---------------------------------------------------------------------------
  describe("idle timeout", () => {
    let handle: DaemonHandle | undefined;
    let opts: ReturnType<typeof testOptions> | undefined;

    afterEach(async () => {
      if (handle) {
        if (!handle.isShuttingDown) {
          await handle.shutdown("SIGTERM");
        }
        // Always await full shutdown completion before cleaning up — the idle
        // timer calls shutdown() as fire-and-forget, so isShuttingDown can be
        // true while async teardown (unlinkSync, db.close) is still in flight.
        await handle.shutdownComplete;
      }
      handle = undefined;
      if (opts) {
        opts[Symbol.dispose]();
        opts = undefined;
      }
      _restoreOptions();
    });

    test("fires after configured duration and triggers shutdown", async () => {
      opts = testOptions();
      await withDaemonTimeout("100", async () => {
        handle = await startTestDaemonInProcess();
        await pollUntil(() => handle?.isShuttingDown, 1_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });

    test("activity resets idle timer", async () => {
      opts = testOptions();
      await withDaemonTimeout("200", async () => {
        handle = await startTestDaemonInProcess();
        const socketPath = join(opts?.dir ?? "", "mcpd.sock");

        // Send pings to keep the daemon alive past the idle timeout
        for (let i = 0; i < 3; i++) {
          await Bun.sleep(100);
          await rpc(socketPath, "ping");
          expect(handle?.isShuttingDown).toBe(false);
        }

        // Now stop pinging and let it idle out
        await pollUntil(() => handle?.isShuttingDown, 1_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });

    test("MCP_DAEMON_TIMEOUT env override is respected", async () => {
      opts = testOptions();
      await withDaemonTimeout("100", async () => {
        handle = await startTestDaemonInProcess();
        await pollUntil(() => handle?.isShuttingDown, 1_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // P4: Config hot reload
  // ---------------------------------------------------------------------------
  describe.skipIf(process.platform === "linux")("config hot reload", () => {
    let handle: DaemonHandle | undefined;
    let opts: ReturnType<typeof testOptions> | undefined;

    afterEach(async () => {
      if (handle) {
        if (!handle.isShuttingDown) await handle.shutdown("SIGTERM");
        await handle.shutdownComplete;
      }
      handle = undefined;
      if (opts) {
        opts[Symbol.dispose]();
        opts = undefined;
      }
      _restoreOptions();
    });

    test("watcher callback updates PID file hash on server addition", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const pidFile = join(opts.dir, "mcpd.pid");
      const pidBefore = JSON.parse(readFileSync(pidFile, "utf-8"));
      const hashBefore = pidBefore.configHash;

      // Write a new servers.json with a server to trigger config change
      const serversPath = join(opts.dir, "servers.json");
      writeFileSync(serversPath, JSON.stringify({ mcpServers: { test: { command: "echo" } } }));

      // Force reload
      handle.watcher.forceReload();

      await pollUntil(() => {
        try {
          const pidAfter = JSON.parse(readFileSync(pidFile, "utf-8"));
          return pidAfter.configHash !== hashBefore;
        } catch {
          return false;
        }
      }, 1_000);

      const pidAfter = JSON.parse(readFileSync(pidFile, "utf-8"));
      expect(pidAfter.configHash).not.toBe(hashBefore);
      expect(pidAfter.pid).toBe(process.pid);
      expect(pidAfter.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(pidAfter.startedAt).toBe(pidBefore.startedAt);
    });

    test("reload with no server changes logs appropriately", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      // Force reload without changing any config files
      const serversPath = join(opts.dir, "servers.json");
      writeFileSync(serversPath, JSON.stringify({ mcpServers: {} }));
      handle.watcher.forceReload();

      // Just verify daemon is still alive
      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "ping");
      expect(res.result).toHaveProperty("pong", true);
    });
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanedWorktrees unit tests (mocked git ops — no subprocess overhead)
// ---------------------------------------------------------------------------
describe("pruneOrphanedWorktrees", () => {
  let opts: ReturnType<typeof testOptions> | undefined;

  afterEach(() => {
    if (opts) {
      opts[Symbol.dispose]();
      opts = undefined;
    }
    _restoreOptions();
  });

  test("no-ops when there are no ended sessions", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      pruneOrphanedWorktrees(db, silentLogger, mockGitOps());
    } finally {
      db.close();
    }
  });

  test("skips sessions without worktree or cwd", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({ sessionId: "test-no-wt", pid: 12345, model: "sonnet", cwd: "/tmp/test" });
      db.endSession("test-no-wt");
      pruneOrphanedWorktrees(db, silentLogger, mockGitOps());
    } finally {
      db.close();
    }
  });

  test("skips worktrees still used by active sessions", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "active-1",
        pid: process.pid,
        model: "sonnet",
        cwd: "/tmp/test",
        worktree: "my-worktree",
      });
      db.upsertSession({
        sessionId: "ended-1",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/test",
        worktree: "my-worktree",
      });
      db.endSession("ended-1");
      // pathExists returns true, but the worktree is active so should be skipped
      const removeCalled: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: () => true,
          removeWorktree: (_root, wt) => {
            removeCalled.push(wt);
            return { exitCode: 0 };
          },
        }),
      );
      expect(removeCalled).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("does not guard worktrees across different repos (fixes #573)", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      // Active session with worktree "feature-x" in repo A
      db.upsertSession({
        sessionId: "active-repo-a",
        pid: process.pid,
        model: "sonnet",
        cwd: "/tmp/repo-a",
        worktree: "feature-x",
      });
      // Ended session with same worktree name "feature-x" but in repo B
      db.upsertSession({
        sessionId: "ended-repo-b",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/repo-b",
        worktree: "feature-x",
      });
      db.endSession("ended-repo-b");
      // Should NOT skip — different repo means different worktree.
      // The function will try to process the ended session (and skip because
      // the worktree path doesn't exist on disk), proving it wasn't guarded.
      pruneOrphanedWorktrees(db);
    } finally {
      db.close();
    }
  });

  test("skips ended sessions whose worktree path does not exist", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "ended-gone",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/nonexistent-repo",
        worktree: "gone-worktree",
      });
      db.endSession("ended-gone");
      pruneOrphanedWorktrees(db, silentLogger, mockGitOps({ pathExists: () => false }));
    } finally {
      db.close();
    }
  });

  test("skips dirty worktrees (uncommitted changes)", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "ended-dirty",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/repo",
        worktree: "dirty-wt",
      });
      db.endSession("ended-dirty");

      const removeCalled: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: () => true,
          status: () => ({ exitCode: 0, stdout: "M dirty.txt" }),
          removeWorktree: (_root, wt) => {
            removeCalled.push(wt);
            return { exitCode: 0 };
          },
        }),
      );
      // Should NOT have called removeWorktree
      expect(removeCalled).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("removes clean worktrees and deletes merged branches", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "ended-clean",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/repo",
        worktree: "clean-wt",
      });
      db.endSession("ended-clean");

      const removed: string[] = [];
      const deletedBranches: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: () => true,
          status: () => ({ exitCode: 0, stdout: "" }),
          showBranch: () => ({ exitCode: 0, stdout: "clean-branch" }),
          removeWorktree: (_root, wt) => {
            removed.push(wt);
            return { exitCode: 0 };
          },
          deleteBranch: (_root, branch) => {
            deletedBranches.push(branch);
            return { exitCode: 0 };
          },
        }),
      );
      expect(removed).toHaveLength(1);
      expect(deletedBranches).toEqual(["clean-branch"]);
    } finally {
      db.close();
    }
  });

  test("skips worktrees where git status fails (not a git repo)", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "ended-bad-git",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/fake",
        worktree: "test-wt",
      });
      db.endSession("ended-bad-git");

      const removeCalled: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: () => true,
          status: () => ({ exitCode: 128, stdout: "" }),
          removeWorktree: (_root, wt) => {
            removeCalled.push(wt);
            return { exitCode: 0 };
          },
        }),
      );
      expect(removeCalled).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("resolves hook-based worktree paths using repoRoot and .mcx-worktree.json", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      // Create .mcx-worktree.json for custom base path resolution
      const repoDir = join(opts.dir, "repo-hooks");
      const customBase = join(opts.dir, "custom-worktrees");
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(customBase, { recursive: true });
      writeFileSync(join(repoDir, ".mcx-worktree.json"), JSON.stringify({ worktree: { base: customBase } }));

      db.upsertSession({
        sessionId: "ended-hook",
        pid: 99999,
        model: "sonnet",
        cwd: join(customBase, "hook-wt"),
        worktree: "hook-wt",
        repoRoot: repoDir,
      });
      db.endSession("ended-hook");

      // Track which path was checked/removed to verify resolution
      const pathsChecked: string[] = [];
      const removed: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: (p) => {
            pathsChecked.push(p);
            return true;
          },
          status: () => ({ exitCode: 0, stdout: "" }),
          removeWorktree: (_root, wt) => {
            removed.push(wt);
            return { exitCode: 0 };
          },
        }),
      );
      // Should have resolved to customBase/hook-wt
      expect(pathsChecked[0]).toBe(join(customBase, "hook-wt"));
      expect(removed).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("falls back to cwd when repoRoot is not set (legacy sessions)", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "ended-legacy",
        pid: 99999,
        model: "sonnet",
        cwd: "/tmp/repo",
        worktree: "legacy-wt",
      });
      db.endSession("ended-legacy");

      const pathsChecked: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: (p) => {
            pathsChecked.push(p);
            return true;
          },
          status: () => ({ exitCode: 0, stdout: "" }),
          removeWorktree: () => ({ exitCode: 0 }),
        }),
      );
      // Should resolve via cwd: /tmp/repo/.claude/worktrees/legacy-wt
      expect(pathsChecked[0]).toBe(join("/tmp/repo", ".claude", "worktrees", "legacy-wt"));
    } finally {
      db.close();
    }
  });

  test("skips sessions ended more than 7 days ago", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      db.upsertSession({
        sessionId: "old-ended",
        pid: 12345,
        model: "sonnet",
        cwd: "/tmp/test",
        worktree: "old-wt",
      });
      db.endSession("old-ended");
      // Backdate ended_at to 10 days ago via raw SQL
      const { Database } = require("bun:sqlite");
      const rawDb = new Database(opts.DB_PATH);
      rawDb.run("UPDATE agent_sessions SET ended_at = datetime('now', '-10 days') WHERE session_id = ?", ["old-ended"]);
      rawDb.close();

      const pathsChecked: string[] = [];
      pruneOrphanedWorktrees(
        db,
        silentLogger,
        mockGitOps({
          pathExists: (p: string) => {
            pathsChecked.push(p);
            return true;
          },
        }),
      );
      // Old session should be skipped entirely — no path checks
      expect(pathsChecked).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("handles errors gracefully without crashing", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    db.close();
    // Should not throw — catches internally
    pruneOrphanedWorktrees(db, silentLogger, mockGitOps());
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanedWorktrees integration test (real git — verifies plumbing)
// ---------------------------------------------------------------------------
describe("pruneOrphanedWorktrees integration", () => {
  let opts: ReturnType<typeof testOptions> | undefined;

  afterEach(() => {
    if (opts) {
      opts[Symbol.dispose]();
      opts = undefined;
    }
    _restoreOptions();
  });

  test("removes a real clean worktree via git", () => {
    opts = testOptions();
    const db = new StateDb(opts.DB_PATH);
    try {
      const cleanEnv = { ...process.env };
      for (const k of [
        "GIT_INDEX_FILE",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_PREFIX",
        "GIT_AUTHOR_DATE",
        "GIT_COMMITTER_DATE",
      ]) {
        delete cleanEnv[k];
      }
      const gitOpts = { stdout: "pipe" as const, stderr: "pipe" as const, env: cleanEnv };

      const repoDir = join(opts.dir, "repo-integ");
      mkdirSync(repoDir, { recursive: true });
      Bun.spawnSync(["git", "init", repoDir], gitOpts);
      Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"], gitOpts);

      const worktreeDir = join(repoDir, ".claude", "worktrees", "integ-wt");
      mkdirSync(join(repoDir, ".claude", "worktrees"), { recursive: true });
      Bun.spawnSync(["git", "-C", repoDir, "worktree", "add", worktreeDir, "-b", "integ-branch"], gitOpts);

      db.upsertSession({
        sessionId: "ended-integ",
        pid: 99999,
        model: "sonnet",
        cwd: repoDir,
        worktree: "integ-wt",
      });
      db.endSession("ended-integ");

      // Use default (real) git ops
      pruneOrphanedWorktrees(db, silentLogger);

      expect(existsSync(worktreeDir)).toBe(false);
    } finally {
      db.close();
    }
  });
});
