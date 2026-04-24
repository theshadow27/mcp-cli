import type { Database } from "bun:sqlite";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import { isDerivedPending } from "./derived-rules";
import type { DerivedRule } from "./derived-rules";
import type { EventBus } from "./event-bus";
import { metrics } from "./metrics";

// Causal chain length beyond which derived events are dropped to prevent infinite loops.
const MAX_DERIVED_DEPTH = 4;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

export class DerivedEventPublisher {
  private readonly bus: EventBus;
  private readonly rules: DerivedRule[];
  private readonly ctx: { workItemDb: WorkItemDb; bus: EventBus };
  private readonly db: Database;
  private readonly subId: number;
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(opts: {
    bus: EventBus;
    rules: DerivedRule[];
    workItemDb: WorkItemDb;
    db: Database;
    /** Override base delay for retries (ms). Exposed for testing. */
    retryBaseMs?: number;
  }) {
    this.bus = opts.bus;
    this.rules = opts.rules;
    this.ctx = { workItemDb: opts.workItemDb, bus: opts.bus };
    this.db = opts.db;
    if (opts.retryBaseMs !== undefined) this._retryBaseMs = opts.retryBaseMs;
    this.subId = this.bus.subscribe((event) => this.handleEvent(event));
  }

  private _retryBaseMs = RETRY_BASE_MS;

  dispose(): void {
    this.disposed = true;
    this.bus.unsubscribe(this.subId);
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private handleEvent(event: MonitorEvent): void {
    const causedBy = event.causedBy ?? [];
    if (causedBy.length >= MAX_DERIVED_DEPTH) return;

    const chain = [...causedBy, event.seq];
    const outputs: MonitorEventInput[] = [];
    const pending: Array<{ rule: DerivedRule; reason: string }> = [];

    // All rule mutations run in one transaction: either all DB writes commit or none do.
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
}
