/**
 * `mcx opencode` commands — manage OpenCode sessions via the _opencode virtual server.
 *
 * Mirrors `mcx codex` but adds a `--provider` flag for selecting the LLM provider
 * backend (anthropic, openai, google, xai, bedrock, etc.) and displays cost in USD.
 */

import { OPENCODE_SERVER_NAME, PROMPT_IPC_TIMEOUT_MS, WorktreeError, createWorktree } from "@mcp-cli/core";
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

/** Tool name prefix for the OpenCode provider. */
const P = "opencode";

// ── Dependency injection ──

/** OpenCode deps extend shared deps with PR/repo helpers for feature parity. */
export interface OpencodeDeps extends SharedSessionDeps {
  getStaleDaemonWarning: () => string | null;
  getGitRoot: () => string | null;
  getPrStatus: (worktreePath: string) => Promise<PrStatus | null>;
}

const defaultDeps: OpencodeDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "opencode_prompt" && args.wait) || tool === "opencode_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: OPENCODE_SERVER_NAME, tool, arguments: args }, { timeoutMs });
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

export async function cmdOpencode(args: string[], deps?: Partial<OpencodeDeps>): Promise<void> {
  const d: OpencodeDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printOpencodeUsage();
    return;
  }

  const staleWarning = d.getStaleDaemonWarning();
  if (staleWarning) {
    d.printError(staleWarning);
    d.exit(1);
  }

  switch (sub) {
    case "spawn":
      await opencodeSpawn(args.slice(1), d);
      break;
    case "ls":
    case "list":
      await opencodeList(args.slice(1), d);
      break;
    case "send":
      await opencodeSend(args.slice(1), d);
      break;
    case "bye":
    case "quit":
      await opencodeBye(args.slice(1), d);
      break;
    case "interrupt":
      await opencodeInterrupt(args.slice(1), d);
      break;
    case "log":
      await opencodeLog(args.slice(1), d);
      break;
    case "wait":
      await opencodeWait(args.slice(1), d);
      break;
    case "worktrees":
    case "wt":
      await worktreesCommand(args.slice(1), d);
      break;
    default:
      d.printError(
        `Unknown opencode subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", "wait", or "worktrees".`,
      );
      d.exit(1);
  }
}

// ── Spawn ──

/** OpenCode spawn args extend the shared set with --json, --worktree, and --provider flags. */
export interface OpencodeSpawnArgs extends SharedSpawnArgs {
  json: boolean;
  worktree: string | undefined;
  provider: string | undefined;
}

export function parseOpencodeSpawnArgs(args: string[]): OpencodeSpawnArgs {
  let json = false;
  let worktree: string | undefined;
  let provider: string | undefined;
  let extraError: string | undefined;

  const shared = parseSharedSpawnArgs(args, (arg, allArgs, i) => {
    if (arg === "--json") {
      json = true;
      return 0;
    }
    if (arg === "--worktree" || arg === "-w") {
      const next = allArgs[i + 1];
      if (next && !next.startsWith("-")) {
        worktree = allArgs[i + 1];
        return 1;
      }
      worktree = `opencode-${Date.now().toString(36)}`;
      return 0;
    }
    if (arg === "--provider" || arg === "-p") {
      const val = allArgs[i + 1];
      if (!val || val.startsWith("-")) {
        extraError = "--provider requires a value (e.g. anthropic, openai, google, xai, bedrock)";
        return 0;
      }
      provider = val;
      return 1;
    }
    return undefined;
  });
  return { ...shared, error: shared.error ?? extraError, json, worktree, provider };
}

async function opencodeSpawn(args: string[], d: OpencodeDeps): Promise<void> {
  const parsed = parseOpencodeSpawnArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.task) {
    d.printError(
      'Usage: mcx opencode spawn --task "description" [--provider name] [--worktree [name]] [--allow tools...]',
    );
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = { prompt: parsed.task };
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.provider) toolArgs.provider = parsed.provider;
  if (parsed.wait) toolArgs.wait = true;

  if (parsed.worktree) {
    try {
      const result = createWorktree({ name: parsed.worktree, repoRoot: process.cwd(), branchPrefix: "opencode/" }, d);
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

  // Human-friendly: extract sessionId from JSON result when possible
  try {
    const data = JSON.parse(text) as { sessionId?: string };
    if (data.sessionId) {
      console.error(`OpenCode session started: ${data.sessionId.slice(0, 8)}`);
    }
  } catch {
    // Not JSON — fall through
  }
  console.log(text);
}

// ── List ──

async function opencodeList(args: string[], d: OpencodeDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr");
  const showAll = args.includes("--all") || args.includes("-a");

  const result = await d.callTool(`${P}_session_list`, {});
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
    console.error("No active OpenCode sessions.");
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
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${prHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = formatCost(s.cost, s.tokens).padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = s.cwd ?? "—";
    console.log(`${c.cyan}${id}${c.reset}   ${state} ${model} ${cost} ${tokens}${pr} ${c.dim}${cwd}${c.reset}`);
  }
}

function formatPrStatus(pr: PrStatus | null): string {
  if (!pr) return "—";
  return `#${pr.number} ${pr.state}`;
}

// ── Send ──

async function opencodeSend(args: string[], d: OpencodeDeps): Promise<void> {
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
    d.printError("Usage: mcx opencode send [--wait] <session-id> <message>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const toolArgs: Record<string, unknown> = { sessionId, prompt: message };
  if (wait) toolArgs.wait = true;

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  console.log(formatToolResult(result));
}

// ── Bye ──

async function opencodeBye(args: string[], d: OpencodeDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx opencode bye <session-id>");
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

async function opencodeInterrupt(args: string[], d: OpencodeDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx opencode interrupt <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_interrupt`, { sessionId });
  console.log(formatToolResult(result));
}

// ── Log ──

async function opencodeLog(args: string[], d: OpencodeDeps): Promise<void> {
  const parsed = parseLogArgs(args);
  const compact = args.includes("--compact");

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.sessionPrefix) {
    d.printError("Usage: mcx opencode log <session-id> [--last N] [--compact]");
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

async function opencodeWait(args: string[], d: OpencodeDeps): Promise<void> {
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
  const cost = evt.cost != null && evt.cost > 0 ? `$${evt.cost.toFixed(4)}` : "—";
  const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
  const preview = evt.result ? evt.result.slice(0, 100) : "";
  console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
}

// ── Usage ──

function printOpencodeUsage(): void {
  console.log(`mcx opencode — manage OpenCode sessions

Usage:
  mcx opencode spawn --task "description"    Start a new OpenCode session (non-blocking)
  mcx opencode spawn --task "..." --json     Machine-parseable JSON output
  mcx opencode spawn "description"           Shorthand (positional task)
  mcx opencode spawn -w --task "desc"        Spawn in a new git worktree
  mcx opencode ls                            List active OpenCode sessions (current repo)
  mcx opencode ls --all                      List all OpenCode sessions (all repos)
  mcx opencode ls --pr                       Show PR status for worktree sessions
  mcx opencode send <session> <message>      Send follow-up prompt (non-blocking)
  mcx opencode wait [session]                Block until a session event occurs
  mcx opencode bye <session>                 End session and stop process
  mcx opencode interrupt <session>           Interrupt the current turn
  mcx opencode log <session> [--last N]      View session transcript
  mcx opencode log <session> --json          Raw JSON transcript output
  mcx opencode log <session> --json --jq '.' Apply jq filter to JSON output
  mcx opencode log <session> --full          Full output (no truncation)
  mcx opencode log <session> --compact       Truncated tool results for overview
  mcx opencode worktrees                     List mcx-created worktrees
  mcx opencode worktrees --prune             Remove orphaned worktrees + merged branches

Spawn options:
  --task, -t "description"    Task prompt for OpenCode
  --provider, -p <name>       LLM provider backend (anthropic, openai, google, xai, bedrock)
  --worktree, -w [name]       Run in a new git worktree (auto-generates name if omitted)
  --json                      Output raw JSON (for scripting/orchestration)
  --wait                      Block until OpenCode produces a result
  --model, -m <name>          Model to use (e.g. grok-3, gemini-2.5-pro, claude-sonnet-4-6)
  --allow <tools...>          Pre-approved tool patterns
  --cwd <path>                Working directory for OpenCode
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Send options:
  --wait                      Block until OpenCode produces a result

Wait options:
  --after <seq>               Sequence cursor for race-free polling
  --timeout, -t <ms>          Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).
OpenCode tracks cost in USD and reports reasoning tokens.
Cost is estimated from token counts when not reported by the provider (shown as ~$X.XXXX).`);
}
