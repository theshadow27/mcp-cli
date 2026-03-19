/**
 * `mcx acp` commands — manage ACP agent sessions via the _acp virtual server.
 *
 * Mirrors `mcx codex` but adds an `--agent` parameter to select which ACP
 * agent to spawn (copilot, gemini, or any custom command).
 *
 * All commands route through `callTool` on the `_acp` virtual server.
 * The `agent` parameter is passed through in tool arguments so the daemon
 * can route to the right agent binary.
 */

import { ACP_AGENTS } from "@mcp-cli/acp";
import { ACP_SERVER_NAME, PROMPT_IPC_TIMEOUT_MS, WorktreeError, createWorktree } from "@mcp-cli/core";
import type { AgentSessionInfo } from "@mcp-cli/core";
import { getStaleDaemonWarning, ipcCall } from "../daemon-lifecycle";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";

import {
  type PrStatus,
  type SharedSessionDeps,
  cleanupWorktree,
  defaultGetPrStatus,
  parseByeResult,
  parseLogArgs,
  parseWaitArgs,
  resolveSessionId,
} from "./claude";
import {
  type TranscriptEntry,
  colorState,
  compactTranscript,
  extractContentSummary,
  filterByRepo,
  formatCost,
  formatSessionShort,
  getGitRepoRoot,
} from "./session-display";
import type { SharedSpawnArgs } from "./spawn-args";
import { parseSharedSpawnArgs } from "./spawn-args";
import { worktreesCommand } from "./worktree-commands";

// ── Constants ──

/** Tool name prefix for the ACP provider. */
const P = "acp";

// ── Dependency injection ──

export interface AcpDeps extends SharedSessionDeps {
  getStaleDaemonWarning: () => string | null;
  getGitRoot: () => string | null;
  getPrStatus: (worktreePath: string) => Promise<PrStatus | null>;
}

const defaultDeps: AcpDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "acp_prompt" && args.wait) || tool === "acp_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: ACP_SERVER_NAME, tool, arguments: args }, { timeoutMs });
  },
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
  getStaleDaemonWarning,
  getGitRoot: getGitRepoRoot,
  getPrStatus: defaultGetPrStatus,
  exec: (cmd, opts) => {
    const result = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  },
};

// ── Entry point ──

/**
 * Main `mcx acp` command handler.
 * @param args - CLI arguments after `acp`
 * @param agentOverride - If set, forces the `--agent` parameter (used by copilot/gemini wrappers)
 * @param deps - Injectable dependencies for testing
 */
export async function cmdAcp(args: string[], agentOverride?: string, deps?: Partial<AcpDeps>): Promise<void> {
  const d: AcpDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printAcpUsage(agentOverride);
    return;
  }

  switch (sub) {
    case "spawn":
      await acpSpawn(args.slice(1), agentOverride, d);
      break;
    case "ls":
    case "list":
      await acpList(args.slice(1), agentOverride, d);
      break;
    case "send":
      await acpSend(args.slice(1), agentOverride, d);
      break;
    case "bye":
    case "quit":
      await acpBye(args.slice(1), agentOverride, d);
      break;
    case "interrupt":
      await acpInterrupt(args.slice(1), agentOverride, d);
      break;
    case "log":
      await acpLog(args.slice(1), agentOverride, d);
      break;
    case "wait":
      await acpWait(args.slice(1), agentOverride, d);
      break;
    case "worktrees":
    case "wt":
      await worktreesCommand(args.slice(1), d);
      break;
    default: {
      const name = agentOverride ?? "acp";
      d.printError(
        `Unknown ${name} subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", "wait", or "worktrees".`,
      );
      d.exit(1);
    }
  }
}

// ── Spawn ──

export interface AcpSpawnArgs extends SharedSpawnArgs {
  agent: string | undefined;
  json: boolean;
  worktree: string | undefined;
}

export function parseAcpSpawnArgs(args: string[], agentOverride?: string): AcpSpawnArgs {
  let agent: string | undefined = agentOverride;
  let json = false;
  let worktree: string | undefined;
  let extraError: string | undefined;

  const shared = parseSharedSpawnArgs(args, (arg, allArgs, i) => {
    if (arg === "--agent" || arg === "-a") {
      if (agentOverride) {
        // Agent already fixed by wrapper — ignore duplicate
        return 1;
      }
      const val = allArgs[i + 1];
      if (!val || val.startsWith("-")) {
        extraError = "--agent requires a value (e.g. copilot, gemini)";
        return 0;
      }
      agent = val;
      return 1;
    }
    if (arg === "--json") {
      json = true;
      return 0;
    }
    if (arg === "--worktree" || arg === "-w") {
      const next = allArgs[i + 1];
      if (next && !next.startsWith("-")) {
        worktree = next;
        return 1;
      }
      worktree = `acp-${Date.now().toString(36)}`;
      return 0;
    }
    return undefined;
  });

  return { ...shared, error: shared.error ?? extraError, agent, json, worktree };
}

async function acpSpawn(args: string[], agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSpawnUsage(agentOverride);
    return;
  }

  const parsed = parseAcpSpawnArgs(args, agentOverride);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.agent) {
    d.printError(`--agent is required. Available agents: ${Object.keys(ACP_AGENTS).join(", ")}`);
    d.exit(1);
  }

  if (!parsed.task) {
    const name = agentOverride ?? "acp";
    const agentFlag = agentOverride ? "" : ` --agent ${parsed.agent}`;
    d.printError(`Usage: mcx ${name} spawn${agentFlag} --task "description" [--worktree [name]] [--allow tools...]`);
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {
    prompt: parsed.task,
    agent: parsed.agent,
  };
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.wait) toolArgs.wait = true;

  if (parsed.worktree) {
    try {
      const result = createWorktree({ name: parsed.worktree, repoRoot: process.cwd(), branchPrefix: "acp/" }, d);
      Object.assign(toolArgs, result.toolArgs);
    } catch (e) {
      d.printError(e instanceof WorktreeError ? e.message : String(e));
      d.exit(1);
    }
  }

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  const text = formatToolResult(result);

  if (parsed.json) {
    console.log(text);
    return;
  }

  try {
    const data = JSON.parse(text) as { sessionId?: string };
    if (data.sessionId) {
      const agentLabel = parsed.agent.charAt(0).toUpperCase() + parsed.agent.slice(1);
      console.error(`${agentLabel} session started: ${data.sessionId.slice(0, 8)}`);
    }
  } catch {
    // Not JSON — fall through
  }
  console.log(text);
}

// ── List ──

async function acpList(args: string[], agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr");
  const showAll = args.includes("--all") || args.includes("-a");

  // Pass agent filter to daemon — when using `mcx copilot ls`, only show copilot sessions
  const toolArgs: Record<string, unknown> = {};
  const agentFilter = agentOverride ?? extractAgentFlag(args);
  if (agentFilter) toolArgs.agent = agentFilter;

  const result = await d.callTool(`${P}_session_list`, toolArgs);
  const text = formatToolResult(result);

  if (json) {
    console.log(text);
    return;
  }

  let sessions: AgentSessionInfo[];
  try {
    sessions = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  // Client-side repo-scoping: filter by cwd prefix unless --all
  if (!showAll) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) {
      sessions = filterByRepo(sessions, gitRoot);
    }
  }

  if (sessions.length === 0) {
    const label = agentFilter ? `${agentFilter} ` : "ACP ";
    console.error(`No active ${label}sessions.`);
    return;
  }

  if (short) {
    for (const s of sessions) {
      console.log(formatSessionShort(s));
    }
    return;
  }

  // Gather PR status for worktree sessions in parallel
  const prStatuses = showPr
    ? await Promise.all(sessions.map((s) => (s.worktree ? d.getPrStatus(s.worktree) : Promise.resolve(null))))
    : sessions.map(() => null);

  const hasAnyPr = showPr && prStatuses.some((pr) => pr !== null);

  // Table output
  const showAgent = !agentOverride;
  const agentHeader = showAgent ? ` ${"AGENT".padEnd(10)}` : "";
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)}${agentHeader} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${prHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const agentCol = showAgent
      ? ` ${(((s as unknown as Record<string, unknown>).agent as string) ?? "—").padEnd(10)}`
      : "";
    const model = (s.model ?? "—").padEnd(16);
    const cost = formatCost(s.cost, s.tokens).padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = s.cwd ?? "—";
    console.log(
      `${c.cyan}${id}${c.reset}   ${state}${agentCol} ${model} ${cost} ${tokens}${pr} ${c.dim}${cwd}${c.reset}`,
    );
  }
}

function formatPrStatus(pr: PrStatus | null): string {
  if (!pr) return "—";
  return `#${pr.number} ${pr.state}`;
}

/** Extract --agent value from args without consuming them. */
function extractAgentFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1] && !args[i + 1].startsWith("-")) {
      return args[i + 1];
    }
  }
  return undefined;
}

// ── Send ──

async function acpSend(args: string[], _agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  let wait = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--wait") {
      wait = true;
    } else {
      rest.push(arg);
    }
  }

  const sessionPrefix = rest[0];
  const message = rest.slice(1).join(" ").trim();

  if (!sessionPrefix || !message) {
    d.printError("Usage: mcx acp send [--wait] <session-id> <message>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const toolArgs: Record<string, unknown> = { sessionId, prompt: message };
  if (wait) toolArgs.wait = true;

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  console.log(formatToolResult(result));
}

// ── Bye ──

async function acpBye(args: string[], _agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx acp bye <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_bye`, { sessionId });

  const byeResult = parseByeResult(result);
  console.log(formatToolResult(result));

  if (byeResult.worktree && byeResult.cwd) {
    cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
  }
}

// ── Interrupt ──

async function acpInterrupt(args: string[], _agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx acp interrupt <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_interrupt`, { sessionId });
  console.log(formatToolResult(result));
}

// ── Log ──

async function acpLog(args: string[], _agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  const parsed = parseLogArgs(args);
  const compact = args.includes("--compact");

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.sessionPrefix) {
    d.printError("Usage: mcx acp log <session-id> [--last N] [--compact]");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(parsed.sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_transcript`, { sessionId, limit: parsed.last });
  const text = formatToolResult(result);

  if (parsed.json) {
    if (parsed.jq) {
      try {
        const data = JSON.parse(text);
        const filtered = await applyJqFilter(data, parsed.jq);
        console.log(JSON.stringify(filtered, null, 2));
      } catch (err) {
        d.printError(err instanceof Error ? err.message : String(err));
        d.exit(1);
      }
      return;
    }
    console.log(text);
    return;
  }

  let entries: TranscriptEntry[];
  try {
    entries = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  if (compact) {
    entries = compactTranscript(entries);
  }

  const truncate = (s: string) => (parsed.full || s.length <= 200 ? s : `${s.slice(0, 200)}…`);

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const dir = entry.direction === "outbound" ? `${c.green}→${c.reset}` : `${c.cyan}←${c.reset}`;
    const type = entry.message.type ?? "unknown";
    console.log(`${c.dim}${time}${c.reset} ${dir} ${c.bold}${type}${c.reset}`);

    if ((type === "user" || type === "assistant") && entry.message.message) {
      const msg = entry.message.message as { content?: unknown };
      const summary = extractContentSummary(msg.content);
      if (summary) {
        console.log(`  ${type === "assistant" ? truncate(summary) : summary}`);
      }
    } else if (type === "result") {
      const res = entry.message as { result?: string };
      if (res.result) {
        console.log(`  ${c.dim}${truncate(res.result)}${c.reset}`);
      }
    }
  }
}

// ── Wait ──

async function acpWait(args: string[], _agentOverride: string | undefined, d: AcpDeps): Promise<void> {
  const parsed = parseWaitArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {};

  if (parsed.sessionPrefix) {
    const sessionId = await resolveSessionId(parsed.sessionPrefix, d, `${P}_session_list`);
    toolArgs.sessionId = sessionId;
  }
  if (parsed.timeout) {
    toolArgs.timeout = parsed.timeout;
  }
  if (parsed.afterSeq !== undefined) {
    toolArgs.afterSeq = parsed.afterSeq;
  }

  const result = await d.callTool(`${P}_wait`, toolArgs);
  const text = formatToolResult(result);

  if (!parsed.short) {
    console.log(text);
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  // Timeout fallback returns a session list array
  if (Array.isArray(data)) {
    for (const s of data as Array<{
      sessionId: string;
      state: string;
      model?: string | null;
      cost?: number | null;
      tokens?: number;
      numTurns?: number;
    }>) {
      console.log(formatSessionShort(s));
    }
    return;
  }

  // Normal event result
  const evt = data as { sessionId?: string; event?: string; cost?: number; numTurns?: number; result?: string };
  const id = evt.sessionId ? evt.sessionId.slice(0, 8) : "—";
  const event = evt.event ?? "—";
  const cost = evt.cost != null && evt.cost > 0 ? `$${evt.cost.toFixed(4)}` : "N/A";
  const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
  const preview = evt.result ? evt.result.slice(0, 100) : "";
  console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
}

// ── Usage ──

function printSpawnUsage(agentOverride?: string): void {
  const name = agentOverride ?? "acp";
  const agentFlag = agentOverride ? "" : " --agent <name>";
  const agentLine = agentOverride
    ? ""
    : `  --agent, -a <name>         ACP agent to spawn (e.g. copilot, gemini, or custom command)
`;

  console.log(`mcx ${name} spawn — Start a new ${agentOverride ?? "ACP"} session

Usage:
  mcx ${name} spawn${agentFlag} --task "description"
  mcx ${name} spawn${agentFlag} --task "description" --worktree my-feature

Options:
${agentLine}  --task, -t <string>        Task prompt for the session (required)
  --worktree, -w [name]      Run in a git worktree for branch isolation
                             Auto-generates a name if omitted
  --allow <tools...>         Space-separated tool patterns to auto-approve
  --json                     Output raw JSON (for scripting/orchestration)
  --model, -m <name>         Model to use (default: provider default)
  --cwd <path>               Working directory for the session
  --wait                     Block until the agent produces a result
  --timeout <ms>             Max wait time in ms (default: 300000, only with --wait)`);
}

function printAcpUsage(agentOverride?: string): void {
  const name = agentOverride ?? "acp";
  const agentFlag = agentOverride ? "" : " --agent <name>";
  const agentList = Object.keys(ACP_AGENTS).join(", ");

  console.log(`mcx ${name} — manage ${agentOverride ?? "ACP agent"} sessions

Usage:
  mcx ${name} spawn${agentFlag} --task "description"    Start a new session
  mcx ${name} ls${agentOverride ? "" : " [--agent <name>]"}                        List active sessions (current repo)
  mcx ${name} ls --all                      List all sessions (all repos)
  mcx ${name} ls --pr                       Show PR status for worktree sessions
  mcx ${name} send <session> <message>      Send follow-up prompt
  mcx ${name} wait [session]                Block until a session event occurs
  mcx ${name} bye <session>                 End session and stop process
  mcx ${name} interrupt <session>           Interrupt the current turn
  mcx ${name} log <session> [--last N]      View session transcript
  mcx ${name} log <session> --json          Raw JSON transcript output
  mcx ${name} log <session> --json --jq '.' Apply jq filter to JSON output
  mcx ${name} log <session> --full          Full output (no truncation)
  mcx ${name} log <session> --compact       Truncated tool results for overview
  mcx ${name} worktrees                     List mcx-created worktrees
  mcx ${name} worktrees --prune             Remove orphaned worktrees + merged branches

Spawn options:
${
  agentOverride
    ? ""
    : `  --agent, -a <name>         ACP agent: ${agentList} (or any command)
`
}  --task, -t "description"    Task prompt
  --worktree, -w [name]       Run in a new git worktree (auto-generates name if omitted)
  --json                      Output raw JSON (for scripting/orchestration)
  --wait                      Block until agent produces a result
  --model, -m <name>          Model to use (default: provider default)
  --allow <tools...>          Pre-approved tool patterns
  --cwd <path>                Working directory
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Send options:
  --wait                      Block until agent produces a result

Wait options:
  --after <seq>               Sequence cursor for race-free polling
  --timeout, -t <ms>          Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).${
    agentOverride
      ? ""
      : `

Available agents: ${agentList}
Use --agent with any command name for unlisted agents.`
  }`);
}
