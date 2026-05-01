import { GetSpansParamsSchema, MarkSpansExportedParamsSchema, PruneSpansParamsSchema } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class TelemetryHandlers {
  constructor(private db: StateDb) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("getSpans", async (params) => {
      const { since, limit, unexported } = GetSpansParamsSchema.parse(params ?? {});
      return { spans: this.db.getSpans({ since, limit, unexported }) };
    });
    handlers.set("markSpansExported", async (params) => {
      const { ids } = MarkSpansExportedParamsSchema.parse(params);
      const marked = this.db.markSpansExported(ids);
      return { marked };
    });
    handlers.set("pruneSpans", async (params) => {
      const { before } = PruneSpansParamsSchema.parse(params ?? {});
      return { pruned: this.db.pruneSpans(before) };
    });
  }
}
