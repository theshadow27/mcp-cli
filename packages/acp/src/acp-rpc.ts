/**
 * JSON-RPC 2.0 client for ACP agents.
 *
 * Handles request/response correlation, notification routing,
 * and server-initiated request handling (permission + capability requests).
 *
 * Mirrors codex-rpc.ts but for the ACP protocol.
 */

import type { AcpProcess } from "./acp-process";
import { classifyMessage } from "./schemas";

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AcpRpcClientOptions {
  /** Default timeout for requests in ms. */
  timeoutMs?: number;
  /** Called for server-initiated notifications (no id, has method). */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  /** Called for server-initiated requests (has id + method, e.g. permission/capability requests). */
  onServerRequest?: (id: number | string, method: string, params: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class AcpRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly proc: AcpProcess;
  private readonly timeoutMs: number;
  private readonly onNotification: AcpRpcClientOptions["onNotification"];
  private readonly onServerRequest: AcpRpcClientOptions["onServerRequest"];

  constructor(proc: AcpProcess, opts: AcpRpcClientOptions = {}) {
    this.proc = proc;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onNotification = opts.onNotification;
    this.onServerRequest = opts.onServerRequest;
  }

  /** Route an incoming message from the process. Call this from AcpProcess.onMessage. */
  handleMessage(msg: Record<string, unknown>): void {
    const kind = classifyMessage(msg);

    switch (kind) {
      case "response": {
        const id = msg.id as number | string;
        const pending = this.pending.get(id);
        if (!pending) {
          console.warn(`[acp-rpc] Orphaned response for id ${id} — request may have timed out`);
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if ("error" in msg && msg.error) {
          const err = msg.error as { code: number; message: string; data?: unknown };
          pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
        } else {
          pending.resolve(msg.result);
        }
        break;
      }
      case "notification":
        this.onNotification?.(msg.method as string, (msg.params ?? {}) as Record<string, unknown>);
        break;
      case "server_request":
        this.onServerRequest?.(
          msg.id as number | string,
          msg.method as string,
          (msg.params ?? {}) as Record<string, unknown>,
        );
        break;
      default:
        // Unknown message shape — ignore
        break;
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.write(msg).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no id). */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    await this.proc.write(msg);
  }

  /** Respond to a server-initiated request (e.g. permission, fs, terminal). */
  async respondToServerRequest(id: number | string, result: unknown): Promise<void> {
    await this.proc.write({ jsonrpc: "2.0", id, result });
  }

  /** Send an error response to a server-initiated request. */
  async respondWithError(id: number | string, code: number, message: string): Promise<void> {
    await this.proc.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Reject all pending requests (e.g. on process death). */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** Number of in-flight requests. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
