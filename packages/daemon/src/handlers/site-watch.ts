import { SiteWatchCursorGetParamsSchema, SiteWatchCursorSetParamsSchema } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { McxDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

/**
 * Per-thread watch-cursor persistence for `mcx watch`. The Trouter watcher runs
 * inside the `_site` worker (co-located with the credential vault), which has no
 * direct `McxDb` handle; it reads and writes its high-water `version` cursor
 * through these two narrow IPC methods so the cursor lives in mcx.db.
 */
export class SiteWatchHandlers {
  constructor(private db: McxDb) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("siteWatchCursorGet", async (params) => {
      const { site, thread } = SiteWatchCursorGetParamsSchema.parse(params);
      return { lastVersion: this.db.getSiteWatchCursor(site, thread) };
    });

    handlers.set("siteWatchCursorSet", async (params) => {
      const { site, thread, lastVersion } = SiteWatchCursorSetParamsSchema.parse(params);
      this.db.setSiteWatchCursor(site, thread, lastVersion);
      return { ok: true as const };
    });
  }
}
