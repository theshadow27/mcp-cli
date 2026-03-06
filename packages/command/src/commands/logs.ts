/**
 * mcx logs <server> — view stderr output from an MCP server.
 * mcx logs --daemon  — view persistent daemon log file.
 *
 * Options:
 *   --daemon        Show daemon logs (reads ~/.mcp-cli/mcpd.log)
 *   -f, --follow    Stream new lines in real time (adaptive polling with backoff)
 *   --lines N       Number of initial lines to show (default: 50)
 */

import { readFileSync } from "node:fs";
import type { GetDaemonLogsResult, GetLogsResult, IpcMethod } from "@mcp-cli/core";
import { ipcCall, options } from "@mcp-cli/core";
import { printError } from "../output";

export interface LogsArgs {
  server: string | undefined;
  daemon: boolean;
  follow: boolean;
  lines: number;
  error: string | undefined;
}

export interface LogsDeps {
  ipcCall: (method: IpcMethod, params?: unknown) => Promise<unknown>;
  printError: (msg: string) => void;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  daemonLogPath: string;
  writeStderr: (msg: string) => void;
  exit: (code: number) => never;
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelSchedule: (id: ReturnType<typeof setTimeout>) => void;
  onSigint: (fn: () => void) => void;
  keepAlive: () => Promise<void>;
}

const defaultDeps: LogsDeps = {
  ipcCall,
  printError,
  readFileSync: (path, enc) => readFileSync(path, enc),
  daemonLogPath: options.DAEMON_LOG_PATH,
  writeStderr: (msg) => process.stderr.write(msg),
  exit: (code) => process.exit(code),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancelSchedule: (id) => clearTimeout(id),
  onSigint: (fn) => process.on("SIGINT", fn),
  keepAlive: () => new Promise(() => {}),
};

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

export async function cmdLogs(args: string[], deps?: Partial<LogsDeps>): Promise<void> {
  const d: LogsDeps = { ...defaultDeps, ...deps };
  const parsed = parseLogsArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (parsed.daemon) {
    await cmdDaemonLogs(parsed, d);
    return;
  }

  if (!parsed.server) {
    d.printError(
      "Usage: mcx logs <server> [-f|--follow] [--lines N]\n       mcx logs --daemon [-f|--follow] [--lines N]",
    );
    d.exit(1);
  }

  const serverName = parsed.server;
  const { follow, lines } = parsed;

  // Fetch initial batch
  const result = (await d.ipcCall("getLogs", { server: serverName, limit: lines })) as GetLogsResult;

  for (const entry of result.lines) {
    printLogLine(serverName, entry.timestamp, entry.line, d);
  }

  if (!follow) return;

  // Follow mode: poll with adaptive backoff
  let lastTimestamp = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : Date.now();
  let delay = POLL_MIN_MS;

  const poll = async () => {
    try {
      const update = (await d.ipcCall("getLogs", { server: serverName, since: lastTimestamp })) as GetLogsResult;
      if (update.lines.length > 0) {
        for (const entry of update.lines) {
          printLogLine(serverName, entry.timestamp, entry.line, d);
          lastTimestamp = entry.timestamp;
        }
        delay = POLL_MIN_MS; // Reset backoff on data
      } else {
        delay = Math.min(delay * 2, POLL_MAX_MS); // Exponential backoff on idle
      }
    } catch {
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
    timeout = d.schedule(poll, delay);
  };

  let timeout = d.schedule(poll, delay);
  d.onSigint(() => {
    d.cancelSchedule(timeout);
    d.exit(0);
  });

  // Keep process alive
  await d.keepAlive();
}

async function cmdDaemonLogs(parsed: LogsArgs, d: LogsDeps): Promise<void> {
  const { follow, lines } = parsed;

  if (!follow) {
    // Read log file directly — works even when daemon is down (post-mortem)
    let content: string;
    try {
      content = d.readFileSync(d.daemonLogPath, "utf-8");
    } catch {
      d.printError(`No daemon log file found at ${d.daemonLogPath}`);
      d.exit(1);
    }

    const allLines = content.split("\n").filter(Boolean);
    const tail = allLines.slice(-lines);
    for (const line of tail) {
      d.writeStderr(`${line}\n`);
    }
    return;
  }

  // Follow mode: use IPC getDaemonLogs with adaptive backoff
  const result = (await d.ipcCall("getDaemonLogs", { limit: lines })) as GetDaemonLogsResult;

  for (const entry of result.lines) {
    printLogLine("mcpd", entry.timestamp, entry.line, d);
  }

  let lastTimestamp = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : Date.now();
  let delay = POLL_MIN_MS;

  const poll = async () => {
    try {
      const update = (await d.ipcCall("getDaemonLogs", { since: lastTimestamp })) as GetDaemonLogsResult;
      if (update.lines.length > 0) {
        for (const entry of update.lines) {
          printLogLine("mcpd", entry.timestamp, entry.line, d);
          lastTimestamp = entry.timestamp;
        }
        delay = POLL_MIN_MS;
      } else {
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
    } catch {
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
    timeout = d.schedule(poll, delay);
  };

  let timeout = d.schedule(poll, delay);
  d.onSigint(() => {
    d.cancelSchedule(timeout);
    d.exit(0);
  });

  await d.keepAlive();
}

export function printLogLine(server: string, timestamp: number, line: string, deps?: Partial<LogsDeps>): void {
  const write = deps?.writeStderr ?? defaultDeps.writeStderr;
  const dt = new Date(timestamp);
  const time = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}.${pad3(dt.getMilliseconds())}`;
  write(`${time} [${server}] ${line}\n`);
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}
