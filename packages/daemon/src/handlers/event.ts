import { IPC_ERROR, PublishEventParamsSchema } from "@mcp-cli/core";
import type { IpcMethod, MonitorEventInput } from "@mcp-cli/core";
import type { EventBus } from "../event-bus";
import type { RequestHandler } from "../handler-types";

export class EventHandlers {
  constructor(private eventBus: EventBus | null) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("publishEvent", async (params) => {
      const parsed = PublishEventParamsSchema.parse(params);
      if (!this.eventBus) {
        throw Object.assign(new Error("EventBus not available"), { code: IPC_ERROR.INTERNAL_ERROR });
      }
      const input: MonitorEventInput = {
        ...(parsed.extra && parsed.extra),
        src: parsed.src,
        event: parsed.event,
        category: parsed.category,
        ...(parsed.sessionId !== undefined && { sessionId: parsed.sessionId }),
        ...(parsed.workItemId !== undefined && { workItemId: parsed.workItemId }),
        ...(parsed.prNumber !== undefined && { prNumber: parsed.prNumber }),
      };
      const published = this.eventBus.publish(input);
      return { ok: true as const, seq: published.seq };
    });
  }
}
