import type { Database } from "bun:sqlite";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import { isDerivedPending } from "./derived-rules";
import type { DerivedRule } from "./derived-rules";
import type { EventBus } from "./event-bus";
import type { EventLog } from "./event-log";
import { metrics } from "./metrics";

// Causal chain length beyond which derived events are dropped to prevent infinite loops.
const MAX_DERIVED_DEPTH = 4;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

const CURSOR_ID = "derived_publisher";

export class DerivedEventPublisher {
  private readonly bus: EventBus;
  private readonly rules: DerivedRule[];
  private readonly ctx: { workItemDb: WorkItemDb; bus: EventBus };
  private readonly db: Database;
  private readonly eventLog: EventLog | null;
  private readonly subId: number;
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private cursor: number;
  private reconcileTarget: number | null = null;

  constructor(opts: {
    bus: EventBus;
    rules: DerivedRule[];
    workItemDb: WorkItemDb;
    db: Database;
    eventLog?: EventLog;
    /** Override base delay for retries (ms). Exposed for testing. */
    retryBaseMs?: number;
  }) {
    const busEventLog = opts.bus.eventLog;
    if (opts.eventLog && busEventLog && opts.eventLog !== busEventLog) {
      throw new Error("DerivedEventPublisher received mismatched eventLog and bus.eventLog");
    }

    this.bus = opts.bus;
    this.rules = opts.rules;
    this.ctx = { workItemDb: opts.workItemDb, bus: opts.bus };
    this.db = opts.db;
    this.eventLog = opts.eventLog ?? busEventLog ?? null;
    if (opts.retryBaseMs !== undefined) this._retryBaseMs = opts.retryBaseMs;

    this.migrateCursor();
    this.cursor = this.loadCursor();

    this.subId = this.bus.subscribe((event) => this.handleEvent(event));
  }

  private _retryBaseMs = RETRY_BASE_MS;

  dispose(): void {
    this.disposed = true;
    this.bus.unsubscribe(this.subId);
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Replay events from the event log that were missed during downtime or a crash.
   * Returns the number of events replayed.
   */
  reconcile(): number {
    if (!this.eventLog) return 0;

    const targetSeq = this.eventLog.currentSeq();
    this.reconcileTarget = targetSeq;

    let replayed = 0;
    while (true) {
      const events = this.eventLog.getSince(this.cursor);
      if (events.length === 0) break;
      for (const event of events) {
        if (event.seq > targetSeq) break;
        this.handleEvent(event);
        replayed++;
      }
      if (events[events.length - 1].seq >= targetSeq) break;
    }

    this.reconcileTarget = null;
    return replayed;
  }

  private handleEvent(event: MonitorEvent): void {
    const causedBy = event.causedBy ?? [];
    if (causedBy.length >= MAX_DERIVED_DEPTH) {
      this.advanceCursor(event.seq);
      return;
    }

    const chain = [...causedBy, event.seq];
    const outputs: MonitorEventInput[] = [];
    const pending: Array<{ rule: DerivedRule; reason: string }> = [];

    // All rule mutations + cursor advance run in one transaction.
    // bus.publish is called AFTER commit so subscribers never observe events inside an open transaction.
    this.db.transaction(() => {
      for (const rule of this.rules) {
        if (!rule.match(event)) continue;
        const out = rule.apply(event, this.ctx);
        if (isDerivedPending(out)) {
          pending.push({ rule, reason: out.reason });
        } else if (out) {
          outputs.push({ ...out, src: "daemon.derived", causedBy: chain });
        }
      }
      this.saveCursor(event.seq);
    })();

    for (const input of outputs) {
      this.bus.publish(input);
    }

    if (pending.length > 0) {
      for (const { rule, reason } of pending) {
        console.warn(`[DerivedEvents] rule "${rule.name}" pending: ${reason} — scheduling retry`);
        metrics.counter("mcpd_derived_retries_total", { rule: rule.name }).inc();
        this.scheduleRetry(event, rule, 0);
      }
    }
  }

  private scheduleRetry(event: MonitorEvent, rule: DerivedRule, attempt: number): void {
    if (this.disposed || attempt >= MAX_RETRIES) {
      if (attempt >= MAX_RETRIES) {
        console.error(
          `[DerivedEvents] rule "${rule.name}" exhausted ${MAX_RETRIES} retries for event seq=${event.seq} — event dropped`,
        );
        metrics.counter("mcpd_derived_retries_exhausted_total", { rule: rule.name }).inc();
      }
      return;
    }

    const delay = this._retryBaseMs * 2 ** attempt;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (this.disposed) return;

      try {
        const chain = [...(event.causedBy ?? []), event.seq];
        const outputs: MonitorEventInput[] = [];
        let stillPending = false;

        this.db.transaction(() => {
          if (!rule.match(event)) return;
          const out = rule.apply(event, this.ctx);
          if (isDerivedPending(out)) {
            stillPending = true;
          } else if (out) {
            outputs.push({ ...out, src: "daemon.derived", causedBy: chain });
          }
        })();

        for (const input of outputs) {
          this.bus.publish(input);
        }

        if (outputs.length > 0) {
          console.warn(`[DerivedEvents] rule "${rule.name}" succeeded on retry ${attempt + 1}`);
        }

        if (stillPending) {
          metrics.counter("mcpd_derived_retries_total", { rule: rule.name }).inc();
          this.scheduleRetry(event, rule, attempt + 1);
        }
      } catch (err) {
        console.error(
          `[DerivedEvents] rule "${rule.name}" threw during retry ${attempt + 1} for event seq=${event.seq}:`,
          err,
        );
        metrics.counter("mcpd_derived_retry_failures_total", { rule: rule.name }).inc();
      }
    }, delay);

    this.pendingTimers.add(timer);
  }

  // ── Cursor persistence ──

  private advanceCursor(seq: number): void {
    this.db.transaction(() => {
      this.saveCursor(seq);
    })();
  }

  private migrateCursor(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS derived_cursor (
        id       TEXT    PRIMARY KEY,
        last_seq INTEGER NOT NULL
      )
    `);
  }

  private loadCursor(): number {
    const row = this.db
      .query<{ last_seq: number }, [string]>("SELECT last_seq FROM derived_cursor WHERE id = ?")
      .get(CURSOR_ID);
    return row?.last_seq ?? 0;
  }

  private saveCursor(seq: number): void {
    const effectiveSeq = this.reconcileTarget !== null ? Math.min(seq, this.reconcileTarget) : seq;
    if (effectiveSeq <= this.cursor) return;
    this.db.run("INSERT OR REPLACE INTO derived_cursor (id, last_seq) VALUES (?, ?)", [CURSOR_ID, effectiveSeq]);
    this.cursor = effectiveSeq;
  }
}
