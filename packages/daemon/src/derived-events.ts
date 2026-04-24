import type { Database } from "bun:sqlite";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import type { DerivedRule } from "./derived-rules";
import type { EventBus } from "./event-bus";

// Causal chain length beyond which derived events are dropped to prevent infinite loops.
const MAX_DERIVED_DEPTH = 4;

export class DerivedEventPublisher {
  private readonly bus: EventBus;
  private readonly rules: DerivedRule[];
  private readonly ctx: { workItemDb: WorkItemDb; bus: EventBus };
  private readonly db: Database;
  private readonly subId: number;

  constructor(opts: { bus: EventBus; rules: DerivedRule[]; workItemDb: WorkItemDb; db: Database }) {
    this.bus = opts.bus;
    this.rules = opts.rules;
    this.ctx = { workItemDb: opts.workItemDb, bus: opts.bus };
    this.db = opts.db;
    this.subId = this.bus.subscribe((event) => this.handleEvent(event));
  }

  dispose(): void {
    this.bus.unsubscribe(this.subId);
  }

  private handleEvent(event: MonitorEvent): void {
    const causedBy = event.causedBy ?? [];
    if (causedBy.length >= MAX_DERIVED_DEPTH) return;

    const chain = [...causedBy, event.seq];
    const outputs: MonitorEventInput[] = [];

    // All rule mutations run in one transaction: either all DB writes commit or none do.
    // bus.publish is called AFTER commit so subscribers never observe events inside an open transaction.
    this.db.transaction(() => {
      for (const rule of this.rules) {
        if (!rule.match(event)) continue;
        const out = rule.apply(event, this.ctx);
        if (out) outputs.push({ ...out, src: "daemon.derived", causedBy: chain });
      }
    })();

    for (const input of outputs) {
      this.bus.publish(input);
    }
  }
}
