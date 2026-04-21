/**
 * Durable event log backed by SQLite.
 *
 * Persists MonitorEvents with a crash-safe monotonic seq (AUTOINCREMENT)
 * so orchestrators can replay missed events via `getSince(cursor)`.
 * 7-day TTL with background pruning.
 *
 * #1513
 */

import type { Database } from "bun:sqlite";
import type { MonitorEvent } from "@mcp-cli/core";

const CONSUMER = "event_log";
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class EventLog {
  private readonly db: Database;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        name    TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);

    const row = this.db
      .query<{ version: number }, [string]>("SELECT version FROM schema_versions WHERE name = ?")
      .get(CONSUMER);

    const version = row?.version ?? 0;

    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS monitor_events (
            seq          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           TEXT    NOT NULL,
            src          TEXT    NOT NULL,
            event        TEXT    NOT NULL,
            category     TEXT    NOT NULL,
            work_item_id TEXT,
            session_id   TEXT,
            pr_number    INTEGER,
            payload      TEXT    NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_monitor_events_ts ON monitor_events(ts);
        `);
        this.db.run("INSERT OR REPLACE INTO schema_versions (name, version) VALUES (?, ?)", [CONSUMER, 1]);
      })();
    }
  }

  append(event: MonitorEvent): number {
    const result = this.db
      .query<{ seq: number }, [string, string, string, string, string | null, string | null, number | null, string]>(
        `INSERT INTO monitor_events (ts, src, event, category, work_item_id, session_id, pr_number, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING seq`,
      )
      .get(
        event.ts,
        event.src,
        event.event,
        event.category,
        (event.workItemId as string | undefined) ?? null,
        (event.sessionId as string | undefined) ?? null,
        (event.prNumber as number | undefined) ?? null,
        JSON.stringify(event),
      );

    if (!result) throw new Error("INSERT RETURNING seq produced no row");
    return result.seq;
  }

  getSince(afterSeq: number, limit = 1000): MonitorEvent[] {
    const rows = this.db
      .query<{ seq: number; payload: string }, [number, number]>(
        "SELECT seq, payload FROM monitor_events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(afterSeq, limit);

    // Overlay the authoritative seq from the DB column — payload stores seq=0 placeholder.
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as MonitorEvent), seq: r.seq }));
  }

  prune(olderThan: Date): number {
    const result = this.db.run("DELETE FROM monitor_events WHERE ts < ?", [olderThan.toISOString()]);
    return result.changes;
  }

  currentSeq(): number {
    // sqlite_sequence is the authoritative AUTOINCREMENT counter — survives pruning.
    const row = this.db
      .query<{ seq: number }, [string]>("SELECT seq FROM sqlite_sequence WHERE name = ?")
      .get("monitor_events");
    return row?.seq ?? 0;
  }

  startPruning(): void {
    if (this.pruneTimer !== undefined) return;
    this.pruneTimer = setInterval(() => {
      this.prune(new Date(Date.now() - TTL_MS));
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  stopPruning(): void {
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}
