/**
 * In-memory event bus for the unified monitor event stream.
 *
 * Bridges session, work-item, and mail event sources into a single
 * typed stream of MonitorEvent envelopes. Seq is monotonically increasing
 * within a single EventBus instance; ts is stamped at publish time.
 *
 * When an EventLog is provided, events are durably persisted and seq is
 * assigned by SQLite AUTOINCREMENT — surviving daemon restarts. (#1513)
 *
 * #1512 #1557
 */

import { type MonitorEvent, type MonitorEventInput, NO_DOMAIN_ID, enrichMonitorEvent } from "@mcp-cli/core";
import type { CoalescerOptions, SubmitOptions } from "./coalesce";
import { CoalescingPublisher } from "./coalesce";
import { type DomainResolver, NULL_DOMAIN_RESOLVER } from "./domain-resolver";
import type { EventLog } from "./event-log";
import { metrics } from "./metrics";

export type EventFilter = (event: MonitorEvent) => boolean;

/** Subscriber callback receives the event and its pre-serialized JSON string (serialized once per publish, not once per subscriber). */
export type EventCallback = (event: MonitorEvent, serialized: string) => void;

export interface Subscription {
  id: number;
  filter: EventFilter | null;
  callback: EventCallback;
  /** Epoch ms of last event delivery; used for stale-subscriber pruning (#1557). */
  lastActivityAt: number;
}

export class EventBus {
  private seq = 0;
  private nextSubId = 0;
  private readonly subscribers = new Map<number, Subscription>();
  private readonly log: EventLog | null;
  private readonly now: () => number;
  private readonly domains: DomainResolver;

  constructor(eventLog?: EventLog, now: () => number = Date.now, domains: DomainResolver = NULL_DOMAIN_RESOLVER) {
    this.log = eventLog ?? null;
    this.now = now;
    this.domains = domains;
    if (this.log) {
      this.seq = this.log.currentSeq();
    }
  }

  /** The resolver this bus stamps with — consumers need name↔id to filter a stream by domain. */
  get domainResolver(): DomainResolver {
    return this.domains;
  }

  /**
   * Which domain owns this event?
   *
   * Resolved in a fixed precedence, most-authoritative first:
   *
   *   1. `domainId` — the producer was handed a domain and says so. Believed outright.
   *   2. `repoRoot` — the producer supplied its own path.
   *   3. `sessionId` — the domain of the session the event is about, read off that
   *      session's own row.
   *
   * **This is preference order, not strict precedence.** Each step is tried only until
   * one *resolves*; a `repoRoot` that names no registered domain falls THROUGH to the
   * session rather than terminating at the sentinel. So an event a producer explicitly
   * scoped to a non-domain path can still inherit its session's domain. That is
   * deliberate — a path outside every domain carries no information to preserve, and
   * discarding the session's answer for it would lose the partition for no gain — but it
   * means "repoRoot outranks sessionId" is only true when the repoRoot actually resolves.
   *
   * Step 3 exists because steps 1 and 2 alone left the feature almost entirely inert
   * (#3040 review R3). Measured against a real 7-day event log on this box: 98 of 25,536
   * rows carried a `repoRoot`, i.e. 0.4%, while 20,449 — 80% — carried a `sessionId`.
   * `repoRoot` is set at exactly one of the ~20 session-event emission sites and by none
   * of the metric producers, so deriving the partition from it alone meant `-d` filtered
   * correctly over a rounding error of the traffic.
   *
   * Nothing here guesses. A session's domain is a fact recorded on its own row, so step 3
   * is a join on an identity the event already carries. Falling through all three yields
   * `NO_DOMAIN_ID`, which is the honest answer for genuinely daemon-wide events (mail,
   * quota, heartbeat): an un-domained event is excluded by a `-d` filter, so inventing a
   * domain here would silently attribute daemon state to one project.
   *
   * Work-item and CI events keyed only by `workItemId`/`prNumber` resolve their item's own
   * domain at the producer and arrive here as a step-1 `domainId` (`event-domain.ts`,
   * #3352). They used to declare the daemon's `repoRoot` instead, which partitioned them by
   * where the daemon was started rather than by which work item they were about.
   *
   * **The NAME is this bus's to state, never the producer's alone.** `domain` and
   * `domainId` are two representations of one fact, and the live filter matches on the name
   * (`event-filter.ts`) while replay filters on the column (`event-log.ts`) — so a row whose
   * name and id disagree is visible to exactly one of them. A producer-supplied name is
   * therefore kept only when it came with the id it claims to name (mail stamps both, and
   * partition 0 has a name — `UNASSIGNED_DOMAIN_NAME` — that no resolver will return).
   * Anything else is dropped rather than persisted alongside a contradicting column.
   */
  private stampDomain(input: MonitorEventInput): { domainId: number; domain?: string } {
    const domainId = this.resolveDomainId(input);
    const name = domainId === NO_DOMAIN_ID ? null : this.domains.nameForId(domainId);
    if (name !== null) return { domainId, domain: name };
    const claimed = input.domainId === domainId ? input.domain : undefined;
    return { domainId, domain: claimed };
  }

  private resolveDomainId(input: MonitorEventInput): number {
    if (typeof input.domainId === "number") return input.domainId;
    if (typeof input.repoRoot === "string") {
      const fromPath = this.domains.idForPath(input.repoRoot);
      if (fromPath !== NO_DOMAIN_ID) return fromPath;
    }
    if (typeof input.sessionId === "string") return this.domains.idForSession(input.sessionId);
    return NO_DOMAIN_ID;
  }

  publish(rawInput: MonitorEventInput): MonitorEvent {
    // summary/severity are stamped once, here, so every consumer (live stream,
    // replay, TUI) sees them regardless of which producer emitted the event.
    const input = enrichMonitorEvent(rawInput);
    const ts = new Date().toISOString();
    // Domain is stamped alongside seq/ts for the same reason: one enforcement point, so
    // no producer can publish an event the partition cannot see.
    const domain = this.stampDomain(input);
    let seq: number;

    if (this.log) {
      try {
        const event = { ...input, ...domain, seq: 0, ts } satisfies MonitorEvent;
        seq = this.log.append(event);
        this.seq = seq;
      } catch (err) {
        console.error("[EventBus] EventLog append failed, falling back to in-memory seq:", err);
        seq = ++this.seq;
      }
    } else {
      seq = ++this.seq;
    }

    const event = { ...input, ...domain, seq, ts } satisfies MonitorEvent;

    if (this.subscribers.size === 0) return event;

    // Serialize once for all subscribers — O(1) instead of O(N_subscribers).
    const serialized = JSON.stringify(event);

    // Snapshot before iterating so unsubscribe during callback doesn't skip subs.
    for (const sub of Array.from(this.subscribers.values())) {
      if (sub.filter === null || sub.filter(event)) {
        try {
          sub.callback(event, serialized);
          sub.lastActivityAt = this.now();
        } catch (err) {
          console.error(`[EventBus] subscriber ${sub.id} threw:`, err);
        }
      }
    }
    return event;
  }

  subscribe(callback: EventCallback, filter?: EventFilter): number {
    const id = ++this.nextSubId;
    this.subscribers.set(id, { id, filter: filter ?? null, callback, lastActivityAt: this.now() });
    return id;
  }

  unsubscribe(id: number): boolean {
    return this.subscribers.delete(id);
  }

  /**
   * Bump lastActivityAt for a subscriber to now.
   * Call this after any successful write to the peer (e.g., heartbeat) so that
   * quiet-but-live streams are not evicted by pruneStale. (#1649)
   */
  touch(id: number): boolean {
    const sub = this.subscribers.get(id);
    if (!sub) return false;
    sub.lastActivityAt = this.now();
    return true;
  }

  /**
   * Remove subscribers whose lastActivityAt is older than maxIdleMs.
   * Returns the number of subscribers pruned.
   *
   * Secondary defense against leaked subscribers when TCP RST does not fire
   * ReadableStream.cancel() and no write has happened to trigger the try/catch. (#1557)
   */
  pruneStale(maxIdleMs: number): number {
    const cutoff = this.now() - maxIdleMs;
    let pruned = 0;
    for (const [id, sub] of this.subscribers) {
      if (sub.lastActivityAt < cutoff) {
        this.subscribers.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      metrics.gauge("mcpd_event_bus_subscribers").set(this.subscribers.size);
      console.warn(`[EventBus] pruned ${pruned} stale subscriber(s)`);
    }
    return pruned;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get eventLog(): EventLog | null {
    return this.log;
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Returns lastActivityAt for a subscriber by ID, or null if not found. Used in tests. */
  getLastActivityAt(id: number): number | null {
    return this.subscribers.get(id)?.lastActivityAt ?? null;
  }

  // --- Coalesced publishing (#1574) ---

  private coalescer: CoalescingPublisher<MonitorEventInput> | null = null;

  private getCoalescer(): CoalescingPublisher<MonitorEventInput> {
    if (!this.coalescer) {
      const opts: CoalescerOptions = {
        metrics: {
          pendingKeys: metrics.gauge("mcpd_coalescer_pending_keys"),
          overflowTotal: metrics.counter("mcpd_coalescer_overflow_total"),
          emitErrors: metrics.counter("mcpd_coalescer_emit_errors_total"),
        },
      };
      this.coalescer = new CoalescingPublisher((input) => this.publish(input), opts);
    }
    return this.coalescer;
  }

  publishCoalesced(input: MonitorEventInput, key: string, options: SubmitOptions<MonitorEventInput>): void {
    this.getCoalescer().submit(key, input, options);
  }

  flushCoalesced(key?: string): void {
    this.coalescer?.flush(key);
  }

  disposeCoalescer(): void {
    this.coalescer?.dispose();
    this.coalescer = null;
  }
}
