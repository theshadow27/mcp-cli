/**
 * Test harness for daemon integration tests.
 *
 * Spawns real daemon processes in isolated temp directories
 * via the MCP_CLI_DIR env var override.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IpcResponse, ServerConfig, ServerConfigMap } from "@mcp-cli/core";

export interface TestDaemon {
  proc: ReturnType<typeof Bun.spawn>;
  dir: string;
  socketPath: string;
  kill: () => Promise<void>;
}

/** Create an isolated temp directory for a test daemon */
export function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Stdio config pointing to the echo test server */
export function echoServerConfig(): ServerConfig {
  return {
    command: "bun",
    args: [resolve("test/echo-server.ts")],
  };
}

/**
 * Spawn a real daemon process in an isolated temp directory.
 * Waits for MCPD_READY before returning.
 */
export async function startTestDaemon(
  servers: ServerConfigMap,
  options?: { timeout?: number; idleTimeout?: number; dir?: string; skipVirtualServers?: boolean },
): Promise<TestDaemon> {
  const dir = options?.dir ?? createTestDir();
  const socketPath = join(dir, "mcpd.sock");

  // Clean up stale socket from a previous daemon (e.g. after SIGKILL)
  try {
    unlinkSync(socketPath);
  } catch {
    // doesn't exist, fine
  }

  // Write servers.json so daemon has config to load
  writeFileSync(join(dir, "servers.json"), JSON.stringify({ mcpServers: servers }));

  const proc = Bun.spawn(["bun", resolve("packages/daemon/src/main.ts")], {
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      MCP_CLI_DIR: dir,
      MCP_DAEMON_TIMEOUT: String(options?.idleTimeout ?? 30_000),
      ...(options?.skipVirtualServers ? { MCP_DAEMON_SKIP_VIRTUAL_SERVERS: "1" } : {}),
    },
  });

  // Wait for daemon to be ready by polling the socket file + ping.
  // This is more reliable than reading stdout (which has pipe buffering
  // issues on Linux CI runners).
  const deadline = Date.now() + (options?.timeout ?? 15_000);
  let ready = false;

  while (Date.now() < deadline) {
    // Check if process died
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(50).then(() => false)]);
    if (exited) break;

    if (!existsSync(socketPath)) continue;

    // Socket exists — try to ping
    try {
      const res = await rpc(socketPath, "ping");
      if (res.result && (res.result as { pong?: boolean }).pong) {
        ready = true;
        break;
      }
    } catch {
      // Socket not ready yet — keep polling
      await Bun.sleep(50);
    }
  }

  if (!ready) {
    proc.kill();
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Daemon failed to start within ${options?.timeout ?? 15_000}ms.\nstderr: ${stderr}`);
  }

  return {
    proc,
    dir,
    socketPath,
    kill: async () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Poll condition until it returns truthy or deadline passes.
 * Never use a fixed sleep to wait for async side effects — poll instead.
 * Throws with a descriptive message on timeout so test failures are visible.
 */
export async function pollUntil(
  condition: () => Promise<boolean | undefined | null | number> | boolean | undefined | null | number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (!(await condition())) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

/** Send an IPC RPC request directly to a daemon's Unix socket */
export async function rpc(socketPath: string, method: string, params?: unknown): Promise<IpcResponse> {
  const res = await fetch("http://localhost/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, params }),
    unix: socketPath,
  } as RequestInit);
  return (await res.json()) as IpcResponse;
}
