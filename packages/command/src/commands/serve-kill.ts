/**
 * `mcx serve kill` — kill running serve instances.
 *
 * Usage:
 *   mcx serve kill <pid>       Kill a specific serve instance by PID
 *   mcx serve kill --all       Kill all serve instances
 */

import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { c } from "../output";
import { extractJsonFlag } from "../parse";

export interface ServeKillDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

const defaultDeps: ServeKillDeps = {
  ipcCall: defaultIpcCall,
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
};

function printHelp(log: (msg: string) => void): void {
  log(`mcx serve kill — kill running serve instances

Usage:
  mcx serve kill <pid>       Kill a specific serve instance by PID
  mcx serve kill --all       Kill all serve instances

Flags:
  --json, -j     Output as JSON
  --help, -h     Show this help`);
}

export async function cmdServeKill(args: string[], deps?: Partial<ServeKillDeps>): Promise<void> {
  const d: ServeKillDeps = { ...defaultDeps, ...deps };
  const { json: isJson, rest } = extractJsonFlag(args);

  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp(d.log);
    return;
  }

  const killAll = rest.includes("--all");
  const positional = rest.filter((a) => !a.startsWith("-"));
  const pidArg = positional[0] ? Number(positional[0]) : undefined;

  if (!killAll && pidArg == null) {
    printHelp(d.logError);
    return;
  }

  if (pidArg != null && Number.isNaN(pidArg)) {
    d.logError(`Invalid PID: ${positional[0]}`);
    return;
  }

  const params = killAll ? { all: true } : { pid: pidArg };
  const result = await d.ipcCall("killServe", params);

  if (isJson) {
    d.log(JSON.stringify(result));
  } else {
    if (result.killed === 0) {
      d.logError("No serve instances to kill.");
    } else {
      d.logError(`${c.green}Killed ${result.killed} serve instance${result.killed > 1 ? "s" : ""}.${c.reset}`);
    }
  }
}
