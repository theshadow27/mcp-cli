/**
 * @rule no-db-ipc-cast
 * @expect 0
 * @path packages/daemon/src/db/example.ts
 *
 * Known-good shapes: runtime guards, `as unknown` re-narrowing flows,
 * whole-row contract casts, and `as const`.
 */

import { Database } from "bun:sqlite";

type Transport = "ws" | "stdio";

interface SessionRow {
  transport: string | null;
}

function isTransport(v: unknown): v is Transport {
  return v === "ws" || v === "stdio";
}

const DEFAULT_TRANSPORT = "ws" as const;

export function restoreSession(db: Database): Transport {
  // whole-row cast is the row contract, not field-level narrowing — allowed
  const row = db.query("SELECT transport FROM sessions").get() as SessionRow;
  // runtime guard instead of a cast — the required pattern
  return isTransport(row.transport) ? row.transport : DEFAULT_TRANSPORT;
}

export function parsePayload(raw: string): Transport {
  const data = JSON.parse(raw) as Record<string, unknown>;
  // `as unknown` starts an explicit re-narrowing flow — allowed
  const candidate = data.transport as unknown;
  return isTransport(candidate) ? candidate : DEFAULT_TRANSPORT;
}
