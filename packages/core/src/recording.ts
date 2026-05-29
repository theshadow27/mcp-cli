import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeJsonPayload } from "./sanitizer";

/**
 * Message direction on the daemon↔worker boundary.
 */
export type RecordingDirection = "daemon->worker" | "worker->daemon";

/**
 * Message kind — aligned with docs/agent-protocol.md §2-5:
 *   control = §2 (daemon→worker) + §3 (worker→daemon init handshake)
 *   db      = §4 (worker→daemon DB/metrics/monitor events)
 *   mcp     = §5 (bidirectional JSON-RPC 2.0)
 */
export type RecordingKind = "control" | "db" | "mcp";

export interface RecordingEntry {
  t: number;
  dir: RecordingDirection;
  kind: RecordingKind;
  payload: unknown;
}

/**
 * Classify a postMessage payload into its protocol kind.
 * Uses the same discrimination rules as the spec §1:
 *   - `jsonrpc` field present → mcp
 *   - `type` field starting with "db:" or "metrics:" or exact "monitor:event" → db
 *   - `type` field present (all other) → control
 */
export function classifyMessageKind(payload: unknown): RecordingKind {
  if (typeof payload !== "object" || payload === null) return "mcp";
  const obj = payload as Record<string, unknown>;
  if ("jsonrpc" in obj) return "mcp";
  if ("type" in obj && typeof obj.type === "string") {
    const t = obj.type;
    if (t.startsWith("db:") || t.startsWith("metrics:") || t === "monitor:event") return "db";
    return "control";
  }
  return "mcp";
}

/**
 * Append-only NDJSON recorder for the daemon↔worker protocol exchange.
 *
 * Zero overhead when not instantiated. Writes are fire-and-forget
 * (buffered by the OS / Bun's writer). The caller is responsible for
 * calling close() when the session ends.
 *
 * record() and recordMessage() never throw — a serialization or I/O
 * failure is silently swallowed so recording can never disrupt the
 * protocol path.
 */
export class NdjsonRecorder {
  private writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  private closed = false;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.writer = Bun.file(path).writer();
  }

  record(dir: RecordingDirection, kind: RecordingKind, payload: unknown): void {
    if (this.closed || !this.writer) return;
    try {
      const entry: RecordingEntry = {
        t: performance.timeOrigin + performance.now(),
        dir,
        kind,
        payload,
      };
      const { sanitized } = sanitizeJsonPayload(entry);
      this.writer.write(`${JSON.stringify(sanitized)}\n`);
    } catch {
      // Recording must never disrupt the protocol path.
    }
  }

  recordMessage(dir: RecordingDirection, payload: unknown): void {
    this.record(dir, classifyMessageKind(payload), payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer?.end();
    } catch {
      // Best-effort flush.
    }
    this.writer = null;
  }
}
