/**
 * In-memory event bus for the unified monitor event stream.
 *
 * Bridges session, work-item, and mail event sources into a single
 * typed stream of MonitorEvent envelopes. Seq is globally monotonic
 * across all sources; ts is stamped at publish time.
 *
 * #1512
 */

import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";

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

  publish(input: MonitorEventInput): MonitorEvent {
    const event = {
      ...input,
      seq: ++this.seq,
      ts: new Date().toISOString(),
    } satisfies MonitorEvent;
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
}
