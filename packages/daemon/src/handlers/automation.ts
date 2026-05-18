/**
 * IPC handlers for automation module introspection.
 *
 * #2018
 */

import { GetAutomationLogParamsSchema, type IpcMethod, ListAutomationParamsSchema } from "@mcp-cli/core";
import type { AutomationDispatcher } from "../automation-dispatcher";
import type { RequestHandler } from "../handler-types";

export class AutomationHandlers {
  constructor(private dispatcher: AutomationDispatcher | null) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("listAutomation", async (params) => {
      const _parsed = ListAutomationParamsSchema.parse(params);
      if (!this.dispatcher) {
        return { modules: [], preset: "supervised" };
      }
      return {
        modules: this.dispatcher.listModules(),
        preset: this.dispatcher.currentPreset,
      };
    });

    handlers.set("getAutomationLog", async (params) => {
      const parsed = GetAutomationLogParamsSchema.parse(params);
      if (!this.dispatcher) {
        return { entries: [] };
      }
      return {
        entries: this.dispatcher.getAuditLog(parsed.module, parsed.limit),
      };
    });
  }
}
