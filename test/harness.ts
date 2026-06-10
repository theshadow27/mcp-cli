/**
 * Test harness for daemon integration tests.
 *
 * Spawns real daemon processes in isolated temp directories
 * via the MCP_CLI_DIR env var override.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IpcResponse, ManagedHandle, ServerConfig, ServerConfigMap } from "@mcp-cli/core";
import { spawnManaged } from "@mcp-cli/core";

export interface MockServer {
  handle: ManagedHandle;
  port: number;
  kill: () => Promise<void>;
}

export interface TestDaemon {
  handle: ManagedHandle;
  exitCode: Promise<number | null>;
  dir: string;
  socketPath: string;
  kill: () => Promise<void>;
  stderrTail: () => string;
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
  options?: { timeout?: number; idleTimeout?: number; dir?: string; skipVirtualServers?: boolean; pathPrefix?: string },
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

  // Force a random WebSocket port. Without this, every test daemon tries to bind
  // DEFAULT_CLAUDE_WS_PORT (19275) and — when the user's dev daemon or another
  // test daemon already holds it — burns multi-second port retries in ws-server
  // before falling back. Multiplied across ~22 daemon spawns in
  // daemon-integration.spec.ts that's tens of seconds of test wall time.
  // Production keeps the well-known port; only test daemons opt in to wsPort: 0.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ wsPort: 0 }));

  const result = spawnManaged("bun", [resolve("packages/daemon/src/main.ts")], {
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      MCP_CLI_DIR: dir,
      MCP_DAEMON_TIMEOUT: String(options?.idleTimeout ?? 30_000),
      ...(options?.skipVirtualServers ? { MCP_DAEMON_SKIP_VIRTUAL_SERVERS: "1" } : {}),
      ...(options?.pathPrefix ? { PATH: `${options.pathPrefix}:${process.env.PATH ?? ""}` } : {}),
    },
  });

  if (!result.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("Failed to spawn daemon process");
  }

  const { handle } = result;

  // Wait for daemon to be ready by polling the socket file + ping.
  // This is more reliable than reading stdout (which has pipe buffering
  // issues on Linux CI runners).
  const deadline = Date.now() + (options?.timeout ?? 15_000);
  let ready = false;

  while (Date.now() < deadline) {
    // Check if process died
    const exited = await Promise.race([handle.exited.then(() => true), Bun.sleep(50).then(() => false)]);
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
    await handle.kill();
    const stderr = handle.stderrTail();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Daemon failed to start within ${options?.timeout ?? 15_000}ms.\nstderr: ${stderr}`);
  }

  const exitCode = handle.exited.then((s) => s.exitCode);

  return {
    handle,
    exitCode,
    dir,
    socketPath,
    kill: async () => {
      await handle.kill();
      rmSync(dir, { recursive: true, force: true });
    },
    stderrTail: () => handle.stderrTail(),
  };
}

/**
 * Poll condition until it returns truthy or deadline passes.
 * Never use a fixed sleep to wait for async side effects — poll instead.
 * Throws with a descriptive message on timeout so test failures are visible.
 *
 * The default deadline (1500ms) sits well under Bun's 5000ms per-test
 * watchdog so this helper's descriptive error always wins the race over the
 * generic "test timed out". Measured: across the full suite no condition takes
 * longer than ~400ms to resolve (#2273), so 1500ms is an ample backstop. For a
 * genuinely-slow condition, pass an explicit deadline AND raise the file's
 * `setDefaultTimeout` above it — a deadline >= the test timeout is a no-op.
 */
export async function pollUntil(
  condition: () => Promise<boolean | undefined | null | number> | boolean | undefined | null | number,
  timeoutMs = 1500,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let met = false;
  while (Date.now() < deadline) {
    if (await condition()) {
      met = true;
      break;
    }
    await Bun.sleep(intervalMs);
  }
  if (!met) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

/**
 * Spawn a mock MCP server process (HTTP or SSE) and read its port from stdout.
 * The server script must print the listening port as the first line of stdout.
 */
export async function startMockServer(scriptPath: string): Promise<MockServer> {
  const result = spawnManaged("bun", [resolve(scriptPath)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!result.ok) {
    throw new Error(`Failed to spawn mock server: ${scriptPath}`);
  }

  const { handle } = result;

  // Read the port from the first line of stdout (bounded to 10s to prevent hangs under contention)
  if (!handle.stdout) {
    await handle.kill();
    throw new Error("Mock server stdout stream unavailable");
  }
  const reader = handle.stdout.getReader();
  const readResult = await Promise.race([
    reader.read(),
    Bun.sleep(10_000).then(() => ({ value: undefined, done: true as const, timeout: true as const })),
  ]);

  // Decode BEFORE releasing the reader lock. Bun may reuse the underlying
  // ArrayBuffer once the lock is released, making the Uint8Array stale.
  const portLine = readResult.value
    ? new TextDecoder()
        .decode(readResult.value)
        .replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g"), "")
        .trim()
    : undefined;
  reader.releaseLock();

  if (!portLine) {
    await handle.kill();
    const stderr = handle.stderrTail();
    const reason = "timeout" in readResult ? "timed out waiting for port" : "no output";
    throw new Error(`Mock server failed to start (${reason}): ${stderr}`);
  }

  const port = Number(portLine);
  if (!port || Number.isNaN(port)) {
    await handle.kill();
    throw new Error(`Mock server printed invalid port: ${JSON.stringify(portLine)}`);
  }

  return {
    handle,
    port,
    kill: async () => {
      await handle.kill();
    },
  };
}

/** HTTP (Streamable HTTP) config pointing to a mock server */
export function echoHttpServerConfig(port: number): ServerConfig {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
}

/** SSE config pointing to a mock server */
export function echoSseServerConfig(port: number): ServerConfig {
  return {
    type: "sse",
    url: `http://127.0.0.1:${port}/sse`,
  };
}

/**
 * Merge a single server into the daemon's servers.json without clobbering sibling entries.
 * Polls listServers() until the new entry appears (or timeout throws).
 */
export async function addServer(d: TestDaemon, name: string, config: ServerConfig): Promise<void> {
  const configPath = join(d.dir, "servers.json");
  const current = JSON.parse(readFileSync(configPath, "utf-8")) as { mcpServers: ServerConfigMap };
  current.mcpServers[name] = config;
  writeFileSync(configPath, JSON.stringify(current));
  await pollUntil(async () => {
    const res = await rpc(d.socketPath, "listServers");
    return (res.result as Array<{ name: string }>).some((s) => s.name === name);
  }, 10_000);
}

/**
 * Remove a single server from the daemon's servers.json.
 * Polls listServers() until the entry disappears (or timeout throws).
 */
export async function removeServer(d: TestDaemon, name: string): Promise<void> {
  const configPath = join(d.dir, "servers.json");
  const current = JSON.parse(readFileSync(configPath, "utf-8")) as { mcpServers: ServerConfigMap };
  delete current.mcpServers[name];
  writeFileSync(configPath, JSON.stringify(current));
  await pollUntil(async () => {
    const res = await rpc(d.socketPath, "listServers");
    return !(res.result as Array<{ name: string }>).some((s) => s.name === name);
  }, 10_000);
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
