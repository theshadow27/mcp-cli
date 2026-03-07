/**
 * `mcx claude` commands — manage Claude Code sessions via the _claude virtual server.
 *
 * All commands route through `callTool` on the `_claude` virtual server.
 * No dedicated IPC methods — the same tools work from any MCP client.
 */

import { ipcCall } from "@mcp-cli/core";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractJsonFlag } from "../parse";

// ── Types ──

interface SessionInfo {
  sessionId: string;
  state: string;
  model: string | null;
  cwd: string | null;
  cost: number;
  tokens: number;
  numTurns: number;
  pendingPermissions: number;
}

// ── Dependency injection ──

export interface ClaudeDeps {
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: ClaudeDeps = {
  callTool: (tool, args) => ipcCall("callTool", { server: "_claude", tool, arguments: args }),
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
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
    case "kill":
      await claudeKill(args.slice(1), d);
      break;
    case "log":
      await claudeLog(args.slice(1), d);
      break;
    default:
      d.printError(`Unknown claude subcommand: ${sub}. Use "spawn", "ls", "send", "kill", or "log".`);
      d.exit(1);
  }
}

// ── Subcommands ──

export interface SpawnArgs {
  task: string | undefined;
  worktree: string | undefined;
  resume: string | undefined;
  allow: string[];
  cwd: string | undefined;
  timeout: number | undefined;
  error: string | undefined;
}

export function parseSpawnArgs(args: string[]): SpawnArgs {
  let task: string | undefined;
  let worktree: string | undefined;
  let resume: string | undefined;
  let cwd: string | undefined;
  let timeout: number | undefined;
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
    } else if (!arg.startsWith("-")) {
      // Positional arg treated as task if no --task provided
      if (!task) task = arg;
    }
  }

  return { task, worktree, resume, allow, cwd, timeout, error };
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

  // Table output
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (const s of sessions) {
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = s.cost > 0 ? `$${s.cost.toFixed(4)}`.padEnd(8) : "—".padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const cwd = s.cwd ?? "—";
    console.log(`${c.cyan}${id}${c.reset}   ${state} ${model} ${cost} ${tokens} ${c.dim}${cwd}${c.reset}`);
  }
}

async function claudeSend(args: string[], d: ClaudeDeps): Promise<void> {
  const sessionPrefix = args[0];
  const message = args.slice(1).join(" ").trim();

  if (!sessionPrefix || !message) {
    d.printError("Usage: mcx claude send <session-id> <message>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const result = await d.callTool("claude_prompt", { sessionId, prompt: message });
  console.log(formatToolResult(result));
}

async function claudeKill(args: string[], d: ClaudeDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx claude kill <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const result = await d.callTool("claude_interrupt", { sessionId });
  console.log(formatToolResult(result));
}

export interface LogArgs {
  sessionPrefix: string | undefined;
  last: number;
  error: string | undefined;
}

export function parseLogArgs(args: string[]): LogArgs {
  let sessionPrefix: string | undefined;
  let last = 20;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--last" || arg === "-n") {
      const val = args[++i];
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

  return { sessionPrefix, last, error };
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

  let entries: Array<{ timestamp: number; direction: string; message: { type: string; [k: string]: unknown } }>;
  try {
    entries = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const dir = entry.direction === "outbound" ? `${c.green}→${c.reset}` : `${c.cyan}←${c.reset}`;
    const type = entry.message.type ?? "unknown";
    console.log(`${c.dim}${time}${c.reset} ${dir} ${c.bold}${type}${c.reset}`);

    // Show content for user/assistant messages
    if (type === "user" && entry.message.message) {
      const msg = entry.message.message as { content?: string };
      if (msg.content) {
        console.log(`  ${msg.content}`);
      }
    } else if (type === "assistant" && entry.message.message) {
      const msg = entry.message.message as { content?: string };
      if (msg.content) {
        const preview = msg.content.length > 200 ? `${msg.content.slice(0, 200)}…` : msg.content;
        console.log(`  ${preview}`);
      }
    } else if (type === "result") {
      const res = entry.message as { result?: string };
      if (res.result) {
        const preview = res.result.length > 200 ? `${res.result.slice(0, 200)}…` : res.result;
        console.log(`  ${c.dim}${preview}${c.reset}`);
      }
    }
  }
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
  mcx claude spawn --task "description"    Start a new Claude session
  mcx claude spawn "description"           Shorthand (positional task)
  mcx claude ls                            List active sessions
  mcx claude send <session> <message>      Send follow-up prompt
  mcx claude kill <session>                Interrupt a session
  mcx claude log <session> [--last N]      View session transcript

Spawn options:
  --task, -t "description"    Task prompt for Claude
  --worktree, -w [name]       Git worktree isolation (auto-generates name if omitted)
  --resume <id>               Resume a previous session
  --allow <tools...>          Pre-approved tool patterns (e.g. Read Glob "Bash(git *)")
  --cwd <path>                Working directory for Claude
  --timeout <ms>              Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).`);
}
