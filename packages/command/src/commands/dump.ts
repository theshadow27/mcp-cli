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
import { printError as defaultPrintError } from "../output";

/** Timeout for individual session transcript fetches (independent of ping timeout). */
const TRANSCRIPT_TIMEOUT_MS = 5_000;

/** Structured error returned when a gather function fails, instead of opaque null. */
export interface GatherError {
  error: string;
  gatheredAt: string;
}

function gatherError(err: unknown): GatherError {
  const message = err instanceof Error ? err.message : String(err);
  return { error: message, gatheredAt: new Date().toISOString() };
}

/** Type guard: returns true if the value is a GatherError (has `error` and `gatheredAt` fields). */
export function isGatherError(v: unknown): v is GatherError {
  return v != null && typeof v === "object" && "error" in v && "gatheredAt" in v;
}

// ── Dependency injection ──

export interface DumpDeps {
  ipcCall: <M extends IpcMethod>(
    method: M,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<IpcMethodResult[M]>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
  /** Run a command and return stdout. Used for git worktree list. */
  exec: (cmd: string[]) => { stdout: string; exitCode: number };
  /** Check if a process PID is alive (kill -0 equivalent). */
  checkPid: (pid: number) => boolean;
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
  checkPid: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  dumpsDir: join(MCP_CLI_DIR, "dumps"),
};

export async function cmdDump(args: string[], deps?: Partial<DumpDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const toStdout = args.includes("--stdout");
  const includeTranscripts = args.includes("--include-transcripts");

  const timestamp = new Date().toISOString();

  // Gather all data concurrently, tolerating individual failures
  const [daemon, metrics, daemonLogs, sessions, worktrees] = await Promise.all([
    gatherDaemon(d),
    gatherMetrics(d),
    gatherDaemonLogs(d),
    gatherSessions(d, includeTranscripts),
    gatherWorktrees(d),
  ]);

  // PID liveness check — uses kill -0, no raw process listing
  const daemonOk = !isGatherError(daemon);
  const daemonProcess = daemonOk && daemon.pid > 0 ? { pid: daemon.pid, alive: d.checkPid(daemon.pid) } : null;

  const dump: Record<string, unknown> = {
    timestamp,
    daemon,
    sessions,
    servers: daemonOk ? daemon.servers : null,
    metrics,
    worktrees,
    daemonProcess,
    daemonLog: daemonLogs,
    db: daemonOk
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

async function gatherDaemon(d: DumpDeps): Promise<DaemonStatus | GatherError> {
  try {
    return await d.ipcCall("status", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      return { pid: -1, uptime: 0, protocolVersion: err.daemonVersion, servers: [], dbPath: "", usageStats: [] };
    }
    return gatherError(err);
  }
}

async function gatherMetrics(d: DumpDeps): Promise<MetricsSnapshot | GatherError> {
  try {
    return await d.ipcCall("getMetrics", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch (err) {
    return gatherError(err);
  }
}

async function gatherDaemonLogs(d: DumpDeps): Promise<GetDaemonLogsResult["lines"] | GatherError> {
  try {
    const result = await d.ipcCall("getDaemonLogs", { limit: 200 }, { timeoutMs: PING_TIMEOUT_MS });
    return result.lines;
  } catch (err) {
    return gatherError(err);
  }
}

interface SessionDumpInfo extends SessionInfo {
  transcript?: string[];
}

/** Extract text from an MCP tool result content array. */
function extractText(result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) return null;
  const item = (content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === "text" && typeof c.text === "string",
  );
  return item?.text ?? null;
}

async function gatherSessions(d: DumpDeps, includeTranscripts: boolean): Promise<SessionDumpInfo[] | GatherError> {
  try {
    const result = await d.ipcCall(
      "callTool",
      { server: "_claude", tool: "claude_session_list", arguments: {} },
      { timeoutMs: PING_TIMEOUT_MS },
    );

    // Parse IPC response directly — don't use formatToolResult as a data pipeline
    const text = extractText(result);
    if (text == null) return gatherError("No text content in session list response");
    const sessions: SessionInfo[] = JSON.parse(text);

    if (!includeTranscripts) return sessions;

    // Fetch all transcripts concurrently; one failure does not abort others
    const settled = await Promise.allSettled(
      sessions.map((session) =>
        d
          .ipcCall(
            "callTool",
            {
              server: "_claude",
              tool: "claude_session_log",
              arguments: { sessionId: session.sessionId, last: 50 },
            },
            { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
          )
          .then((logResult) => extractText(logResult)),
      ),
    );

    return sessions.map((session, i) => {
      const r = settled[i];
      const transcript = r.status === "fulfilled" && r.value != null ? r.value.split("\n") : ["(unavailable)"];
      return { ...session, transcript };
    });
  } catch (err) {
    return gatherError(err);
  }
}

function gatherWorktrees(d: DumpDeps): Array<{ path: string; branch: string | null }> | GatherError {
  try {
    const { stdout, exitCode } = d.exec(["git", "worktree", "list", "--porcelain"]);
    if (exitCode !== 0) return gatherError(`git worktree list exited with code ${exitCode}`);

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
  } catch (err) {
    return gatherError(err);
  }
}
