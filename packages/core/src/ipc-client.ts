/**
 * IPC client — connects to mcpd daemon via HTTP-over-Unix-socket.
 *
 * Pure IPC transport layer shared by CLI (command) and TUI (control).
 * Does NOT auto-start the daemon — callers must ensure it is running.
 */

import { IPC_REQUEST_TIMEOUT_MS, PING_TIMEOUT_MS, options } from "./constants";
import type { IpcError, IpcMethod, IpcMethodResult, IpcRequest, IpcResponse } from "./ipc";
import { nextId } from "./ipc";
import type { LiveSpan } from "./trace";
import { startSpan } from "./trace";

/**
 * Module-level startup span for the mcx CLI process.
 * Constant for the process lifetime — per-call spans are children of this.
 */
let _processSpan: LiveSpan | null = null;

function getProcessSpan(): LiveSpan {
  if (!_processSpan) {
    _processSpan = startSpan("mcx");
  }
  return _processSpan;
}

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
    super(`Protocol mismatch: daemon ${daemonVersion}, CLI expects ${cliVersion}.\nRun: mcx daemon restart`);
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
export async function ipcCall<M extends IpcMethod>(
  method: M,
  params?: unknown,
  opts?: { timeoutMs?: number },
): Promise<IpcMethodResult[M]> {
  const callSpan = getProcessSpan().child(`ipc.${method}`);
  const request: IpcRequest = {
    id: nextId(),
    method,
    params,
    traceparent: callSpan.traceparent(),
  };
  try {
    const response = await sendRequest(request, opts?.timeoutMs);

    if (response.error) {
      callSpan.setStatus("ERROR");
      throw new IpcCallError(response.error);
    }
    callSpan.setStatus("OK");
    return response.result as IpcMethodResult[M];
  } catch (err) {
    callSpan.setStatus("ERROR");
    throw err;
  } finally {
    callSpan.end();
  }
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

/**
 * Open an SSE stream to the daemon's GET /logs endpoint.
 * Returns an async iterable of parsed log entries plus an abort function.
 */
export function openLogStream(params: {
  server?: string;
  daemon?: boolean;
  lines?: number;
  since?: number;
}): { entries: AsyncIterable<{ timestamp: number; line: string }>; abort: () => void } {
  const qs = new URLSearchParams();
  if (params.server) qs.set("server", params.server);
  if (params.daemon) qs.set("daemon", "true");
  if (params.lines !== undefined) qs.set("lines", String(params.lines));
  if (params.since !== undefined) qs.set("since", String(params.since));

  const controller = new AbortController();
  const url = `http://localhost/logs?${qs.toString()}`;

  async function* iterate(): AsyncGenerator<{ timestamp: number; line: string }> {
    const res = await fetch(url, {
      method: "GET",
      unix: options.SOCKET_PATH,
      signal: controller.signal,
    } as RequestInit);

    if (!res.ok) {
      throw new Error(`SSE stream error: ${res.status} ${await res.text()}`);
    }

    const body = res.body;
    if (!body) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.replace(/^data: /, "");
        if (!line) continue;
        try {
          yield JSON.parse(line) as { timestamp: number; line: string };
        } catch {
          // Skip malformed SSE events
        }
      }
    }
  }

  return { entries: iterate(), abort: () => controller.abort() };
}

/**
 * Open an NDJSON stream to the daemon's GET /events endpoint.
 * Returns an async iterable of parsed event objects plus an abort function.
 */
export function openEventStream(params?: {
  since?: number;
}): { events: AsyncIterable<Record<string, unknown>>; abort: () => void } {
  const qs = new URLSearchParams();
  if (params?.since !== undefined) qs.set("since", String(params.since));

  const controller = new AbortController();
  const qsStr = qs.toString();
  const url = `http://localhost/events${qsStr ? `?${qsStr}` : ""}`;

  async function* iterate(): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(url, {
      method: "GET",
      unix: options.SOCKET_PATH,
      signal: controller.signal,
    } as RequestInit);

    if (!res.ok) {
      throw new Error(`Event stream error: ${res.status} ${await res.text()}`);
    }

    const body = res.body;
    if (!body) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        try {
          yield JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Skip malformed NDJSON lines
        }
      }
    }
  }

  return { events: iterate(), abort: () => controller.abort() };
}
