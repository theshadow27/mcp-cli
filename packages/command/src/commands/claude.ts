/**
 * `mcx claude` commands — manage Claude Code sessions via the _claude virtual server.
 *
 * All commands route through `callTool` on the `_claude` virtual server.
 * No dedicated IPC methods — the same tools work from any MCP client.
 */

import { join } from "node:path";
import { ipcCall, resolveModelName } from "@mcp-cli/core";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJsonFlag } from "../parse";

import type { SessionInfo } from "@mcp-cli/core";

// ── Dependency injection ──

export interface ClaudeDeps {
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
  getDiffStats: (worktreePath: string) => Promise<string | null>;
  /** Run a command and return stdout + exit code. Used for git operations in `bye`. */
  exec: (cmd: string[]) => { stdout: string; exitCode: number };
}

/** IPC timeout for blocking claude_prompt calls (5 min + buffer). Other tools use default 60s. */
const PROMPT_IPC_TIMEOUT_MS = 330_000;

/**
 * Parse `git diff --shortstat` output into a compact diff summary.
 * Returns e.g. `+142/-38 (4f)` or null if no changes / parse failure.
 */
export function parseDiffShortstat(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const filesMatch = trimmed.match(/(\d+)\s+file/);
  const insertMatch = trimmed.match(/(\d+)\s+insertion/);
  const deleteMatch = trimmed.match(/(\d+)\s+deletion/);

  const files = filesMatch ? Number(filesMatch[1]) : 0;
  const insertions = insertMatch ? Number(insertMatch[1]) : 0;
  const deletions = deleteMatch ? Number(deleteMatch[1]) : 0;

  if (files === 0 && insertions === 0 && deletions === 0) return null;

  return `+${insertions}/-${deletions} (${files}f)`;
}

async function defaultGetDiffStats(worktreePath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "diff", "--shortstat"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return parseDiffShortstat(output);
  } catch {
    return null;
  }
}

const defaultDeps: ClaudeDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "claude_prompt" && args.wait) || tool === "claude_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: "_claude", tool, arguments: args }, { timeoutMs });
  },
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
  getDiffStats: defaultGetDiffStats,
  exec: (cmd) => {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { stdout: result.stdout.toString().trim(), exitCode: result.exitCode };
  },
};

// ── Entry point ──

export async function cmdClaude(args: string[], deps?: Partial<ClaudeDeps>): Promise<void> {
  const d: ClaudeDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printClaudeUsage();
    return;
  }

  switch (sub) {
    case "spawn":
      await claudeSpawn(args.slice(1), d);
      break;
    case "ls":
    case "list":
      await claudeList(args.slice(1), d);
      break;
    case "send":
      await claudeSend(args.slice(1), d);
      break;
    case "bye":
    case "quit":
      await claudeBye(args.slice(1), d);
      break;
    case "interrupt":
      await claudeInterrupt(args.slice(1), d);
      break;
    case "log":
      await claudeLog(args.slice(1), d);
      break;
    case "wait":
      await claudeWait(args.slice(1), d);
      break;
    default:
      d.printError(
        `Unknown claude subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", or "wait".`,
      );
      d.exit(1);
  }
}

// ── Subcommands ──

// Re-export for tests
export { MODEL_SHORTNAMES, resolveModelName } from "@mcp-cli/core";

export interface SpawnArgs {
  task: string | undefined;
  worktree: string | undefined;
  resume: string | undefined;
  allow: string[];
  cwd: string | undefined;
  timeout: number | undefined;
  model: string | undefined;
  wait: boolean;
  error: string | undefined;
}

export function parseSpawnArgs(args: string[]): SpawnArgs {
  let task: string | undefined;
  let worktree: string | undefined;
  let resume: string | undefined;
  let cwd: string | undefined;
  let timeout: number | undefined;
  let model: string | undefined;
  let wait = false;
  const allow: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--task" || arg === "-t") {
      task = args[++i];
      if (!task) error = "--task requires a value";
    } else if (arg === "--worktree" || arg === "-w") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        worktree = next;
        i++;
      } else {
        // Auto-generate worktree name
        worktree = `claude-${Date.now().toString(36)}`;
      }
    } else if (arg === "--resume") {
      resume = args[++i];
      if (!resume) error = "--resume requires a session ID";
    } else if (arg === "--allow") {
      // Collect all following non-flag args as tool patterns
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        allow.push(args[++i]);
      }
      if (allow.length === 0) error = "--allow requires at least one tool pattern";
    } else if (arg === "--cwd") {
      cwd = args[++i];
      if (!cwd) error = "--cwd requires a path";
    } else if (arg === "--timeout") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (arg === "--model" || arg === "-m") {
      const val = args[++i];
      if (!val) {
        error = "--model requires a value";
      } else {
        model = resolveModelName(val);
      }
    } else if (arg === "--wait") {
      wait = true;
    } else if (!arg.startsWith("-")) {
      // Positional arg treated as task if no --task provided
      if (!task) task = arg;
    }
  }

  return { task, worktree, resume, allow, cwd, timeout, model, wait, error };
}

async function claudeSpawn(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseSpawnArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.task && !parsed.resume) {
    d.printError('Usage: mcx claude spawn --task "description" [--worktree [name]] [--allow tools...]');
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {
    prompt: parsed.task ?? "Continue from where you left off.",
  };
  if (parsed.resume) toolArgs.sessionId = parsed.resume;
  if (parsed.worktree) toolArgs.worktree = parsed.worktree;
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.wait) toolArgs.wait = true;

  const result = await d.callTool("claude_prompt", toolArgs);
  console.log(formatToolResult(result));
}

async function claudeList(args: string[], d: ClaudeDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const result = await d.callTool("claude_session_list", {});
  const text = formatToolResult(result);

  if (json) {
    console.log(text);
    return;
  }

  let sessions: SessionInfo[];
  try {
    sessions = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  if (sessions.length === 0) {
    console.error("No active sessions.");
    return;
  }

  // Gather diff stats for worktree sessions in parallel
  const diffStats = await Promise.all(
    sessions.map((s) => (s.worktree ? d.getDiffStats(s.worktree) : Promise.resolve(null))),
  );

  const hasAnyDiff = diffStats.some((stat) => stat !== null);

  // Table output
  const diffHeader = hasAnyDiff ? ` ${"DIFF".padEnd(16)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${diffHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = s.cost > 0 ? `$${s.cost.toFixed(4)}`.padEnd(8) : "—".padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const diff = hasAnyDiff ? ` ${(diffStats[i] ?? "—").padEnd(16)}` : "";
    const cwd = s.cwd ?? "—";
    console.log(`${c.cyan}${id}${c.reset}   ${state} ${model} ${cost} ${tokens}${diff} ${c.dim}${cwd}${c.reset}`);
  }
}

async function claudeSend(args: string[], d: ClaudeDeps): Promise<void> {
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
    d.printError("Usage: mcx claude send [--wait] <session-id> <message>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const toolArgs: Record<string, unknown> = { sessionId, prompt: message };
  if (wait) toolArgs.wait = true;

  const result = await d.callTool("claude_prompt", toolArgs);
  console.log(formatToolResult(result));
}

async function claudeBye(args: string[], d: ClaudeDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx claude bye <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const result = await d.callTool("claude_bye", { sessionId });

  // Extract worktree info from bye response
  const byeResult = parseByeResult(result);
  console.log(formatToolResult(result));

  if (byeResult.worktree && byeResult.cwd) {
    cleanupWorktree(byeResult.worktree, byeResult.cwd, d);
  }
}

interface ByeResult {
  worktree: string | null;
  cwd: string | null;
}

function parseByeResult(result: unknown): ByeResult {
  const r = result as { content?: Array<{ text?: string }> };
  const text = r?.content?.[0]?.text;
  if (!text) return { worktree: null, cwd: null };
  try {
    return JSON.parse(text) as ByeResult;
  } catch {
    return { worktree: null, cwd: null };
  }
}

/** Clean up a worktree after session ends: remove if clean, warn if dirty. */
function cleanupWorktree(worktree: string, cwd: string, d: ClaudeDeps): void {
  const expectedParent = join(cwd, ".claude", "worktrees");
  const worktreePath = join(expectedParent, worktree);

  // Guard against path traversal (worktree name comes from daemon response)
  if (!worktreePath.startsWith(`${expectedParent}/`)) return;

  // Check for uncommitted changes in the worktree
  const { stdout: status, exitCode: statusExit } = d.exec(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (statusExit !== 0) return; // worktree gone, not a git repo, or git unavailable

  if (status === "") {
    // Clean — remove the worktree
    const { exitCode: removeExit } = d.exec(["git", "-C", cwd, "worktree", "remove", worktreePath]);
    if (removeExit === 0) {
      d.printError(`Removed worktree: ${worktreePath}`);
    } else {
      d.printError(`Failed to remove worktree: ${worktreePath}`);
    }
  } else {
    // Dirty — warn the user
    const lines = status.split("\n").filter((l) => l !== "");
    const modified = lines.filter((l) => l[0] === "M" || l[1] === "M").length;
    const untracked = lines.filter((l) => l.startsWith("??")).length;

    const parts: string[] = [];
    if (modified > 0) parts.push(`${modified} modified`);
    if (untracked > 0) parts.push(`${untracked} untracked`);
    const other = lines.length - modified - untracked;
    if (other > 0) parts.push(`${other} other`);

    d.printError("Warning: worktree has uncommitted changes, not removing:");
    d.printError(`  ${worktreePath}`);
    d.printError(`  ${parts.join(", ")}`);
  }
}

async function claudeInterrupt(args: string[], d: ClaudeDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx claude interrupt <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const result = await d.callTool("claude_interrupt", { sessionId });
  console.log(formatToolResult(result));
}

export interface LogArgs {
  sessionPrefix: string | undefined;
  last: number;
  json: boolean;
  full: boolean;
  error: string | undefined;
}

export function parseLogArgs(args: string[]): LogArgs {
  const { json, rest: r1 } = extractJsonFlag(args);
  const { full, rest: r2 } = extractFullFlag(r1);

  let sessionPrefix: string | undefined;
  let last = 20;
  let error: string | undefined;

  for (let i = 0; i < r2.length; i++) {
    const arg = r2[i];
    if (arg === "--last" || arg === "-n") {
      const val = r2[++i];
      if (!val) {
        error = "--last requires a number";
      } else {
        last = Number(val);
        if (Number.isNaN(last)) error = "--last must be a number";
      }
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  return { sessionPrefix, last, json, full, error };
}

/** Extract a readable summary from a Claude API content field (string or content block array). */
export function extractContentSummary(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push(`[tool_use: ${b.name}]`);
      } else if (b.type === "tool_result") {
        const rc = b.content;
        if (typeof rc === "string") {
          parts.push(rc);
        } else {
          parts.push("[tool_result]");
        }
      }
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

async function claudeLog(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseLogArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.sessionPrefix) {
    d.printError("Usage: mcx claude log <session-id> [--last N]");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(parsed.sessionPrefix, d);
  const result = await d.callTool("claude_transcript", { sessionId, limit: parsed.last });
  const text = formatToolResult(result);

  if (parsed.json) {
    console.log(text);
    return;
  }

  let entries: Array<{ timestamp: number; direction: string; message: { type: string; [k: string]: unknown } }>;
  try {
    entries = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  const truncate = (s: string) => (parsed.full || s.length <= 200 ? s : `${s.slice(0, 200)}…`);

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const dir = entry.direction === "outbound" ? `${c.green}→${c.reset}` : `${c.cyan}←${c.reset}`;
    const type = entry.message.type ?? "unknown";
    console.log(`${c.dim}${time}${c.reset} ${dir} ${c.bold}${type}${c.reset}`);

    // Show content for user/assistant messages
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

export interface WaitArgs {
  sessionPrefix: string | undefined;
  timeout: number | undefined;
  error: string | undefined;
}

export function parseWaitArgs(args: string[]): WaitArgs {
  let sessionPrefix: string | undefined;
  let timeout: number | undefined;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout" || arg === "-t") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  return { sessionPrefix, timeout, error };
}

async function claudeWait(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseWaitArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {};

  if (parsed.sessionPrefix) {
    const sessionId = await resolveSessionId(parsed.sessionPrefix, d);
    toolArgs.sessionId = sessionId;
  }
  if (parsed.timeout) {
    toolArgs.timeout = parsed.timeout;
  }

  const result = await d.callTool("claude_wait", toolArgs);
  console.log(formatToolResult(result));
}

// ── Helpers ──

export async function resolveSessionId(prefix: string, d: ClaudeDeps): Promise<string> {
  const result = await d.callTool("claude_session_list", {});
  const text = formatToolResult(result);
  let sessions: SessionInfo[];
  try {
    sessions = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse session list");
  }

  const matches = sessions.filter((s) => s.sessionId.startsWith(prefix));

  if (matches.length === 0) {
    d.printError(`No session matching "${prefix}"`);
    d.exit(1);
  }

  if (matches.length > 1) {
    d.printError(`Ambiguous session prefix "${prefix}" — matches ${matches.length} sessions`);
    d.exit(1);
  }

  return matches[0].sessionId;
}

function colorState(state: string): string {
  const padded = state.padEnd(12);
  switch (state) {
    case "active":
      return `${c.green}${padded}${c.reset}`;
    case "connecting":
    case "init":
      return `${c.yellow}${padded}${c.reset}`;
    case "waiting_permission":
      return `${c.red}${padded}${c.reset}`;
    case "disconnected":
      return `${c.red}${padded}${c.reset}`;
    case "ended":
      return `${c.dim}${padded}${c.reset}`;
    default:
      return padded;
  }
}

// ── Usage ──

function printClaudeUsage(): void {
  console.log(`mcx claude — manage Claude Code sessions

Usage:
  mcx claude spawn --task "description"    Start a new Claude session (non-blocking)
  mcx claude spawn "description"           Shorthand (positional task)
  mcx claude ls                            List active sessions
  mcx claude send <session> <message>      Send follow-up prompt (non-blocking)
  mcx claude wait [session]                Block until a session event occurs
  mcx claude bye <session>                 End session and stop process
  mcx claude interrupt <session>           Interrupt the current turn
  mcx claude log <session> [--last N]      View session transcript
  mcx claude log <session> --json          Raw JSON transcript output
  mcx claude log <session> --full          Full output (no truncation)

Spawn options:
  --task, -t "description"    Task prompt for Claude
  --wait                      Block until Claude produces a result
  --model, -m <name>          Model to use: opus, sonnet, haiku, or full ID (default: opus)
  --worktree, -w [name]       Git worktree isolation (auto-generates name if omitted)
  --resume <id>               Resume a previous session
  --allow <tools...>          Pre-approved tool patterns (default: Read Glob Grep Write Edit)
  --cwd <path>                Working directory for Claude
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Send options:
  --wait                      Block until Claude produces a result

Wait options:
  --timeout, -t <ms>          Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).`);
}
