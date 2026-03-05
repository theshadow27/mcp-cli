/**
 * `mcx get` — inspect a single server's config and status.
 *
 * Shows config details, source file, scope, and connection status.
 */

import type { GetConfigResult, ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { c, printError } from "../output";
import { extractJsonFlag } from "../parse";

export async function cmdGet(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const name = rest[0];

  if (!name) {
    printError("Usage: mcx get <name> [--json]");
    process.exit(1);
  }

  const config = (await ipcCall("getConfig")) as GetConfigResult;
  const servers = (await ipcCall("listServers")) as ServerStatus[];

  const serverConfig = config.servers[name];
  if (!serverConfig) {
    printError(`Server "${name}" not found`);
    process.exit(1);
  }

  const status = servers.find((s) => s.name === name);

  if (json) {
    console.log(
      JSON.stringify(
        {
          name,
          transport: serverConfig.transport,
          source: serverConfig.source,
          scope: serverConfig.scope,
          toolCount: serverConfig.toolCount,
          state: status?.state ?? "unknown",
          lastError: status?.lastError,
        },
        null,
        2,
      ),
    );
    return;
  }

  const stateColor = status?.state === "connected" ? c.green : status?.state === "error" ? c.red : c.yellow;

  console.log(`${c.bold}Server${c.reset}: ${c.cyan}${name}${c.reset}`);
  console.log(`${c.bold}Transport${c.reset}: ${serverConfig.transport}`);
  console.log(`${c.bold}Source${c.reset}: ${serverConfig.source} ${c.dim}(${serverConfig.scope})${c.reset}`);
  console.log(`${c.bold}Status${c.reset}: ${stateColor}${status?.state ?? "unknown"}${c.reset}`);
  console.log(`${c.bold}Tools${c.reset}: ${serverConfig.toolCount}`);

  if (status?.lastError) {
    console.log(`${c.bold}Error${c.reset}: ${c.red}${status.lastError}${c.reset}`);
  }
}
