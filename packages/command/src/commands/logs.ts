/**
 * mcp logs <server> — view stderr output from an MCP server.
 * mcp logs --daemon  — view persistent daemon log file.
 *
 * Options:
 *   --daemon        Show daemon logs (reads ~/.mcp-cli/mcpd.log)
 *   -f, --follow    Stream new lines in real time (adaptive polling with backoff)
 *   --lines N       Number of initial lines to show (default: 50)
 */

import { readFileSync } from "node:fs";
import type { GetDaemonLogsResult, GetLogsResult } from "@mcp-cli/core";
import { DAEMON_LOG_PATH, ipcCall } from "@mcp-cli/core";
import { printError } from "../output.js";

export interface LogsArgs {
  server: string | undefined;
  daemon: boolean;
  follow: boolean;
  lines: number;
  error: string | undefined;
}

export function parseLogsArgs(args: string[]): LogsArgs {
  let server: string | undefined;
  let daemon = false;
  let follow = false;
  let lines = 50;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--daemon") {
      daemon = true;
    } else if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "--lines" || arg === "-n") {
      const next = args[++i];
      if (!next || Number.isNaN(Number(next))) {
        error = "--lines requires a number";
        break;
      }
      lines = Number(next);
    } else if (!arg.startsWith("-")) {
      server = arg;
    }
  }

  return { server, daemon, follow, lines, error };
}

/** Backoff constants for follow-mode polling */
const POLL_MIN_MS = 200;
const POLL_MAX_MS = 5_000;

export async function cmdLogs(args: string[]): Promise<void> {
  const parsed = parseLogsArgs(args);

  if (parsed.error) {
    printError(parsed.error);
    process.exit(1);
  }

  if (parsed.daemon) {
    await cmdDaemonLogs(parsed);
    return;
  }

  if (!parsed.server) {
    printError(
      "Usage: mcp logs <server> [-f|--follow] [--lines N]\n       mcp logs --daemon [-f|--follow] [--lines N]",
    );
    process.exit(1);
  }

  const serverName = parsed.server;
  const { follow, lines } = parsed;

  // Fetch initial batch
  const result = (await ipcCall("getLogs", { server: serverName, limit: lines })) as GetLogsResult;

  for (const entry of result.lines) {
    printLogLine(serverName, entry.timestamp, entry.line);
  }

  if (!follow) return;

  // Follow mode: poll with adaptive backoff
  let lastTimestamp = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : Date.now();
  let delay = POLL_MIN_MS;

  const poll = async () => {
    try {
      const update = (await ipcCall("getLogs", { server: serverName, since: lastTimestamp })) as GetLogsResult;
      if (update.lines.length > 0) {
        for (const entry of update.lines) {
          printLogLine(serverName, entry.timestamp, entry.line);
          lastTimestamp = entry.timestamp;
        }
        delay = POLL_MIN_MS; // Reset backoff on data
      } else {
        delay = Math.min(delay * 2, POLL_MAX_MS); // Exponential backoff on idle
      }
    } catch {
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
    timeout = setTimeout(poll, delay);
  };

  let timeout = setTimeout(poll, delay);
  process.on("SIGINT", () => {
    clearTimeout(timeout);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

async function cmdDaemonLogs(parsed: LogsArgs): Promise<void> {
  const { follow, lines } = parsed;

  if (!follow) {
    // Read log file directly — works even when daemon is down (post-mortem)
    let content: string;
    try {
      content = readFileSync(DAEMON_LOG_PATH, "utf-8");
    } catch {
      printError(`No daemon log file found at ${DAEMON_LOG_PATH}`);
      process.exit(1);
    }

    const allLines = content.split("\n").filter(Boolean);
    const tail = allLines.slice(-lines);
    for (const line of tail) {
      process.stderr.write(`${line}\n`);
    }
    return;
  }

  // Follow mode: use IPC getDaemonLogs with adaptive backoff
  const result = (await ipcCall("getDaemonLogs", { limit: lines })) as GetDaemonLogsResult;

  for (const entry of result.lines) {
    printLogLine("mcpd", entry.timestamp, entry.line);
  }

  let lastTimestamp = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : Date.now();
  let delay = POLL_MIN_MS;

  const poll = async () => {
    try {
      const update = (await ipcCall("getDaemonLogs", { since: lastTimestamp })) as GetDaemonLogsResult;
      if (update.lines.length > 0) {
        for (const entry of update.lines) {
          printLogLine("mcpd", entry.timestamp, entry.line);
          lastTimestamp = entry.timestamp;
        }
        delay = POLL_MIN_MS;
      } else {
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
    } catch {
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
    timeout = setTimeout(poll, delay);
  };

  let timeout = setTimeout(poll, delay);
  process.on("SIGINT", () => {
    clearTimeout(timeout);
    process.exit(0);
  });

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
