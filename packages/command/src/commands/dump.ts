/**
 * mcx dump — snapshot daemon state for bug reports.
 *
 * Gathers daemon status, sessions, servers, metrics, logs, and local
 * system info into a single JSON blob suitable for attaching to issues.
 *
 * Usage:
 *   mcx dump                         Write to ~/.mcp-cli/dumps/dump-<timestamp>.json
 *   mcx dump --stdout                JSON to stdout
 *   mcx dump --include-transcripts   Include last 50 lines of each session log
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DaemonStatus,
  GetDaemonLogsResult,
  IpcMethod,
  IpcMethodResult,
  MetricsSnapshot,
  SessionInfo,
} from "@mcp-cli/core";
import { MCP_CLI_DIR, PING_TIMEOUT_MS, ProtocolMismatchError } from "@mcp-cli/core";
import { ipcCall } from "../daemon-lifecycle";
import { printError as defaultPrintError, formatToolResult } from "../output";

// ── Dependency injection ──

export interface DumpDeps {
  ipcCall: <M extends IpcMethod>(
    method: M,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<IpcMethodResult[M]>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
  /** Run a command and return stdout. Used for ps and git. */
  exec: (cmd: string[]) => { stdout: string; exitCode: number };
  /** Directory for dump output files. */
  dumpsDir: string;
}

const defaultDeps: DumpDeps = {
  ipcCall,
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
  exec: (cmd) => {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { stdout: result.stdout.toString(), exitCode: result.exitCode };
  },
  dumpsDir: join(MCP_CLI_DIR, "dumps"),
};

export async function cmdDump(args: string[], deps?: Partial<DumpDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const toStdout = args.includes("--stdout");
  const includeTranscripts = args.includes("--include-transcripts");

  const timestamp = new Date().toISOString();

  // Gather all data concurrently, tolerating individual failures
  const [daemon, metrics, daemonLogs, sessions, processes, worktrees] = await Promise.all([
    gatherDaemon(d),
    gatherMetrics(d),
    gatherDaemonLogs(d),
    gatherSessions(d, includeTranscripts),
    gatherProcesses(d),
    gatherWorktrees(d),
  ]);

  const dump: Record<string, unknown> = {
    timestamp,
    daemon,
    sessions,
    servers: daemon?.servers ?? null,
    metrics,
    worktrees,
    processes,
    daemonLog: daemonLogs,
    db: daemon
      ? {
          path: daemon.dbPath,
          usageStatsCount: daemon.usageStats.length,
        }
      : null,
  };

  const json = JSON.stringify(dump, null, 2);

  if (toStdout) {
    console.log(json);
    return;
  }

  // Write to file
  if (!existsSync(d.dumpsDir)) {
    mkdirSync(d.dumpsDir, { recursive: true });
  }

  const slug = timestamp.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const filePath = join(d.dumpsDir, `dump-${slug}.json`);
  writeFileSync(filePath, `${json}\n`);
  console.error(`Dump written to ${filePath}`);
}

// ── Data gatherers ──

async function gatherDaemon(d: DumpDeps): Promise<DaemonStatus | null> {
  try {
    return await d.ipcCall("status", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      return { pid: -1, uptime: 0, protocolVersion: err.daemonVersion, servers: [], dbPath: "", usageStats: [] };
    }
    return null;
  }
}

async function gatherMetrics(d: DumpDeps): Promise<MetricsSnapshot | null> {
  try {
    return await d.ipcCall("getMetrics", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch {
    return null;
  }
}

async function gatherDaemonLogs(d: DumpDeps): Promise<GetDaemonLogsResult["lines"] | null> {
  try {
    const result = await d.ipcCall("getDaemonLogs", { limit: 200 }, { timeoutMs: PING_TIMEOUT_MS });
    return result.lines;
  } catch {
    return null;
  }
}

interface SessionDumpInfo extends SessionInfo {
  transcript?: string[];
}

async function gatherSessions(d: DumpDeps, includeTranscripts: boolean): Promise<SessionDumpInfo[] | null> {
  try {
    const result = await d.ipcCall(
      "callTool",
      { server: "_claude", tool: "claude_session_list", arguments: {} },
      { timeoutMs: PING_TIMEOUT_MS },
    );
    const text = formatToolResult(result);
    const sessions: SessionInfo[] = JSON.parse(text);

    if (!includeTranscripts) return sessions;

    // Fetch last 50 lines of each session's log
    const enriched: SessionDumpInfo[] = [];
    for (const session of sessions) {
      const info: SessionDumpInfo = { ...session };
      try {
        const logResult = await d.ipcCall(
          "callTool",
          {
            server: "_claude",
            tool: "claude_session_log",
            arguments: { sessionId: session.sessionId, last: 50 },
          },
          { timeoutMs: PING_TIMEOUT_MS },
        );
        const logText = formatToolResult(logResult);
        info.transcript = logText.split("\n");
      } catch {
        info.transcript = ["(unavailable)"];
      }
      enriched.push(info);
    }
    return enriched;
  } catch {
    return null;
  }
}

function gatherProcesses(d: DumpDeps): string[] | null {
  try {
    const { stdout, exitCode } = d.exec(["ps", "aux"]);
    if (exitCode !== 0) return null;
    const lines = stdout.split("\n");
    const header = lines[0];
    const relevant = lines.filter(
      (line) => line.includes("mcpd") || line.includes("mcx") || line.includes("claude") || line.includes("mcp-cli"),
    );
    return header ? [header, ...relevant] : relevant;
  } catch {
    return null;
  }
}

function gatherWorktrees(d: DumpDeps): Array<{ path: string; branch: string | null }> | null {
  try {
    const { stdout, exitCode } = d.exec(["git", "worktree", "list", "--porcelain"]);
    if (exitCode !== 0) return null;

    const worktrees: Array<{ path: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath) worktrees.push({ path: currentPath, branch: currentBranch });
        currentPath = line.slice("worktree ".length);
        currentBranch = null;
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }
    if (currentPath) worktrees.push({ path: currentPath, branch: currentBranch });

    return worktrees;
  } catch {
    return null;
  }
}
