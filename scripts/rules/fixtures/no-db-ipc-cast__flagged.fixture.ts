/**
 * @rule no-db-ipc-cast
 * @expect 3
 * @path packages/daemon/src/db/example.ts
 *
 * Field-level casts on DB-row / IPC-payload reads — each one is a silent
 * type lie that bypasses runtime fallbacks (#2602 incident shape).
 */

import { Database } from "bun:sqlite";

type Transport = "ws" | "stdio";

export function restoreSession(db: Database): { transport: Transport; phase: Transport } {
  const row = db.query("SELECT transport, phase FROM sessions").get() as Record<string, unknown>;
  const transport = row.transport as "ws" | "stdio";
  const phase = row.phase as Transport;
  return { transport, phase };
}

export function parsePayload(raw: string): Transport {
  const data = JSON.parse(raw) as Record<string, unknown>;
  return data.transport as Transport;
}
