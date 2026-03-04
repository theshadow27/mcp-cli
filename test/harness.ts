/**
 * Test harness for daemon integration tests.
 *
 * Spawns real daemon processes in isolated temp directories
 * via the MCP_CLI_DIR env var override.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IpcResponse, ServerConfig, ServerConfigMap } from "@mcp-cli/core";
import { DAEMON_READY_SIGNAL } from "@mcp-cli/core";

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
  options?: { timeout?: number; idleTimeout?: number },
): Promise<TestDaemon> {
  const dir = createTestDir();
  const socketPath = join(dir, "mcpd.sock");

  // Write servers.json so daemon has config to load
  writeFileSync(join(dir, "servers.json"), JSON.stringify({ mcpServers: servers }));

  const proc = Bun.spawn(["bun", resolve("packages/daemon/src/index.ts")], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MCP_CLI_DIR: dir,
      MCP_DAEMON_TIMEOUT: String(options?.idleTimeout ?? 30_000),
    },
  });

  // Wait for MCPD_READY signal on stdout
  const deadline = Date.now() + (options?.timeout ?? 10_000);
  const reader = proc.stdout.getReader();
  let stdout = "";

  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      Bun.sleep(100).then(() => ({ done: false, value: undefined }) as const),
    ]);
    if (value) stdout += new TextDecoder().decode(value);
    if (stdout.includes(DAEMON_READY_SIGNAL)) break;
    if (done) break;
  }

  if (!stdout.includes(DAEMON_READY_SIGNAL)) {
    proc.kill();
    // Drain stderr for diagnostics
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Daemon failed to start. stdout: ${stdout}\nstderr: ${stderr}`);
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
