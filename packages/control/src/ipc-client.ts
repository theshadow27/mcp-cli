/**
 * IPC client — connects to mcpd daemon via Unix socket.
 *
 * Self-contained copy for the control package (keeps it independently buildable).
 * Auto-starts the daemon if not running.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { IpcMethod, IpcRequest, IpcResponse } from "@mcp-cli/core";
import {
  DAEMON_READY_SIGNAL,
  DAEMON_START_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
  PID_MAX_AGE_MS,
  PID_PATH,
  PING_TIMEOUT_MS,
  SOCKET_PATH,
  encodeRequest,
  nextId,
} from "@mcp-cli/core";

/**
 * Send a single request to the daemon and return the response.
 * Auto-starts the daemon if it's not running.
 */
export async function ipcCall(method: IpcMethod, params?: unknown): Promise<unknown> {
  await ensureDaemon();

  const request: IpcRequest = { id: nextId(), method, params };
  const response = await sendRequest(request);

  if (response.error) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  return response.result;
}

/** Send a request over Unix socket and wait for the matching response */
async function sendRequest(request: IpcRequest): Promise<IpcResponse> {
  return new Promise<IpcResponse>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Request timed out after ${IPC_REQUEST_TIMEOUT_MS}ms`));
      }
    }, IPC_REQUEST_TIMEOUT_MS);

    Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data(_socket, data) {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim() === "") continue;
            try {
              const response = JSON.parse(line) as IpcResponse;
              if (response.id === request.id && !settled) {
                settled = true;
                clearTimeout(timeout);
                _socket.end();
                resolve(response);
              }
            } catch {
              // ignore malformed lines
            }
          }
        },
        error(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Socket error: ${err.message}`));
          }
        },
        close() {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("Connection closed before response received"));
          }
        },
        open(_socket) {
          _socket.write(encodeRequest(request));
        },
        connectError(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Failed to connect to daemon: ${err.message}`));
          }
        },
      },
    });
  });
}

/** Check if daemon is running, start it if not */
async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;
  await startDaemon();
}

/** Remove stale PID and socket files so a fresh daemon can start */
function cleanStaleFiles(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    /* already gone */
  }
}

/** Verify the process at `pid` is actually mcpd (guards against PID recycling) */
function isProcessMcpd(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    const output = result.stdout.toString().trim();
    return output.includes("mcpd") || output.includes("daemon/src/index");
  } catch {
    return false;
  }
}

/** Send a quick IPC ping to verify the daemon is responsive */
function pingDaemon(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    const request: IpcRequest = { id: nextId(), method: "ping" };

    try {
      Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          data(_socket, data) {
            const lines = data.toString().split("\n");
            for (const line of lines) {
              if (line.trim() === "") continue;
              try {
                const response = JSON.parse(line) as IpcResponse;
                if (response.id === request.id) {
                  clearTimeout(timeout);
                  _socket.end();
                  resolve(!response.error);
                  return;
                }
              } catch {
                /* ignore malformed */
              }
            }
          },
          error() {
            clearTimeout(timeout);
            resolve(false);
          },
          close() {
            /* handled by timeout or response */
          },
          open(_socket) {
            _socket.write(encodeRequest(request));
          },
          connectError() {
            clearTimeout(timeout);
            resolve(false);
          },
        },
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

/**
 * Layered daemon liveness check:
 * 1. PID file exists and is parseable
 * 2. startedAt is not unreasonably old
 * 3. Process exists at that PID
 * 4. Process is actually mcpd (not a recycled PID)
 * 5. Socket file exists
 * 6. Daemon responds to IPC ping
 */
async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(PID_PATH)) return false;

  let data: { pid: number; startedAt: number };
  try {
    data = JSON.parse(readFileSync(PID_PATH, "utf-8"));
  } catch {
    cleanStaleFiles();
    return false;
  }

  // Reject unreasonably old PID files
  if (typeof data.startedAt !== "number" || Date.now() - data.startedAt > PID_MAX_AGE_MS) {
    cleanStaleFiles();
    return false;
  }

  // Check if process is alive
  try {
    process.kill(data.pid, 0);
  } catch {
    cleanStaleFiles();
    return false;
  }

  // Verify the process is actually mcpd (not a recycled PID)
  if (!isProcessMcpd(data.pid)) {
    cleanStaleFiles();
    return false;
  }

  // Socket must exist (but don't clean PID — daemon might be initializing)
  if (!existsSync(SOCKET_PATH)) return false;

  // Definitive check: daemon responds to ping
  const alive = await pingDaemon();
  if (!alive) {
    cleanStaleFiles();
    return false;
  }

  return true;
}

/** Spawn the daemon as a detached background process */
async function startDaemon(): Promise<void> {
  const daemonScript = join(import.meta.dir, "../../daemon/src/index.ts");

  const proc = Bun.spawn(["bun", "run", daemonScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const reader = proc.stdout.getReader();
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let accumulated = "";

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += new TextDecoder().decode(value);
    if (accumulated.includes(DAEMON_READY_SIGNAL)) {
      proc.unref();
      return;
    }
  }

  proc.kill();
  throw new Error(`Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms. Output: ${accumulated}`);
}
