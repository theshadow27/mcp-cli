/**
 * IPC client — connects to mcpd daemon via HTTP-over-Unix-socket.
 *
 * Pure IPC transport layer shared by CLI (command) and TUI (control).
 * Does NOT auto-start the daemon — callers must ensure it is running.
 */

import { IPC_REQUEST_TIMEOUT_MS, PING_TIMEOUT_MS, options } from "./constants";
import type { IpcError, IpcMethod, IpcRequest, IpcResponse } from "./ipc";
import { nextId } from "./ipc";

/**
 * Structured error thrown by ipcCall() when the daemon returns an error response.
 * Preserves the error code, data, and remote stack trace from the daemon.
 */
export class IpcCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly remoteStack: string | undefined;

  constructor(err: IpcError) {
    super(err.message);
    this.name = "IpcCallError";
    this.code = err.code;
    this.data = err.data;
    this.remoteStack = err.stack;
  }
}

/**
 * Thrown when the CLI and daemon have incompatible protocol versions.
 * The user must explicitly restart the daemon to resolve this.
 */
export class ProtocolMismatchError extends Error {
  readonly daemonVersion: string;
  readonly cliVersion: string;

  constructor(daemonVersion: string, cliVersion: string) {
    super(
      `Protocol version mismatch — daemon is running ${daemonVersion}, CLI expects ${cliVersion}.\n\nThe daemon was started from a different build. Active sessions will be\nlost if the daemon is restarted.\n\n  To restart anyway:  mcx daemon restart\n  If developing:      bun build && mcx daemon restart`,
    );
    this.name = "ProtocolMismatchError";
    this.daemonVersion = daemonVersion;
    this.cliVersion = cliVersion;
  }
}

/**
 * Thrown when ensureDaemon is called during the cooldown period after a failed start.
 * Prevents unbounded daemon spawn loops (e.g. mcpctl polling every 2.5s).
 */
export class DaemonStartCooldownError extends Error {
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(`Daemon start on cooldown — last attempt failed. Retrying in ${Math.ceil(remainingMs / 1000)}s.`);
    this.name = "DaemonStartCooldownError";
    this.remainingMs = remainingMs;
  }
}

/** Base URL for IPC requests over the Unix domain socket. */
const IPC_RPC_URL = "http://localhost/rpc";

/**
 * Low-level fetch to the daemon Unix socket.
 * Deduplicates the shared headers/URL/socket config used by sendRequest, pingDaemon, and stopDaemon.
 */
export function rawFetch(body: { id: string; method: string; params?: unknown }, timeoutMs: number): Promise<Response> {
  return fetch(IPC_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    unix: options.SOCKET_PATH,
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
}

/**
 * Send a single request to the daemon and return the response.
 * Does NOT auto-start the daemon — callers must ensure it is running.
 */
export async function ipcCall(method: IpcMethod, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
  const request: IpcRequest = { id: nextId(), method, params };
  const response = await sendRequest(request, opts?.timeoutMs);

  if (response.error) {
    throw new IpcCallError(response.error);
  }
  return response.result;
}

/** Send a request via HTTP-over-Unix-socket and return the response */
async function sendRequest(request: IpcRequest, timeoutMs?: number): Promise<IpcResponse> {
  const res = await rawFetch(request, timeoutMs ?? IPC_REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`IPC HTTP error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as IpcResponse;
}

/** Send a quick HTTP ping to verify the daemon is responsive */
export function pingDaemon(): Promise<boolean> {
  return rawFetch({ id: nextId(), method: "ping" }, PING_TIMEOUT_MS)
    .then((res) => res.ok)
    .catch(() => false);
}
