/**
 * IPC client — connects to mcpd daemon via Unix socket.
 *
 * Auto-starts the daemon if not running.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMethod, IpcRequest, IpcResponse } from "@mcp-cli/core";
import {
  DAEMON_READY_SIGNAL,
  DAEMON_START_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
  PID_PATH,
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

    const socket = Bun.connect({
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
  if (isDaemonRunning()) return;
  await startDaemon();
}

/** Check PID file and process liveness */
function isDaemonRunning(): boolean {
  if (!existsSync(PID_PATH)) return false;

  try {
    const data = JSON.parse(readFileSync(PID_PATH, "utf-8"));
    // Check if process is alive
    process.kill(data.pid, 0);
    // Check if socket exists
    return existsSync(SOCKET_PATH);
  } catch {
    return false;
  }
}

/** Spawn the daemon as a detached background process */
async function startDaemon(): Promise<void> {
  const daemonScript = join(import.meta.dir, "../../daemon/src/index.ts");

  const proc = Bun.spawn(["bun", "run", daemonScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Wait for ready signal
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let accumulated = "";

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += new TextDecoder().decode(value);
    if (accumulated.includes(DAEMON_READY_SIGNAL)) {
      // Daemon is ready, detach
      proc.unref();
      return;
    }
  }

  // If we get here, daemon didn't signal ready in time
  proc.kill();
  throw new Error(`Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms. Output: ${accumulated}`);
}
