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
import { type MonitorEvent, enrichMonitorEvent } from "@mcp-cli/core";
import { safeSetInterval } from "./safe-timers";

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
            domain_id    INTEGER NOT NULL DEFAULT 0,
            payload      TEXT    NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_monitor_events_ts ON monitor_events(ts);
        `);
        this.db.run("INSERT OR REPLACE INTO schema_versions (name, version) VALUES (?, ?)", [CONSUMER, 1]);
      })();
    }

    if (version < 2) {
      this.db.transaction(() => {
        // Added here and not at v1 because v1's append() had no domain to write: every
        // row would have been 0 and the index pure write amplification on the daemon's
        // hottest insert. It arrives with the writer that populates it and with
        // getSince({ domainId }), which is the query that uses it — leading column
        // domain_id for the equality, seq second so the ORDER BY and the `seq > ?`
        // range are both served by the index rather than by a sort.
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_monitor_events_domain ON monitor_events(domain_id, seq);
        `);
        this.db.run("INSERT OR REPLACE INTO schema_versions (name, version) VALUES (?, ?)", [CONSUMER, 2]);
      })();
    }
  }

  /**
   * Persist one published event.
   *
   * `domain_id` is taken from `event.domainId`, which {@link MonitorEvent} declares
   * required — there is no `domainId` parameter to forget and no default to fall
   * through to. Column and payload therefore agree by construction, which is what makes
   * the indexed `domain_id` filter and the replayed `domain` name the same answer.
   */
  append(event: MonitorEvent): number {
    const result = this.db
      .query<
        { seq: number },
        [string, string, string, string, string | null, string | null, number | null, number, string]
      >(
        `INSERT INTO monitor_events (ts, src, event, category, work_item_id, session_id, pr_number, domain_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        event.domainId,
        JSON.stringify(event),
      );

    if (!result) throw new Error("INSERT RETURNING seq produced no row");
    return result.seq;
  }

  /**
   * Replay events after `afterSeq`.
   *
   * `opts.domainId` pushes the domain partition into SQL rather than filtering the rows
   * in JS after reading them: replaying one domain out of a seven-day log should not
   * cost a scan of every other domain's events, and it is the query
   * `idx_monitor_events_domain(domain_id, seq)` exists to serve.
   */
  getSince(afterSeq: number, limit = 1000, opts?: { events?: readonly string[]; domainId?: number }): MonitorEvent[] {
    const where: string[] = ["seq > ?"];
    const params: (string | number)[] = [afterSeq];

    if (opts?.domainId !== undefined) {
      where.push("domain_id = ?");
      params.push(opts.domainId);
    }
    if (opts?.events?.length) {
      where.push(`event IN (${opts.events.map(() => "?").join(", ")})`);
      params.push(...opts.events);
    }
    params.push(limit);

    // `query`, not `prepare`: backfill calls this in a loop of 1000-row batches, and
    // Bun caches prepared statements by SQL text. The four possible WHERE shapes are a
    // fixed set, so the cache stays effective even though the string is built here.
    const rows = this.db
      .query(`SELECT seq, domain_id, payload FROM monitor_events WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
      .all(...params) as { seq: number; domain_id: number; payload: string }[];

    // Overlay the authoritative seq and domain_id from the DB columns — the payload
    // stores a seq=0 placeholder, and rows written before #3040 have no domainId in
    // their JSON at all, so the column is the only honest source for both.
    // Enrich on read so rows written before summary/severity existed still satisfy the contract.
    return rows.map((r) =>
      enrichMonitorEvent({
        ...(JSON.parse(r.payload) as MonitorEvent),
        seq: r.seq,
        domainId: r.domain_id,
      }),
    );
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
    this.pruneTimer = safeSetInterval(() => {
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
