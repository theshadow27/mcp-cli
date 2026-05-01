import { SetBudgetConfigParamsSchema } from "@mcp-cli/core";
import type { IpcMethod } from "@mcp-cli/core";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class BudgetHandlers {
  constructor(private db: StateDb) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("getBudgetConfig", async () => this.db.getBudgetConfig());
    handlers.set("setBudgetConfig", async (params) => {
      const parsed = SetBudgetConfigParamsSchema.parse(params);
      this.db.setBudgetConfig(parsed);
      return { ok: true as const };
    });
  }
}
