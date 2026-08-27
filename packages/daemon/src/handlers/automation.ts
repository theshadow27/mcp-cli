/**
 * IPC handlers for automation module introspection.
 *
 * The daemon runs one dispatcher per project (#3192), so the `repoRoot` every one of these
 * requests already carried — parsed and ignored back when there was a single dispatcher
 * bound to the daemon's startup directory — is what selects one. A caller in a project the
 * daemon runs no automation for gets an empty answer rather than another project's modules.
 *
 * #2018
 */

import { GetAutomationLogParamsSchema, type IpcMethod, ListAutomationParamsSchema } from "@mcp-cli/core";
import type { AutomationRegistry } from "../automation-bootstrap";
import type { RequestHandler } from "../handler-types";

export class AutomationHandlers {
  constructor(private automation: AutomationRegistry | null) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("listAutomation", async (params) => {
      const parsed = ListAutomationParamsSchema.parse(params);
      const dispatcher = this.automation?.forRoot(parsed.repoRoot);
      if (!dispatcher) {
        return { modules: [], preset: "supervised" };
      }
      return {
        modules: dispatcher.listModules(),
        preset: dispatcher.currentPreset,
      };
    });

    handlers.set("getAutomationLog", async (params) => {
      const parsed = GetAutomationLogParamsSchema.parse(params);
      const dispatcher = this.automation?.forRoot(parsed.repoRoot);
      if (!dispatcher) {
        return { entries: [] };
      }
      return {
        entries: dispatcher.getAuditLog(parsed.module, parsed.limit),
      };
    });
  }
}
