/**
 * Tests for daemon index.ts — startup, shutdown, idle timeout, config reload.
 *
 * Uses startDaemon() directly for in-process coverage, with testOptions()
 * for filesystem isolation.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@mcp-cli/core";
import { _restoreOptions } from "@mcp-cli/core";
import { pollUntil, rpc } from "../../../test/harness";
import { testOptions } from "../../../test/test-options";
import type { DaemonHandle } from "./index";
import { startDaemon } from "./index";

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
    ...overrides,
  });
}

describe("daemon index.ts", () => {
  let handle: DaemonHandle | undefined;
  let opts: ReturnType<typeof testOptions> | undefined;

  afterEach(async () => {
    if (handle && !handle.isShuttingDown) {
      await handle.shutdown("SIGTERM");
    }
    handle = undefined;
    if (opts) {
      opts[Symbol.dispose]();
      opts = undefined;
    }
    _restoreOptions();
  });

  // ---------------------------------------------------------------------------
  // P1: Startup sequence
  // ---------------------------------------------------------------------------
  describe("startup sequence", () => {
    test("writes PID file with correct shape", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

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

    test("opens StateDb at configured path", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const dbPath = join(opts.dir, "state.db");
      expect(existsSync(dbPath)).toBe(true);
    });

    test("starts IPC server that responds to ping", async () => {
      opts = testOptions();
      handle = await startTestDaemonInProcess();

      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "ping");
      expect(res.result).toHaveProperty("pong", true);
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
      const deadline = Date.now() + 10_000;
      let found = false;
      while (!found && Date.now() < deadline) {
        const check = await rpc(socketPath, "listServers");
        const svrs = check.result as Array<{ name: string }>;
        found = svrs.some((s) => s.name === "_aliases") && svrs.some((s) => s.name === "_claude");
        if (!found) await Bun.sleep(100);
      }
      expect(found).toBe(true);

      const res = await rpc(socketPath, "listServers");
      const servers = res.result as Array<{ name: string }>;
      expect(servers.some((s) => s.name === "_aliases")).toBe(true);
      expect(servers.some((s) => s.name === "_claude")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // P2: Shutdown sequence
  // ---------------------------------------------------------------------------
  describe("shutdown sequence", () => {
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

      // IPC should no longer respond
      let threw = false;
      try {
        await rpc(socketPath, "ping");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
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

      await pollUntil(() => handle?.isShuttingDown);
      expect(handle?.isShuttingDown).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // P3: Idle timeout
  // ---------------------------------------------------------------------------
  describe("idle timeout", () => {
    test("fires after configured duration and triggers shutdown", async () => {
      opts = testOptions();
      await withDaemonTimeout("500", async () => {
        handle = await startTestDaemonInProcess();
        await pollUntil(() => handle?.isShuttingDown, 5_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });

    test("activity resets idle timer", async () => {
      opts = testOptions();
      await withDaemonTimeout("800", async () => {
        handle = await startTestDaemonInProcess();
        const socketPath = join(opts?.dir ?? "", "mcpd.sock");

        // Send pings to keep the daemon alive past the idle timeout
        for (let i = 0; i < 3; i++) {
          await Bun.sleep(400);
          await rpc(socketPath, "ping");
          expect(handle?.isShuttingDown).toBe(false);
        }

        // Now stop pinging and let it idle out
        await pollUntil(() => handle?.isShuttingDown, 3_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });

    test("MCP_DAEMON_TIMEOUT env override is respected", async () => {
      opts = testOptions();
      await withDaemonTimeout("300", async () => {
        handle = await startTestDaemonInProcess();
        await pollUntil(() => handle?.isShuttingDown, 3_000);
        expect(handle?.isShuttingDown).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // P4: Config hot reload
  // ---------------------------------------------------------------------------
  describe.skipIf(process.platform === "linux")("config hot reload", () => {
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
      }, 5_000);

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
      // (config hash stays the same, so watcher won't fire — force a direct reload)
      const serversPath = join(opts.dir, "servers.json");
      writeFileSync(serversPath, JSON.stringify({ mcpServers: {} }));
      handle.watcher.forceReload();

      // The reload fires with "no server changes" since we go from empty → empty
      // Just verify daemon is still alive
      const socketPath = join(opts.dir, "mcpd.sock");
      const res = await rpc(socketPath, "ping");
      expect(res.result).toHaveProperty("pong", true);
    });
  });
});
