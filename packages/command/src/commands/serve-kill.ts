/**
 * `mcx serve kill` — kill running serve instances.
 *
 * Usage:
 *   mcx serve kill <pid>           Kill a specific serve instance by PID
 *   mcx serve kill --all           Kill all serve instances
 *   mcx serve kill --stale [hours] Kill instances older than N hours (default: 24)
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
  mcx serve kill <pid>           Kill a specific serve instance by PID
  mcx serve kill --all           Kill all serve instances
  mcx serve kill --stale [hours] Kill instances older than N hours (default: 24)

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
  const staleIdx = rest.indexOf("--stale");
  let staleHours: number | undefined;
  if (staleIdx !== -1) {
    const next = rest[staleIdx + 1];
    staleHours = next != null && !next.startsWith("-") ? Number(next) : 24;
    if (Number.isNaN(staleHours) || staleHours < 0) {
      d.logError(`Invalid --stale value: ${next}`);
      return;
    }
  }

  const positional = rest.filter((a, i) => {
    if (a.startsWith("-")) return false;
    if (staleIdx !== -1 && i === staleIdx + 1) return false;
    return true;
  });
  const pidArg = positional[0] ? Number(positional[0]) : undefined;

  if (!killAll && pidArg == null && staleHours == null) {
    printHelp(d.logError);
    return;
  }

  if (pidArg != null && Number.isNaN(pidArg)) {
    d.logError(`Invalid PID: ${positional[0]}`);
    return;
  }

  const params = staleHours != null ? { staleHours } : killAll ? { all: true } : { pid: pidArg };
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
