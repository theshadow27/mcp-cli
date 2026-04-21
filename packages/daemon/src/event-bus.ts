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
 * #1512
 */

import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import type { EventLog } from "./event-log";

export type EventFilter = (event: MonitorEvent) => boolean;

export interface Subscription {
  id: number;
  filter: EventFilter | null;
  callback: (event: MonitorEvent) => void;
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

    // Snapshot before iterating so unsubscribe during callback doesn't skip subs.
    for (const sub of Array.from(this.subscribers.values())) {
      if (sub.filter === null || sub.filter(event)) {
        try {
          sub.callback(event);
        } catch (err) {
          console.error(`[EventBus] subscriber ${sub.id} threw:`, err);
        }
      }
    }
    return event;
  }

  subscribe(callback: (event: MonitorEvent) => void, filter?: EventFilter): number {
    const id = ++this.nextSubId;
    this.subscribers.set(id, { id, filter: filter ?? null, callback });
    return id;
  }

  unsubscribe(id: number): boolean {
    return this.subscribers.delete(id);
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
}
