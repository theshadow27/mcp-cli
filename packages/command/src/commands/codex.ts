/**
 * `mcx codex` commands — manage Codex sessions via the _codex virtual server.
 *
 * Mirrors `mcx claude` but routes to `codex_*` tools on the `_codex` server.
 * No resume or headed subcommands (Codex threads are ephemeral).
 * Worktree support: spawn with --worktree for isolated git worktrees, cleanup on bye.
 */

import { existsSync } from "node:fs";
import {
  PROMPT_IPC_TIMEOUT_MS,
  buildHookEnv,
  hasWorktreeHooks,
  ipcCall,
  readWorktreeConfig,
  resolveModelName,
  resolveWorktreePath,
} from "@mcp-cli/core";
import type { AgentSessionInfo } from "@mcp-cli/core";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";

import {
  type SharedSessionDeps,
  cleanupWorktree,
  parseByeResult,
  parseLogArgs,
  parseWaitArgs,
  resolveSessionId,
} from "./claude";
import { colorState, extractContentSummary, formatSessionShort } from "./session-display";

// ── Constants ──

/** Tool name prefix for the Codex provider. */
const P = "codex";

// ── Dependency injection ──

/** Codex deps use only the shared session fields — no claude-specific helpers. */
export type CodexDeps = SharedSessionDeps;

const defaultDeps: CodexDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "codex_prompt" && args.wait) || tool === "codex_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: "_codex", tool, arguments: args }, { timeoutMs });
  },
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
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

export async function cmdCodex(args: string[], deps?: Partial<CodexDeps>): Promise<void> {
  const d: CodexDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printCodexUsage();
    return;
  }

  switch (sub) {
    case "spawn":
      await codexSpawn(args.slice(1), d);
      break;
    case "ls":
    case "list":
      await codexList(args.slice(1), d);
      break;
    case "send":
      await codexSend(args.slice(1), d);
      break;
    case "bye":
    case "quit":
      await codexBye(args.slice(1), d);
      break;
    case "interrupt":
      await codexInterrupt(args.slice(1), d);
      break;
    case "log":
      await codexLog(args.slice(1), d);
      break;
    case "wait":
      await codexWait(args.slice(1), d);
      break;
    default:
      d.printError(
        `Unknown codex subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", or "wait".`,
      );
      d.exit(1);
  }
}

// ── Spawn ──

interface CodexSpawnArgs {
  task: string | undefined;
  worktree: string | undefined;
  allow: string[];
  cwd: string | undefined;
  timeout: number | undefined;
  model: string | undefined;
  wait: boolean;
  json: boolean;
  error: string | undefined;
}

export function parseCodexSpawnArgs(args: string[]): CodexSpawnArgs {
  let task: string | undefined;
  let worktree: string | undefined;
  let cwd: string | undefined;
  let timeout: number | undefined;
  let model: string | undefined;
  let wait = false;
  let json = false;
  const allow: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--task" || arg === "-t") {
      task = args[++i];
      if (!task) error = "--task requires a value";
    } else if (arg === "--worktree" || arg === "-w") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        worktree = args[++i];
      } else {
        worktree = `codex-${Date.now().toString(36)}`;
      }
    } else if (arg === "--allow") {
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
      if (!task) task = arg;
    }
  }

  return { task, worktree, allow, cwd, timeout, model, wait, json, error };
}

async function codexSpawn(args: string[], d: CodexDeps): Promise<void> {
  const parsed = parseCodexSpawnArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.task) {
    d.printError('Usage: mcx codex spawn --task "description" [--worktree [name]] [--allow tools...]');
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = { prompt: parsed.task };
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.wait) toolArgs.wait = true;

  if (parsed.worktree) {
    const repoRoot = process.cwd();
    const wtConfig = readWorktreeConfig(repoRoot);

    if (hasWorktreeHooks(wtConfig)) {
      const worktreePath = resolveWorktreePath(repoRoot, parsed.worktree, wtConfig);
      const hookEnv = buildHookEnv({ branch: parsed.worktree, path: worktreePath, cwd: repoRoot });
      const { exitCode, stderr } = d.exec(["sh", "-c", wtConfig.setup], { env: hookEnv });
      if (exitCode !== 0) {
        d.printError(`Worktree setup hook failed: ${stderr}`);
        d.exit(1);
      }
      if (!existsSync(worktreePath)) {
        d.printError(`Worktree setup hook succeeded but directory does not exist: ${worktreePath}`);
        d.exit(1);
      }
      toolArgs.cwd = worktreePath;
      toolArgs.worktree = parsed.worktree;
      toolArgs.repoRoot = repoRoot;
      d.printError(`Created worktree via hook: ${worktreePath}`);
    } else if (wtConfig?.branchPrefix === false) {
      const worktreePath = resolveWorktreePath(repoRoot, parsed.worktree, wtConfig);
      const { exitCode, stdout } = d.exec(["git", "worktree", "add", worktreePath, "-b", parsed.worktree, "HEAD"]);
      if (exitCode !== 0) {
        d.printError(`Failed to create worktree: ${stdout}`);
        d.exit(1);
      }
      toolArgs.cwd = worktreePath;
      toolArgs.worktree = parsed.worktree;
      toolArgs.repoRoot = repoRoot;
      d.printError(`Created worktree: ${worktreePath}`);
    } else {
      toolArgs.worktree = parsed.worktree;
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
      console.error(`Codex session started: ${data.sessionId.slice(0, 8)}`);
    }
  } catch {
    // Not JSON — fall through
  }
  console.log(text);
}

// ── List ──

async function codexList(args: string[], d: CodexDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
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

  if (sessions.length === 0) {
    console.error("No active Codex sessions.");
    return;
  }

  if (short) {
    for (const s of sessions) {
      console.log(formatSessionShort(s));
    }
    return;
  }

  // Table output
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (const s of sessions) {
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = s.cost != null && s.cost > 0 ? `$${s.cost.toFixed(4)}`.padEnd(8) : "N/A".padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const cwd = s.cwd ?? "—";
    console.log(`${c.cyan}${id}${c.reset}   ${state} ${model} ${cost} ${tokens} ${c.dim}${cwd}${c.reset}`);
  }
}

// ── Send ──

async function codexSend(args: string[], d: CodexDeps): Promise<void> {
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
    d.printError("Usage: mcx codex send [--wait] <session-id> <message>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const toolArgs: Record<string, unknown> = { sessionId, prompt: message };
  if (wait) toolArgs.wait = true;

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  console.log(formatToolResult(result));
}

// ── Bye ──

async function codexBye(args: string[], d: CodexDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx codex bye <session-id>");
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

async function codexInterrupt(args: string[], d: CodexDeps): Promise<void> {
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError("Usage: mcx codex interrupt <session-id>");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_interrupt`, { sessionId });
  console.log(formatToolResult(result));
}

// ── Log ──

async function codexLog(args: string[], d: CodexDeps): Promise<void> {
  const parsed = parseLogArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.sessionPrefix) {
    d.printError("Usage: mcx codex log <session-id> [--last N]");
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

async function codexWait(args: string[], d: CodexDeps): Promise<void> {
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

function printCodexUsage(): void {
  console.log(`mcx codex — manage Codex sessions

Usage:
  mcx codex spawn --task "description"    Start a new Codex session (non-blocking)
  mcx codex spawn --task "..." --json     Machine-parseable JSON output
  mcx codex spawn "description"           Shorthand (positional task)
  mcx codex spawn -w --task "desc"        Spawn in a new git worktree
  mcx codex ls                            List active Codex sessions
  mcx codex send <session> <message>      Send follow-up prompt (non-blocking)
  mcx codex wait [session]                Block until a session event occurs
  mcx codex bye <session>                 End session and stop process
  mcx codex interrupt <session>           Interrupt the current turn
  mcx codex log <session> [--last N]      View session transcript
  mcx codex log <session> --json          Raw JSON transcript output
  mcx codex log <session> --json --jq '.' Apply jq filter to JSON output
  mcx codex log <session> --full          Full output (no truncation)

Spawn options:
  --task, -t "description"    Task prompt for Codex
  --worktree, -w [name]       Run in a new git worktree (auto-generates name if omitted)
  --json                      Output raw JSON (for scripting/orchestration)
  --wait                      Block until Codex produces a result
  --model, -m <name>          Model to use (default: provider default)
  --allow <tools...>          Pre-approved tool patterns
  --cwd <path>                Working directory for Codex
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Send options:
  --wait                      Block until Codex produces a result

Wait options:
  --after <seq>               Sequence cursor for race-free polling
  --timeout, -t <ms>          Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).
Cost is not tracked for Codex sessions (shown as N/A).`);
}
