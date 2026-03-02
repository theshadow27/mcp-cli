/**
 * mcp logs <server> — view stderr output from an MCP server.
 *
 * Options:
 *   -f, --follow    Stream new lines in real time (poll every 500ms)
 *   --lines N       Number of initial lines to show (default: 50)
 */

import type { GetLogsResult } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { printError } from "../output.js";

export async function cmdLogs(args: string[]): Promise<void> {
  let server: string | undefined;
  let follow = false;
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "--lines" || arg === "-n") {
      const next = args[++i];
      if (!next || Number.isNaN(Number(next))) {
        printError("--lines requires a number");
        process.exit(1);
      }
      lines = Number(next);
    } else if (!arg.startsWith("-")) {
      server = arg;
    }
  }

  if (!server) {
    printError("Usage: mcp logs <server> [-f|--follow] [--lines N]");
    process.exit(1);
  }

  const serverName: string = server;

  // Fetch initial batch
  const result = (await ipcCall("getLogs", { server: serverName, limit: lines })) as GetLogsResult;

  for (const entry of result.lines) {
    printLogLine(serverName, entry.timestamp, entry.line);
  }

  if (!follow) return;

  // Follow mode: poll with since param
  let lastTimestamp = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : Date.now();

  const poll = async () => {
    try {
      const update = (await ipcCall("getLogs", { server: serverName, since: lastTimestamp })) as GetLogsResult;
      for (const entry of update.lines) {
        printLogLine(serverName, entry.timestamp, entry.line);
        lastTimestamp = entry.timestamp;
      }
    } catch {
      // Connection lost — ignore, will retry next tick
    }
  };

  // Poll every 500ms until Ctrl+C
  const interval = setInterval(poll, 500);
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

function printLogLine(server: string, timestamp: number, line: string): void {
  const d = new Date(timestamp);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
  process.stderr.write(`${time} [${server}] ${line}\n`);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}
