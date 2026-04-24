import type { Database } from "bun:sqlite";
import type { MonitorEvent } from "@mcp-cli/core";
import type { WorkItemDb } from "./db/work-items";
import type { DerivedRule } from "./derived-rules";
import type { EventBus } from "./event-bus";

const MAX_DERIVED_DEPTH = 4;

export class DerivedEventPublisher {
  private readonly bus: EventBus;
  private readonly rules: DerivedRule[];
  private readonly ctx: { workItemDb: WorkItemDb; bus: EventBus };
  private readonly db: Database;

  constructor(opts: { bus: EventBus; rules: DerivedRule[]; workItemDb: WorkItemDb; db: Database }) {
    this.bus = opts.bus;
    this.rules = opts.rules;
    this.ctx = { workItemDb: opts.workItemDb, bus: opts.bus };
    this.db = opts.db;
    this.bus.subscribe((event) => this.handleEvent(event));
  }

  private handleEvent(event: MonitorEvent): void {
    const causedBy = Array.isArray(event.causedBy) ? (event.causedBy as number[]) : [];
    if (causedBy.length >= MAX_DERIVED_DEPTH) return;

    for (const rule of this.rules) {
      if (!rule.match(event)) continue;

      // Atomic: DB mutation (inside rule.derive) + event log append (inside bus.publish)
      // share the same SQLite connection, so the transaction prevents a crash from
      // leaving the DB updated without the corresponding event persisted.
      this.db.transaction(() => {
        const derived = rule.derive(event, this.ctx);
        if (derived) {
          const chain = [...causedBy, event.seq];
          this.bus.publish({ ...derived, causedBy: chain });
        }
      })();
    }
  }
}
