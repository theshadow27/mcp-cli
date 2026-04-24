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

import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import type { SubmitOptions } from "./coalesce";
import { CoalescingPublisher } from "./coalesce";
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

  constructor(eventLog?: EventLog) {
    this.log = eventLog ?? null;
    if (this.log) {
      this.seq = this.log.currentSeq();
    }
  }

  publish(input: MonitorEventInput): MonitorEvent {
    const ts = new Date().toISOString();
    let seq: number;

    if (this.log) {
      try {
        const event = { ...input, seq: 0, ts } satisfies MonitorEvent;
        seq = this.log.append(event);
        this.seq = seq;
      } catch (err) {
        console.error("[EventBus] EventLog append failed, falling back to in-memory seq:", err);
        seq = ++this.seq;
      }
    } else {
      seq = ++this.seq;
    }

    const event = { ...input, seq, ts } satisfies MonitorEvent;

    if (this.subscribers.size === 0) return event;

    // Serialize once for all subscribers — O(1) instead of O(N_subscribers).
    const serialized = JSON.stringify(event);

    // Snapshot before iterating so unsubscribe during callback doesn't skip subs.
    for (const sub of Array.from(this.subscribers.values())) {
      if (sub.filter === null || sub.filter(event)) {
        try {
          sub.callback(event, serialized);
          sub.lastActivityAt = Date.now();
        } catch (err) {
          console.error(`[EventBus] subscriber ${sub.id} threw:`, err);
        }
      }
    }
    return event;
  }

  subscribe(callback: EventCallback, filter?: EventFilter): number {
    const id = ++this.nextSubId;
    this.subscribers.set(id, { id, filter: filter ?? null, callback, lastActivityAt: Date.now() });
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
    sub.lastActivityAt = Date.now();
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
    const cutoff = Date.now() - maxIdleMs;
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
      this.coalescer = new CoalescingPublisher((input) => this.publish(input));
    }
    return this.coalescer;
  }

  publishCoalesced(input: MonitorEventInput, key: string, policy: SubmitOptions<MonitorEventInput>): void {
    this.getCoalescer().submit(key, input, policy);
  }

  flushCoalesced(key?: string): void {
    this.coalescer?.flush(key);
  }

  disposeCoalescer(): void {
    this.coalescer?.dispose();
    this.coalescer = null;
  }
}
