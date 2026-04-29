/**
 * `mcx claude` commands — manage Claude Code sessions via the _claude virtual server.
 *
 * All commands route through `callTool` on the `_claude` virtual server.
 * No dedicated IPC methods — the same tools work from any MCP client.
 */

import { dirname, join, resolve } from "node:path";
import { CLAUDE_SUB_ALIASES, formatHelp, getHelp, hasHelpFlag } from "../help";
import "../help-claude";
import {
  CLAUDE_SERVER_NAME,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PROMPT_IPC_TIMEOUT_MS,
  WorktreeError,
  cleanupWorktree,
  commitTransition,
  createWorktree,
  detectScope,
  getDefaultBranch,
  listMcxWorktrees,
  loadManifest,
  parseWorktreeList,
  readWorktreeConfig,
  resolveModelName,
  resolveWorktreePath,
  updatePatchedClaude,
} from "@mcp-cli/core";
import { getStaleDaemonWarning, ipcCall } from "../daemon-lifecycle";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, printInfo as defaultPrintInfo, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";
import {
  colorState,
  extractContentSummary,
  formatAge,
  formatLifecycleLine,
  formatSessionShort,
} from "./session-display";
import type { SharedSpawnArgs } from "./spawn-args";
import { parseSharedSpawnArgs } from "./spawn-args";
import { ttyOpen } from "./tty";

import type { MailMessage, QuotaStatusResult, SessionInfo, WorkItem } from "@mcp-cli/core";

// ── Dependency injection ──

export interface PrStatus {
  number: number;
  state: string;
}

/** Shared dependency interface for session-based commands (claude, codex). */
export interface SharedSessionDeps {
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  printError: (msg: string) => void;
  printInfo: (msg: string) => void;
  exit: (code: number) => never;
  /** Run a command and return stdout + stderr + exit code. Used for git operations in `bye`. */
  exec: (
    cmd: string[],
    opts?: { env?: Record<string, string> },
  ) => { stdout: string; stderr: string; exitCode: number };
}

export interface ClaudeDeps extends SharedSessionDeps {
  log: (...args: unknown[]) => void;
  getDiffStats: (worktreePath: string) => Promise<string | null>;
  getPrStatus: (worktreePath: string) => Promise<PrStatus | null>;
  /** Open a command in a terminal tab/window. Used for --headed spawn. */
  ttyOpen: (args: string[]) => Promise<void>;
  /** Resolve the git repo root for the current working directory. Returns null if not in a git repo. */
  getGitRoot: () => string | null;
  /** Return a warning string if the running daemon is a stale build, null otherwise. */
  getStaleDaemonWarning: () => string | null;
  /**
   * Return the oldest unread mail for `recipient`, or null. Non-consuming
   * (does not markRead). Used by `mcx claude wait --mail-to` to surface
   * mail arrival alongside session events.
   */
  pollMail: (recipient: string) => Promise<MailMessage | null>;
  /** Patcher entry point. Overridden in tests to avoid real codesign. */
  runPatchUpdate: typeof updatePatchedClaude;
}

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

export async function defaultGetPrStatus(worktreePath: string): Promise<PrStatus | null> {
  try {
    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;
    if (!branch) return null;

    const prProc = Bun.spawn(["gh", "pr", "list", "--head", branch, "--json", "number,state", "--limit", "1"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const prOutput = (await new Response(prProc.stdout).text()).trim();
    await prProc.exited;

    const prs = JSON.parse(prOutput) as Array<{ number: number; state: string }>;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const pr = prs[0];
    return { number: pr.number, state: pr.state.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Resolve the git repo root for the current working directory.
 * Uses --git-common-dir to resolve to the main repo root, not a worktree.
 * Returns null if not inside a git repo.
 */
function getGitRoot(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (result.exitCode !== 0) return null;
    const commonDir = result.stdout.toString().trim();
    if (!commonDir) return null;
    // --git-common-dir returns the .git dir (e.g. /repo/.git or /repo/.git/worktrees/foo/../../)
    // Resolve to the parent to get the repo root
    const resolved = resolve(commonDir);
    // If it ends with .git, take the parent; otherwise it's already the repo root
    return resolved.endsWith(".git") ? dirname(resolved) : resolved;
  } catch {
    return null;
  }
}

export const defaultDeps: ClaudeDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "claude_prompt" && args.wait) || tool === "claude_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: CLAUDE_SERVER_NAME, tool, arguments: args }, { timeoutMs });
  },
  log: console.log,
  printError: defaultPrintError,
  printInfo: defaultPrintInfo,
  exit: (code) => process.exit(code),
  getDiffStats: defaultGetDiffStats,
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
  ttyOpen: (args) => ttyOpen(args),
  getGitRoot,
  getStaleDaemonWarning,
  pollMail: async (recipient) => {
    const result = (await ipcCall("readMail", { recipient, unreadOnly: true, limit: 1 })) as {
      messages: MailMessage[];
    };
    return result.messages[0] ?? null;
  },
  runPatchUpdate: updatePatchedClaude,
};

// ── Entry point ──

/**
 * `mcx claude` — thin alias that routes to `mcx agent claude`.
 *
 * Kept as a top-level command because orchestration workflows, memory files,
 * and CLAUDE.md all reference `mcx claude` directly.
 *
 * When `deps` are provided (testing), uses the internal dispatch to allow
 * dependency injection without going through agent.ts.
 */
export async function cmdClaude(args: string[], deps?: Partial<ClaudeDeps>): Promise<void> {
  // Show claude-branded help when invoked directly
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printClaudeUsage();
    return;
  }

  if (deps) {
    // Direct dispatch for testing with injected deps
    await cmdClaudeInternal(args, deps);
    return;
  }
  const { cmdAgent } = await import("./agent");
  await cmdAgent(["claude", ...args]);
}

async function cmdClaudeInternal(args: string[], deps?: Partial<ClaudeDeps>): Promise<void> {
  const d: ClaudeDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printClaudeUsage();
    return;
  }

  const subArgs = args.slice(1);
  if (sub !== "spawn" && hasHelpFlag(subArgs)) {
    const canonicalSub = CLAUDE_SUB_ALIASES[sub] ?? sub;
    const help = getHelp(`claude ${canonicalSub}`);
    if (help) {
      d.log(formatHelp(help));
      return;
    }
    d.log(`No detailed help available for "mcx claude ${sub}".`);
    d.log('Run "mcx claude --help" for available subcommands.');
    return;
  }

  switch (sub) {
    case "spawn":
      await claudeSpawn(subArgs, d);
      break;
    case "ls":
    case "list":
      await claudeList(subArgs, d);
      break;
    case "send":
      await claudeSend(subArgs, d);
      break;
    case "bye":
    case "quit":
      await claudeBye(subArgs, d);
      break;
    case "interrupt":
      await claudeInterrupt(subArgs, d);
      break;
    case "log":
      await claudeLog(subArgs, d);
      break;
    case "wait":
      await claudeWait(subArgs, d);
      break;
    case "resume":
      await claudeResume(subArgs, d);
      break;
    case "worktrees":
    case "wt":
      await claudeWorktrees(subArgs, d);
      break;
    case "approve":
      await claudeApprove(subArgs, d);
      break;
    case "deny":
      await claudeDeny(subArgs, d);
      break;
    case "patch-update":
      await claudePatchUpdate(subArgs, d);
      break;
    default:
      d.printError(
        `Unknown claude subcommand: ${sub}. Use "spawn", "resume", "ls", "send", "bye", "interrupt", "log", "wait", "approve", "deny", "patch-update", or "worktrees".`,
      );
      d.exit(1);
  }
}

// ── Subcommands ──

// Re-export for tests
export { MODEL_SHORTNAMES, resolveModelName } from "@mcp-cli/core";

export interface SpawnArgs extends SharedSpawnArgs {
  worktree: string | undefined;
  resume: string | undefined;
  headed: boolean;
  /** Human-readable session name. Auto-generated if omitted. */
  name: string | undefined;
  /** Work item ID for transition log bookkeeping. When set, spawn writes a null→initial entry. */
  workItemId: string | undefined;
}

export function parseSpawnArgs(args: string[]): SpawnArgs {
  let worktree: string | undefined;
  let resume: string | undefined;
  let headed = false;
  let name: string | undefined;
  let workItemId: string | undefined;
  let extraError: string | undefined;

  const shared = parseSharedSpawnArgs(args, (arg, allArgs, i) => {
    if (arg === "--headed") {
      headed = true;
      return 0;
    }
    if (arg === "--worktree" || arg === "-w") {
      const next = allArgs[i + 1];
      if (next && !next.startsWith("-")) {
        worktree = next;
        return 1;
      }
      // Auto-generate worktree name — use random UUID to avoid collisions
      // when multiple spawns run in the same millisecond (#1836)
      worktree = `claude-${crypto.randomUUID().slice(0, 8)}`;
      return 0;
    }
    if (arg === "--resume") {
      resume = allArgs[i + 1];
      if (!resume) extraError = "--resume requires a session ID";
      return 1;
    }
    if (arg === "--name" || arg === "-n") {
      name = allArgs[i + 1];
      if (!name) extraError = "--name requires a value";
      return 1;
    }
    if (arg === "--work-item") {
      const next = allArgs[i + 1];
      if (next && !next.startsWith("-")) {
        workItemId = next;
        return 1;
      }
      extraError = "--work-item requires an id";
      return 0;
    }
    if (arg.startsWith("--work-item=")) {
      workItemId = arg.slice("--work-item=".length);
      if (!workItemId) extraError = "--work-item requires an id";
      return 0;
    }
    return undefined;
  });

  // shared.error wins: it reflects a bad shared flag; extraError covers provider-specific failures
  return { ...shared, error: shared.error ?? extraError, worktree, resume, headed, name, workItemId };
}

/**
 * Build a shell command string for launching interactive Claude in a terminal.
 * Escapes arguments for safe shell interpolation.
 */
export function buildHeadedCommand(parsed: SpawnArgs): string {
  const parts: string[] = ["claude"];

  if (parsed.task) {
    parts.push("-p", shellQuote(parsed.task));
  }
  if (parsed.model) {
    parts.push("--model", shellQuote(parsed.model));
  }
  if (parsed.allow.length > 0) {
    parts.push("--allowedTools", ...parsed.allow.map(shellQuote));
  }

  return parts.join(" ");
}

/** Shell-quote a string (wrap in single quotes, escape internal single quotes). */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._:/@=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Write a null → manifest.initial transition entry for the given work item.
 * Called after a successful spawn so downstream phases can infer "from" from
 * the log rather than relying on the Tier-3 work_items.phase fallback (#1623).
 *
 * Best-effort: silently swallows all errors so a missing/mismatched manifest
 * or a race with a concurrent spawn never blocks the spawn itself.
 */
function tryWriteInitialTransition(workItemId: string, gitRoot: string): void {
  try {
    const loaded = loadManifest(gitRoot);
    if (!loaded) return;
    commitTransition(join(gitRoot, ".mcx", "transitions.jsonl"), {
      manifest: loaded.manifest,
      from: null,
      target: loaded.manifest.initial,
      workItemId,
      manifestPath: loaded.path,
    });
  } catch {
    // Non-fatal: spawn succeeded; the transition entry is best-effort.
  }
}

async function claudeSpawn(args: string[], d: ClaudeDeps): Promise<void> {
  if (hasHelpFlag(args)) {
    const spawnHelp = getHelp("claude spawn");
    if (spawnHelp) {
      d.log(formatHelp(spawnHelp));
    } else {
      d.log('No detailed help available for "mcx claude spawn".');
      d.log('Run "mcx claude --help" for available subcommands.');
    }
    return;
  }

  const parsed = parseSpawnArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.task && !parsed.resume) {
    d.printError('Usage: mcx claude spawn --task "description" [--worktree [name]] [--allow tools...]');
    d.printError('Run "mcx claude spawn --help" for details.');
    d.exit(1);
  }

  if (parsed.headed) {
    await claudeSpawnHeaded(parsed, d);
    return;
  }

  // Refuse to spawn against a stale daemon — sessions would land in `disconnected` (#1218).
  const staleWarning = d.getStaleDaemonWarning();
  if (staleWarning) {
    d.printError(staleWarning);
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {
    prompt: parsed.task ?? "Continue from where you left off.",
  };
  if (parsed.resume) toolArgs.sessionId = parsed.resume;
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  // Without this, sessions inherit daemon cwd instead of caller's shell (#1331).
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  else if (!parsed.worktree) toolArgs.cwd = process.cwd();
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.name) toolArgs.name = parsed.name;
  if (parsed.wait) toolArgs.wait = true;

  // Handle worktree: always pre-create via shim so cwd points to the worktree.
  // Without cwd, Claude inherits the daemon's cwd (main repo) and file
  // operations leak into the main working tree (#1109).
  let worktreeResult: { path: string } | undefined;
  if (parsed.worktree) {
    try {
      // Prefer getGitRoot() so repoRoot resolves to the main repo even when
      // invoked from a worktree or when core.bare=true is set (#1243).
      const repoRoot = d.getGitRoot() ?? process.cwd();
      const wt = createWorktree({ name: parsed.worktree, repoRoot, branchPrefix: "claude/" }, d);
      Object.assign(toolArgs, wt.toolArgs);
      worktreeResult = wt;
    } catch (e) {
      d.printError(e instanceof WorktreeError ? e.message : String(e));
      d.exit(1);
    }
  }

  try {
    const result = await d.callTool("claude_prompt", toolArgs);
    console.log(formatToolResult(result));
  } catch (e) {
    // IPC failed after worktree was created — clean up to avoid orphans (#1116)
    if (parsed.worktree && worktreeResult) {
      try {
        cleanupWorktree(parsed.worktree, worktreeResult.path, d, process.cwd());
      } catch {
        // Best-effort cleanup — don't mask the original error
      }
    }
    d.printError(String(e));
    d.exit(1);
  }

  // Write null → initial transition so downstream phases can infer "from"
  // from the log rather than the Tier-3 work_items.phase fallback (#1623).
  if (parsed.workItemId) {
    tryWriteInitialTransition(parsed.workItemId, d.getGitRoot() ?? process.cwd());
  }
}

async function claudeSpawnHeaded(parsed: SpawnArgs, d: ClaudeDeps): Promise<void> {
  if (parsed.resume) {
    d.printError("--headed and --resume are incompatible. Use headless spawn for session resume.");
    d.exit(1);
  }
  if (parsed.wait) {
    d.printError("--headed and --wait are incompatible. Headed sessions are interactive.");
    d.exit(1);
  }

  // Handle --worktree: create a git worktree and use it as cwd
  let cwd = parsed.cwd;
  if (parsed.worktree) {
    try {
      const repoRoot = d.getGitRoot() ?? process.cwd();
      const result = createWorktree({ name: parsed.worktree, repoRoot, branchPrefix: "headed/" }, d);
      cwd = result.path;
    } catch (e) {
      d.printError(e instanceof WorktreeError ? e.message : String(e));
      d.exit(1);
    }
  }

  // Build the claude command and prepend cd if cwd is set
  const command = cwd ? `cd ${shellQuote(cwd)} && ${buildHeadedCommand(parsed)}` : buildHeadedCommand(parsed);

  await d.ttyOpen([command]);

  // Write null → initial transition after the terminal opens (#1623).
  if (parsed.workItemId) {
    tryWriteInitialTransition(parsed.workItemId, d.getGitRoot() ?? process.cwd());
  }
}

// ── Resume ──

export interface ResumeArgs {
  target: string | undefined;
  /** Specific Claude CLI session ID to resume conversation history from. */
  sessionId: string | undefined;
  all: boolean;
  /** Skip conversation history restoration, use git-context prompt instead. */
  fresh: boolean;
  allow: string[];
  model: string | undefined;
  wait: boolean;
  timeout: number | undefined;
  error: string | undefined;
}

export function parseResumeArgs(args: string[]): ResumeArgs {
  let all = false;
  let fresh = false;
  let model: string | undefined;
  let wait = false;
  let timeout: number | undefined;
  let error: string | undefined;
  const allow: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--fresh") {
      fresh = true;
    } else if (arg === "--model" || arg === "-m") {
      const val = args[++i];
      if (!val) {
        error = "--model requires a value";
      } else {
        model = resolveModelName(val);
      }
    } else if (arg === "--allow") {
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        allow.push(args[++i]);
      }
      if (allow.length === 0) error = "--allow requires at least one tool pattern";
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  // First positional is worktree target, second (if any) is session ID
  const target = positionals[0];
  const sessionId = positionals[1];

  if (fresh && sessionId) {
    error = "--fresh cannot be combined with an explicit session ID";
  } else if (!all && !target) {
    error =
      "Usage: mcx claude resume <worktree> [session-id] [--fresh] [--model M] [--allow tools...]\n       mcx claude resume --all";
  }

  return { target, sessionId, all, fresh, allow, model, wait, timeout, error };
}

/** Extract issue number from branch name convention: feat/issue-N-slug, fix/issue-N-slug, etc. */
export function extractIssueNumber(branch: string): number | null {
  const match = branch.match(/issue-(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Resolve a worktree target (path or branch name) to an actual worktree path. */
export function resolveWorktree(
  target: string,
  worktrees: Array<{ path: string; branch: string | null }>,
): { path: string; branch: string | null } | null {
  // Direct path match
  for (const wt of worktrees) {
    if (wt.path === target) return wt;
  }

  // Match by worktree directory name (last path segment)
  for (const wt of worktrees) {
    const name = wt.path.split("/").pop();
    if (name === target) return wt;
  }

  // Match by branch name
  for (const wt of worktrees) {
    if (wt.branch === target) return wt;
  }

  return null;
}

/** Build a context-rich resume prompt from git state. */
export function buildResumePrompt(opts: {
  branch: string;
  issueNumber: number | null;
  gitLog: string;
  gitDiff: string;
  prInfo: string | null;
}): string {
  const lines: string[] = [];
  lines.push("You are resuming work in an existing worktree. Here is the context of what has already been done:");
  lines.push("");
  lines.push(`**Branch:** \`${opts.branch}\``);

  if (opts.issueNumber) {
    lines.push(`**Issue:** #${opts.issueNumber}`);
  }

  if (opts.prInfo) {
    lines.push(`**PR:** ${opts.prInfo}`);
  }

  if (opts.gitLog.trim()) {
    lines.push("");
    lines.push("**Commits on this branch:**");
    lines.push("```");
    lines.push(opts.gitLog.trim());
    lines.push("```");
  }

  if (opts.gitDiff.trim()) {
    lines.push("");
    lines.push("**Uncommitted changes:**");
    lines.push("```");
    lines.push(opts.gitDiff.trim());
    lines.push("```");
  }

  lines.push("");
  lines.push(
    "Review the state above and continue where the previous session left off. If there are uncommitted changes, decide whether to commit or discard them. If there's a PR, check if it needs updates. If the work appears complete, verify it (typecheck, lint, test) and wrap up.",
  );

  return lines.join("\n");
}

export async function claudeResume(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseResumeArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const cwd = process.cwd();

  // List all worktrees (single git call — listMcxWorktrees returns both filtered and full lists)
  let mcxWorktrees: ReturnType<typeof listMcxWorktrees>["worktrees"];
  let allWorktrees: ReturnType<typeof listMcxWorktrees>["allWorktrees"];
  let worktreeParent: string;
  try {
    const listed = listMcxWorktrees(cwd, d);
    mcxWorktrees = listed.worktrees;
    allWorktrees = listed.allWorktrees;
    worktreeParent = listed.worktreeBase;
  } catch (e) {
    d.printError(e instanceof WorktreeError ? e.message : String(e));
    d.exit(1);
  }

  // Get active sessions to find orphaned worktrees
  let sessionWorktrees = new Set<string>();
  try {
    const result = await d.callTool("claude_session_list", {});
    const text = formatToolResult(result);
    const sessions = JSON.parse(text) as SessionInfo[];
    sessionWorktrees = new Set(sessions.filter((s) => s.worktree).map((s) => s.worktree as string));
  } catch {
    // Daemon may not be running — all worktrees are orphaned
  }

  if (parsed.all) {
    // Resume all orphaned worktrees
    const orphaned = mcxWorktrees.filter((wt) => {
      const wtName = wt.path.slice(`${worktreeParent}/`.length);
      return !sessionWorktrees.has(wtName);
    });

    if (orphaned.length === 0) {
      d.printError("No orphaned worktrees to resume.");
      return;
    }

    d.printInfo(`Resuming ${orphaned.length} orphaned worktree${orphaned.length === 1 ? "" : "s"}...`);

    for (const wt of orphaned) {
      await resumeWorktree(wt, parsed, d);
    }
    return;
  }

  // Single worktree resume
  const target = parsed.target ?? "";
  const resolved = resolveWorktree(target, mcxWorktrees);

  if (!resolved) {
    // Also try resolving against all worktrees (not just mcx ones)
    const resolvedAll = resolveWorktree(target, allWorktrees);
    if (resolvedAll) {
      d.printError(`Worktree "${target}" exists but is not an mcx worktree (not under .claude/worktrees/).`);
    } else {
      d.printError(`No worktree matching "${target}". Use "mcx claude worktrees" to list available worktrees.`);
    }
    d.exit(1);
  }

  // Check if it already has an active session
  const wtName = resolved.path.slice(`${worktreeParent}/`.length);
  if (sessionWorktrees.has(wtName)) {
    d.printError(`Worktree "${wtName}" already has an active session. Use "mcx claude send" to interact with it.`);
    d.exit(1);
  }

  await resumeWorktree(resolved, parsed, d);
}

async function resumeWorktree(
  wt: { path: string; branch: string | null },
  parsed: ResumeArgs,
  d: ClaudeDeps,
): Promise<void> {
  const branch = wt.branch ?? "unknown";

  // Check if branch is already merged into the default branch
  const defaultBranch = getDefaultBranch(d, wt.path);
  const { stdout: mergedOutput, exitCode: mergedExit } = d.exec([
    "git",
    "-C",
    wt.path,
    "branch",
    "--merged",
    defaultBranch,
  ]);
  if (mergedExit === 0) {
    const mergedBranches = mergedOutput.split("\n").map((l) => l.trim().replace(/^\* /, ""));
    if (mergedBranches.includes(branch)) {
      d.printError(
        `Skipping "${branch}" — already merged into ${defaultBranch}. Use "mcx claude worktrees --prune" to clean up.`,
      );
      return;
    }
  }

  const toolArgs: Record<string, unknown> = { cwd: wt.path };
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.wait) toolArgs.wait = true;

  if (parsed.fresh) {
    // --fresh: use git-context prompt (legacy behavior)
    const { stdout: gitLog } = d.exec(["git", "-C", wt.path, "log", "--oneline", `main..${branch}`, "--"]);
    const { stdout: gitDiff } = d.exec(["git", "-C", wt.path, "diff", "--stat"]);

    const issueNumber = extractIssueNumber(branch);

    let prInfo: string | null = null;
    const prStatus = await d.getPrStatus(wt.path);
    if (prStatus) {
      prInfo = `#${prStatus.number} (${prStatus.state})`;
    }

    toolArgs.prompt = buildResumePrompt({ branch, issueNumber, gitLog, gitDiff, prInfo });
    console.error(`Resuming session in ${wt.path} (branch: ${branch}) [fresh — git context only]`);
  } else {
    // Default: restore conversation history via Claude CLI --resume flag
    // If a specific session ID was provided, use it; otherwise bare --resume
    // tells the CLI to pick the last session for this directory.
    toolArgs.resumeSessionId = parsed.sessionId ?? "continue";
    toolArgs.prompt =
      "Your previous conversation history has just been restored via --continue/--resume. " +
      "Please review the restored context and continue where you left off, picking up any in-progress work.";
    console.error(`Resuming session in ${wt.path} (branch: ${branch}) [restoring conversation history]`);
  }

  const result = await d.callTool("claude_prompt", toolArgs);
  console.log(formatToolResult(result));
}

/**
 * Format a quota warning banner when 5-hour utilization exceeds 80%.
 * Returns null if no warning needed.
 */
export function formatQuotaBanner(quota: QuotaStatusResult | null): string | null {
  if (!quota || !quota.fiveHour || quota.fetchedAt === 0) return null;
  const util = quota.fiveHour.utilization;
  if (util <= 80) return null;

  const reset = new Date(quota.fiveHour.resetsAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (util >= 95) {
    return `🔴 Quota CRITICAL: 5h window at ${util}% (resets ${reset}) — pause all spawning`;
  }
  return `⚠  Quota: 5h window at ${util}% (resets ${reset}) — stop spawning new sessions`;
}

async function claudeList(args: string[], d: ClaudeDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr");
  const showAll = args.includes("--all") || args.includes("-a");

  // Pass scopeRoot or repoRoot to daemon for server-side filtering unless --all
  const toolArgs: Record<string, unknown> = {};
  if (!showAll) {
    const scope = detectScope();
    if (scope) {
      toolArgs.scopeRoot = scope.root;
    } else {
      const gitRoot = d.getGitRoot();
      if (gitRoot) toolArgs.repoRoot = gitRoot;
    }
  }

  // Fetch sessions and work items in parallel
  const [result, workItems] = await Promise.all([
    d.callTool("claude_session_list", toolArgs),
    ipcCall("listWorkItems", {}, { timeoutMs: 2000 }).catch((): WorkItem[] => []),
  ]);
  const text = formatToolResult(result);

  let sessions: SessionInfo[];
  try {
    sessions = JSON.parse(text);
  } catch {
    if (json) {
      console.log(text);
    } else {
      console.log(text);
    }
    return;
  }

  // Join sessions → work items via worktree branch matching
  const sessionWorkItems = joinSessionsToWorkItems(sessions, workItems);

  if (json) {
    // Enrich session objects with work_item field
    const enriched = sessions.map((s) => ({
      ...s,
      workItem: sessionWorkItems.get(s.sessionId) ?? null,
    }));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  // Fetch quota status (non-blocking — don't fail ls if quota unavailable)
  let quotaBanner: string | null = null;
  try {
    const quota = await ipcCall("quotaStatus", undefined, { timeoutMs: 2000 });
    quotaBanner = formatQuotaBanner(quota);
  } catch {
    // Quota monitoring unavailable — continue without banner
  }

  if (sessions.length === 0) {
    if (quotaBanner) console.error(quotaBanner);
    console.error("No active sessions.");
    return;
  }

  if (short) {
    if (quotaBanner) console.error(quotaBanner);
    for (const s of sessions) {
      console.log(formatSessionShort(s));
    }
    return;
  }

  // Gather diff stats and (optionally) PR status for worktree sessions in parallel
  const [diffStats, prStatuses] = await Promise.all([
    Promise.all(sessions.map((s) => (s.worktree ? d.getDiffStats(s.worktree) : Promise.resolve(null)))),
    showPr
      ? Promise.all(sessions.map((s) => (s.worktree ? d.getPrStatus(s.worktree) : Promise.resolve(null))))
      : Promise.resolve(sessions.map(() => null)),
  ]);

  const hasAnyDiff = diffStats.some((stat) => stat !== null);
  const hasAnyPr = showPr && prStatuses.some((pr) => pr !== null);

  // Quota warning banner (stderr, before table)
  if (quotaBanner) console.error(quotaBanner);

  // Table output
  const diffHeader = hasAnyDiff ? ` ${"DIFF".padEnd(16)}` : "";
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const sessionColWidth = 20;
  const header = `${"SESSION".padEnd(sessionColWidth)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${diffHeader}${prHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.sessionId.slice(0, 8);
    const maxNameLen = sessionColWidth - id.length - 1; // 1 for leading space
    const truncatedName = s.name && s.name.length > maxNameLen ? `${s.name.slice(0, maxNameLen - 1)}…` : s.name;
    const nameLabel = truncatedName ? ` ${truncatedName}` : "";
    const sessionCol = `${id}${nameLabel}`.padEnd(sessionColWidth);
    const stateStr = s.rateLimited ? `${colorState(s.state)} ${c.red}[RATE LIMITED]${c.reset}` : colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = s.cost > 0 ? `$${s.cost.toFixed(4)}`.padEnd(8) : "—".padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const diff = hasAnyDiff ? ` ${(diffStats[i] ?? "—").padEnd(16)}` : "";
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = s.cwd ?? "—";
    const age = formatAge(s.createdAt);
    const ageSuffix = age ? ` ${c.yellow}${age}${c.reset}` : "";
    console.log(
      `${c.cyan}${id}${c.reset}${c.bold}${nameLabel}${c.reset}${" ".repeat(Math.max(1, sessionColWidth - id.length - nameLabel.length))}${stateStr} ${model} ${cost} ${tokens}${diff}${pr} ${c.dim}${cwd}${c.reset}${ageSuffix}`,
    );

    // Work item lifecycle line (indented under the session)
    const wi = sessionWorkItems.get(s.sessionId);
    if (wi) {
      console.log(`  ${formatLifecycleLine(wi)}`);
    }
  }

  const staleWarning = d.getStaleDaemonWarning();
  if (staleWarning) {
    console.error(`\n⚠ ${staleWarning}`);
  }
}

// formatSessionShort, extractContentSummary, colorState → ./session-display.ts
export {
  colorState,
  extractContentSummary,
  formatAge,
  formatLifecycleLine,
  formatSessionShort,
} from "./session-display";

function formatPrStatus(pr: PrStatus | null): string {
  if (!pr) return "—";
  return `#${pr.number} ${pr.state}`;
}

/** Get the current git branch for a worktree path. Returns null on failure. */
function getWorktreeBranch(worktreePath: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 3000,
    });
    if (result.exitCode !== 0) return null;
    const branch = result.stdout.toString().trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Build a map from session → work item by matching worktree branches to work item branches.
 * Also matches by issue number extracted from branch name (e.g. feat/issue-1142-slug → #1142).
 */
function joinSessionsToWorkItems(sessions: SessionInfo[], workItems: WorkItem[]): Map<string, WorkItem> {
  const byBranch = new Map<string, WorkItem>();
  const byIssue = new Map<number, WorkItem>();
  const byPr = new Map<number, WorkItem>();

  for (const wi of workItems) {
    if (wi.branch) byBranch.set(wi.branch, wi);
    if (wi.issueNumber != null) byIssue.set(wi.issueNumber, wi);
    if (wi.prNumber != null) byPr.set(wi.prNumber, wi);
  }

  const result = new Map<string, WorkItem>();

  for (const s of sessions) {
    if (!s.worktree) continue;
    const branch = getWorktreeBranch(s.worktree);
    if (!branch) continue;

    // Try exact branch match first
    const byBranchMatch = byBranch.get(branch);
    if (byBranchMatch) {
      result.set(s.sessionId, byBranchMatch);
      continue;
    }

    // Try extracting issue number from branch name (e.g. feat/issue-1142-slug)
    const issueMatch = branch.match(/issue-(\d+)/);
    if (issueMatch) {
      const num = Number(issueMatch[1]);
      const byIssueMatch = byIssue.get(num);
      if (byIssueMatch) {
        result.set(s.sessionId, byIssueMatch);
      }
    }
  }

  return result;
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
  const keepWorktree = args.includes("--keep") || args.includes("--keep-worktree");
  const showAll = args.includes("--all") || args.includes("-a");
  const positional = args.filter((a) => !a.startsWith("-"));
  const sessionPrefix = positional[0];

  // --all: end all sessions in scope (or all sessions if unscoped)
  if (showAll) {
    await claudeByeAll(args, d, keepWorktree);
    return;
  }

  if (!sessionPrefix) {
    d.printError('Usage: mcx claude bye <session-id> "<message>" [--keep|--keep-worktree] [--all]');
    d.exit(1);
  }

  // Remaining positional args after session ID form the closing message
  const message = positional.slice(1).join(" ").trim() || undefined;
  if (!message) {
    d.printError("Warning: no closing message provided. A message will be required in a future release.");
    d.printError('  Usage: mcx claude bye <id> "reason for ending session"');
  }

  const sessionId = await resolveSessionId(sessionPrefix, d);
  const result = await d.callTool("claude_bye", { sessionId, ...(message && { message }) });

  // Extract worktree info from bye response
  const byeResult = parseByeResult(result);
  console.log(formatToolResult(result));

  if (byeResult.worktree) {
    if (keepWorktree) {
      const wtPath = byeResult.cwd ?? resolveKeptWorktreePath(byeResult);
      d.printInfo(`Worktree preserved: ${wtPath}`);
    } else if (byeResult.cwd) {
      cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
    } else {
      // Daemon-created worktrees: cwd is null — resolve from local repo root
      const repoRoot = process.cwd();
      const wtConfig = readWorktreeConfig(repoRoot);
      const cwd = resolveWorktreePath(repoRoot, byeResult.worktree, wtConfig);
      cleanupWorktree(byeResult.worktree, cwd, d, repoRoot);
    }
  }
}

/** End all sessions in the detected scope (or all sessions if unscoped). */
async function claudeByeAll(args: string[], d: ClaudeDeps, keepWorktree: boolean): Promise<void> {
  // List sessions with scope filtering
  const toolArgs: Record<string, unknown> = {};
  const bypassScope = args.includes("--all") && !args.includes("--scoped");
  if (!bypassScope) {
    const scope = detectScope();
    if (scope) {
      toolArgs.scopeRoot = scope.root;
    }
  }

  const listResult = await d.callTool("claude_session_list", toolArgs);
  const text = formatToolResult(listResult);
  let sessions: SessionInfo[];
  try {
    sessions = JSON.parse(text);
  } catch {
    d.printError("Failed to parse session list");
    d.exit(1);
  }

  if (sessions.length === 0) {
    console.error("No sessions to end.");
    return;
  }

  d.printError(
    "Warning: --all ends sessions without individual closing messages. A message will be required in a future release.",
  );
  console.error(`Ending ${sessions.length} session${sessions.length === 1 ? "" : "s"}...`);

  for (const s of sessions) {
    try {
      const result = await d.callTool("claude_bye", { sessionId: s.sessionId, message: "Batch end (--all)" });
      const byeResult = parseByeResult(result);
      const id = s.sessionId.slice(0, 8);
      console.error(`  ${id} ended`);

      if (byeResult.worktree && !keepWorktree) {
        if (byeResult.cwd) {
          cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
        } else {
          const repoRoot = process.cwd();
          const wtConfig = readWorktreeConfig(repoRoot);
          const cwdPath = resolveWorktreePath(repoRoot, byeResult.worktree, wtConfig);
          cleanupWorktree(byeResult.worktree, cwdPath, d, repoRoot);
        }
      }
    } catch (err) {
      const id = s.sessionId.slice(0, 8);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${id} error: ${msg}`);
    }
  }
}

/** Resolve the worktree path for --keep output when cwd is not provided */
function resolveKeptWorktreePath(byeResult: ByeResult): string {
  const repoRoot = process.cwd();
  const wtConfig = readWorktreeConfig(repoRoot);
  return resolveWorktreePath(repoRoot, byeResult.worktree as string, wtConfig);
}

export interface ByeResult {
  worktree: string | null;
  cwd: string | null;
  repoRoot: string | null;
}

export function parseByeResult(result: unknown): ByeResult {
  const r = result as { content?: Array<{ text?: string }> };
  const text = r?.content?.[0]?.text;
  if (!text) return { worktree: null, cwd: null, repoRoot: null };
  try {
    return JSON.parse(text) as ByeResult;
  } catch {
    return { worktree: null, cwd: null, repoRoot: null };
  }
}

// Re-export cleanupWorktree from the shim for backward compatibility
export { cleanupWorktree } from "@mcp-cli/core";

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

async function claudeApprove(args: string[], d: ClaudeDeps): Promise<void> {
  const { sessionPrefix, requestId } = parseApproveArgs(args, d);

  const { sessionId, resolvedRequestId } = await resolvePermissionTarget(sessionPrefix, requestId, d);
  const result = await d.callTool("claude_approve", { sessionId, requestId: resolvedRequestId });
  console.log(formatToolResult(result));
}

async function claudeDeny(args: string[], d: ClaudeDeps): Promise<void> {
  const { sessionPrefix, requestId, message } = parseDenyArgs(args, d);

  const { sessionId, resolvedRequestId } = await resolvePermissionTarget(sessionPrefix, requestId, d);
  const toolArgs: Record<string, unknown> = { sessionId, requestId: resolvedRequestId };
  if (message) toolArgs.message = message;
  const result = await d.callTool("claude_deny", toolArgs);
  console.log(formatToolResult(result));
}

export interface PatchUpdateArgs {
  force: boolean;
  json: boolean;
  sourcePath: string | undefined;
}

export function parsePatchUpdateArgs(args: string[], d: Pick<ClaudeDeps, "printError" | "exit">): PatchUpdateArgs {
  let force = false;
  let json = false;
  let sourcePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") force = true;
    else if (a === "--json") json = true;
    else if (a === "--source") sourcePath = args[++i];
    else if (a.startsWith("--source=")) sourcePath = a.slice("--source=".length);
    else {
      d.printError(`Unknown argument: ${a}`);
      d.exit(1);
    }
  }
  return { force, json, sourcePath };
}

/**
 * `mcx claude patch-update` — refresh the patched copy of the user's claude
 * binary so mcx-spawned sessions can connect to the local daemon. See #1808.
 *
 * Reads the user's installed claude (resolved via `which claude`), looks up
 * the matching patch strategy by version, and writes a patched + ad-hoc
 * re-signed copy under `~/.mcp-cli/claude-patched/`. The user's original
 * binary is never modified. Idempotent — second call is a no-op.
 */
export async function claudePatchUpdate(args: string[], d: ClaudeDeps): Promise<void> {
  const { force, json, sourcePath } = parsePatchUpdateArgs(args, d);

  let outcome: Awaited<ReturnType<typeof updatePatchedClaude>>;
  try {
    outcome = await d.runPatchUpdate({ sourcePath, force });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    d.printError(`patch-update failed: ${msg}`);
    return d.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }

  switch (outcome.status) {
    case "patched":
      d.log(`Patched claude ${outcome.version} → ${outcome.patchedPath}`);
      d.log(`Strategy: ${outcome.strategyId}`);
      d.log(`Source: ${outcome.sourcePath} (sha256 ${outcome.sourceHash.slice(0, 12)}…)`);
      break;
    case "already-current":
      d.log(`claude ${outcome.version} already patched (${outcome.strategyId}). Use --force to re-patch.`);
      break;
    case "noop":
      d.log(`claude ${outcome.version} needs no patch (${outcome.reason}).`);
      break;
    case "unsupported":
      d.printError(`claude ${outcome.version} is not supported by any registered patch strategy.`);
      d.printError(outcome.reason);
      d.exit(2);
  }
}

export interface LogArgs {
  sessionPrefix: string | undefined;
  last: number;
  json: boolean;
  full: boolean;
  jq: string | undefined;
  error: string | undefined;
}

// ── Approve/Deny arg parsing + resolution ──

export function parseApproveArgs(
  args: string[],
  d: Pick<ClaudeDeps, "printError" | "exit">,
): { sessionPrefix: string; requestId: string | undefined } {
  let requestId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request-id" || args[i] === "-r") {
      requestId = args[++i];
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  // Support legacy positional: approve <session> <request-id>
  if (!requestId && positional.length >= 2) {
    requestId = positional[1];
  }

  const sessionPrefix = positional[0];
  if (!sessionPrefix) {
    d.printError("Usage: mcx claude approve <session-id> [--request-id <id>]");
    d.exit(1);
  }

  return { sessionPrefix, requestId };
}

export function parseDenyArgs(
  args: string[],
  d: Pick<ClaudeDeps, "printError" | "exit">,
): { sessionPrefix: string; requestId: string | undefined; message: string | undefined } {
  let requestId: string | undefined;
  let message: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request-id" || args[i] === "-r") {
      requestId = args[++i];
    } else if (args[i] === "--message" || args[i] === "-m") {
      message = args[++i];
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  // Support legacy positional: deny <session> <request-id>
  if (!requestId && positional.length >= 2) {
    requestId = positional[1];
  }

  const sessionPrefix = positional[0];
  if (!sessionPrefix) {
    d.printError("Usage: mcx claude deny <session-id> [--request-id <id>] [--message <reason>]");
    d.exit(1);
  }

  return { sessionPrefix, requestId, message };
}

/**
 * Resolve sessionId (via prefix match) and requestId (explicit or auto-detect latest pending).
 */
export async function resolvePermissionTarget(
  sessionPrefix: string,
  requestId: string | undefined,
  d: SharedSessionDeps,
  listToolName = "claude_session_list",
): Promise<{ sessionId: string; resolvedRequestId: string }> {
  // Fetch session list (same call resolveSessionId uses)
  const result = await d.callTool(listToolName, {});
  const text = formatToolResult(result);
  let sessions: Array<{ sessionId: string; pendingPermissionDetails?: Array<{ requestId: string }> }>;
  try {
    sessions = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse session list");
  }

  const matches = sessions.filter((s) => s.sessionId.startsWith(sessionPrefix));
  if (matches.length === 0) {
    d.printError(`No session matching "${sessionPrefix}"`);
    d.exit(1);
  }
  if (matches.length > 1) {
    d.printError(`Ambiguous session prefix "${sessionPrefix}" — matches ${matches.length} sessions`);
    d.exit(1);
  }

  const session = matches[0];

  if (requestId) {
    return { sessionId: session.sessionId, resolvedRequestId: requestId };
  }

  // Auto-resolve: pick the most recent (last) pending permission
  const pending = session.pendingPermissionDetails ?? [];
  if (pending.length === 0) {
    d.printError(`No pending permission requests for session ${session.sessionId.slice(0, 8)}`);
    d.exit(1);
  }

  return { sessionId: session.sessionId, resolvedRequestId: pending[pending.length - 1].requestId };
}

export function parseLogArgs(args: string[]): LogArgs {
  const { json, rest: r1 } = extractJsonFlag(args);
  const { full, rest: r2 } = extractFullFlag(r1);
  const { jq, rest: r3 } = extractJqFlag(r2);

  let sessionPrefix: string | undefined;
  let last = 20;
  let error: string | undefined;

  for (let i = 0; i < r3.length; i++) {
    const arg = r3[i];
    if (arg === "--last" || arg === "-n" || arg === "--tail") {
      const val = r3[++i];
      if (!val) {
        error = `${arg} requires a number`;
      } else {
        last = Number(val);
        if (Number.isNaN(last)) error = `${arg} must be a number`;
      }
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  return { sessionPrefix, last, json, full, jq, error };
}

async function claudeLog(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseLogArgs(args);
  const compact = args.includes("--compact");

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.sessionPrefix) {
    d.printError("Usage: mcx claude log <session-id> [--last N] [--compact]");
    d.exit(1);
  }

  const sessionId = await resolveSessionId(parsed.sessionPrefix, d);
  // Claude supports compact natively in the daemon
  const toolArgs: Record<string, unknown> = { sessionId, limit: parsed.last };
  if (compact) toolArgs.compact = true;
  const result = await d.callTool("claude_transcript", toolArgs);
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
  afterSeq: number | undefined;
  short: boolean;
  all: boolean;
  /** Race session + work item events (returns whichever fires first). */
  any: boolean;
  /** Block until a specific PR changes state. */
  pr: number | undefined;
  /** Block until any tracked PR's CI completes. */
  checks: boolean;
  /** Also wake on mail addressed to this recipient (non-consuming peek). */
  mailTo: string | undefined;
  error: string | undefined;
}

export function parseWaitArgs(args: string[]): WaitArgs {
  let sessionPrefix: string | undefined;
  let timeout: number | undefined;
  let afterSeq: number | undefined;
  let short = false;
  let all = false;
  let any = false;
  let pr: number | undefined;
  let checks = false;
  let mailTo: string | undefined;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout" || arg === "-t") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) {
          error = "--timeout must be a number";
        } else if (timeout > MAX_TIMEOUT_MS) {
          error = `--timeout ${timeout}ms exceeds 4:59 cache-safe limit.\nThe Claude Code prompt cache has a 5-minute TTL; waits >= 5 minutes cause the\nnext turn to re-process full context at full input-token price.\nUse --timeout ${DEFAULT_TIMEOUT_MS} (4:30) or loop with shorter waits.`;
        }
      }
    } else if (arg === "--after") {
      const val = args[++i];
      if (!val) {
        error = "--after requires a sequence number";
      } else {
        afterSeq = Number(val);
        if (Number.isNaN(afterSeq)) error = "--after must be a number";
      }
    } else if (arg === "--short") {
      short = true;
    } else if (arg === "--all" || arg === "-a") {
      all = true;
    } else if (arg === "--any") {
      any = true;
    } else if (arg === "--pr") {
      const val = args[++i];
      if (!val) {
        error = "--pr requires a PR number";
      } else {
        pr = Number(val);
        if (Number.isNaN(pr)) error = "--pr must be a number";
      }
    } else if (arg === "--checks") {
      checks = true;
    } else if (arg === "--mail-to") {
      const val = args[++i];
      if (!val) {
        error = "--mail-to requires a recipient name";
      } else {
        mailTo = val;
      }
    } else if (arg.startsWith("--mail-to=")) {
      const val = arg.slice("--mail-to=".length);
      if (!val) {
        error = "--mail-to requires a recipient name";
      } else {
        mailTo = val;
      }
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  return { sessionPrefix, timeout, afterSeq, short, all, any, pr, checks, mailTo, error };
}

/**
 * Poll for unread mail addressed to `recipient` until one arrives or the
 * deadline expires. Non-consuming — does not markRead, so the caller can
 * still read the message via `mcx mail -u <recipient>` afterward.
 *
 * `afterMs` is a `Date.now()` snapshot taken before polling begins. Only
 * mail with `createdAt` strictly after that timestamp is surfaced, so
 * pre-existing unread messages do not cause false-positive wakeups.
 *
 * Transient `pollMail` errors (IPC blips, daemon restart) are swallowed
 * and retried until the deadline; a single network hiccup will not kill
 * the entire wait.
 *
 * Returns the message, or null on timeout.
 */
async function pollMailUntil(
  d: Pick<ClaudeDeps, "pollMail">,
  recipient: string,
  timeoutMs: number,
  afterMs: number,
  pollIntervalMs = 2000,
): Promise<MailMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let msg: MailMessage | null = null;
    try {
      msg = await d.pollMail(recipient);
    } catch {
      // Transient IPC error — continue polling until deadline
    }
    if (msg && new Date(msg.createdAt).getTime() > afterMs) return msg;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(pollIntervalMs, remaining));
  }
  return null;
}

function emitMailEvent(msg: MailMessage, short: boolean): void {
  if (short) {
    const subj = msg.subject ?? "(no subject)";
    console.log(`mail ${msg.id} ${msg.sender} ${subj}`);
    return;
  }
  console.log(JSON.stringify({ source: "mail", mail: msg }, null, 2));
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
  if (parsed.afterSeq !== undefined) {
    toolArgs.afterSeq = parsed.afterSeq;
  }
  if (parsed.any) {
    toolArgs.any = true;
  }
  if (parsed.pr !== undefined) {
    toolArgs.pr = parsed.pr;
  }
  if (parsed.checks) {
    toolArgs.checks = true;
  }

  // Pass scopeRoot or repoRoot to daemon for server-side filtering (only when no explicit session and no --all)
  let repoFilter: string | undefined;
  let scopeFilter: string | undefined;
  if (!parsed.all && !parsed.sessionPrefix) {
    const scope = detectScope();
    if (scope) {
      toolArgs.scopeRoot = scope.root;
      scopeFilter = scope.root;
    } else {
      const gitRoot = d.getGitRoot();
      if (gitRoot) {
        toolArgs.repoRoot = gitRoot;
        repoFilter = gitRoot;
      }
    }
  }

  const waitPromise = d.callTool("claude_wait", toolArgs);

  // If --mail-to is set, race the session wait against a non-consuming mail poll
  // so the caller wakes on incoming mail too (fixes #1359). Mail polling runs
  // in parallel until either fires; on mail win, we surface the event and return
  // without waiting for the orphaned claude_wait (daemon has its own timeout).
  let result: unknown;
  if (parsed.mailTo) {
    const totalMs = parsed.timeout ?? 270_000;
    const pollStart = Date.now();
    const mailPoll = pollMailUntil(d, parsed.mailTo, totalMs, pollStart);
    const winner = await Promise.race([
      waitPromise.then((r) => ({ kind: "session" as const, result: r })),
      mailPoll.then((m) => ({ kind: "mail" as const, message: m })),
    ]);
    if (winner.kind === "mail" && winner.message) {
      emitMailEvent(winner.message, parsed.short);
      return;
    }
    // Mail poll returned null (timed out) or session already won the race.
    result = winner.kind === "session" ? winner.result : await waitPromise;
  } else {
    result = await waitPromise;
  }
  const text = formatToolResult(result);

  // Parse daemon response
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  // Normalize old daemon response shapes (pre-unification):
  // - Bare array → session list from old timeout path
  // - Object with sessionId+event but no sessions key → bare event from old event path
  if (Array.isArray(data)) {
    data = { sessions: data };
  } else if (
    data &&
    typeof data === "object" &&
    "sessionId" in data &&
    "event" in data &&
    !("sessions" in data) &&
    !("events" in data)
  ) {
    data = { event: data, sessions: [] };
  }

  // Apply repo/scope filtering to unified { event?, sessions } shape
  const activeFilter = scopeFilter ?? repoFilter;
  const filterLabel = scopeFilter ? "other scopes" : "other repos";
  if (data && typeof data === "object" && "sessions" in data) {
    const unified = data as {
      source?: string;
      event?: Record<string, unknown>;
      workItemEvent?: Record<string, unknown>;
      sessions: Array<Record<string, unknown>>;
    };
    const matchesRepo = (s: Record<string, unknown>): boolean => {
      if (!repoFilter) return true;
      if (typeof s.repoRoot === "string") return s.repoRoot === repoFilter;
      // Legacy sessions without repoRoot: fall back to cwd prefix match (fixes #1242)
      const cwd = typeof s.cwd === "string" ? s.cwd : null;
      return cwd !== null && (cwd === repoFilter || cwd.startsWith(`${repoFilter}/`));
    };
    const matchesScope = (s: Record<string, unknown>): boolean => {
      if (!scopeFilter) return true;
      const cwd = typeof s.cwd === "string" ? s.cwd : null;
      return cwd !== null && (cwd === scopeFilter || cwd.startsWith(`${scopeFilter}/`));
    };
    if (repoFilter) {
      unified.sessions = unified.sessions.filter(matchesRepo);
    } else if (scopeFilter) {
      unified.sessions = unified.sessions.filter(matchesScope);
    }
    // Filter event if its session snapshot is from another repo/scope (fixes #1308).
    // Drop events without session info when any filter is active — we can't verify scope.
    if (unified.event && (repoFilter || scopeFilter)) {
      const session = unified.event.session as Record<string, unknown> | undefined;
      if (!session) {
        unified.event = undefined;
      } else if (repoFilter && !matchesRepo(session)) {
        unified.event = undefined;
      } else if (scopeFilter && !matchesScope(session)) {
        unified.event = undefined;
      }
    }
    if (!parsed.short) {
      console.log(JSON.stringify(unified, null, 2));
      if (activeFilter && unified.sessions.length === 0) {
        const origData = JSON.parse(text);
        const orig = Array.isArray(origData)
          ? origData.length
          : ((origData as { sessions?: unknown[] }).sessions?.length ?? 0);
        if (orig > 0) {
          console.error(`(${orig} session${orig === 1 ? "" : "s"} in ${filterLabel} — use --all to see them)`);
        }
      }
      return;
    }
    // --short: work item event
    if (unified.source === "work_item" && unified.workItemEvent) {
      const wie = unified.workItemEvent;
      const type = (wie.type as string) ?? "—";
      const prNum = wie.prNumber !== undefined ? `PR #${wie.prNumber}` : "—";
      console.log(`work_item ${type} ${prNum}`);
      return;
    }
    // --short: session event
    if (unified.event) {
      const evt = unified.event;
      const id = evt.sessionId ? String(evt.sessionId).slice(0, 8) : "—";
      const event = (evt.event as string) ?? "—";
      const cost = evt.cost && (evt.cost as number) > 0 ? `$${(evt.cost as number).toFixed(4)}` : "—";
      const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
      const preview = (evt.result as string) ? (evt.result as string).slice(0, 100) : "";
      console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    } else {
      // Timeout (no event) — print session list
      const origData = JSON.parse(text);
      const totalBeforeFilter = Array.isArray(origData)
        ? origData.length
        : ((origData as { sessions?: unknown[] }).sessions?.length ?? 0);
      for (const s of unified.sessions) {
        console.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
      }
      if (unified.sessions.length === 0 && totalBeforeFilter > 0 && activeFilter) {
        console.error(
          `(${totalBeforeFilter} session${totalBeforeFilter === 1 ? "" : "s"} in ${filterLabel} — use --all to see them)`,
        );
      }
    }
    return;
  }

  // Cursor-based result with events array: { seq, events }
  if (data && typeof data === "object" && "events" in data) {
    const waitResult = data as { seq: number; events: Array<Record<string, unknown>> };
    let events = waitResult.events;
    const totalEventsBeforeFilter = events.length;
    if (repoFilter) {
      events = events.filter((e) => {
        const repo = e.session && (e.session as Record<string, unknown>).repoRoot;
        return !repo || repo === repoFilter;
      });
    }
    if (!parsed.short) {
      waitResult.events = events;
      console.log(JSON.stringify(waitResult, null, 2));
      if (events.length === 0 && totalEventsBeforeFilter > 0) {
        console.error(
          `(${totalEventsBeforeFilter} event${totalEventsBeforeFilter === 1 ? "" : "s"} in ${filterLabel} — use --all to see them)`,
        );
      }
      return;
    }
    for (const e of events) {
      const session = e.session as Record<string, unknown> | undefined;
      const id = session?.sessionId ? String(session.sessionId).slice(0, 8) : "—";
      const event = (e.event as string) ?? "—";
      const cost = session?.cost && (session.cost as number) > 0 ? `$${(session.cost as number).toFixed(4)}` : "—";
      const turns = session?.numTurns !== undefined ? String(session.numTurns) : "—";
      const preview = (e.result as string) ? (e.result as string).slice(0, 100) : "";
      console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    }
    if (events.length === 0 && totalEventsBeforeFilter > 0 && activeFilter) {
      console.error(
        `(${totalEventsBeforeFilter} event${totalEventsBeforeFilter === 1 ? "" : "s"} in ${filterLabel} — use --all to see them)`,
      );
    }
    return;
  }

  // Unrecognized shape — pass through
  console.log(text);
}

// Re-export parseWorktreeList from the shim for backward compatibility
export { parseWorktreeList } from "@mcp-cli/core";

async function claudeWorktrees(args: string[], d: ClaudeDeps): Promise<void> {
  const { worktreesCommand } = await import("./worktree-commands");
  await worktreesCommand(args, d);
}

// ── Helpers ──

export async function resolveSessionId(
  prefix: string,
  d: SharedSessionDeps,
  listTool = "claude_session_list",
): Promise<string> {
  const result = await d.callTool(listTool, {});
  const text = formatToolResult(result);
  let sessions: Array<{ sessionId: string; name?: string | null }>;
  try {
    sessions = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse session list");
  }

  // Try exact name match first (case-insensitive)
  const prefixLower = prefix.toLowerCase();
  const nameMatches = sessions.filter((s) => s.name?.toLowerCase() === prefixLower);

  // Also check UUID prefix matches
  const matches = sessions.filter((s) => s.sessionId.startsWith(prefix));

  if (nameMatches.length === 1) {
    // Warn if a UUID prefix match is being shadowed by the name match
    const shadowedById = matches.filter((s) => s.sessionId !== nameMatches[0].sessionId);
    if (shadowedById.length > 0) {
      d.printError(
        `Warning: name "${prefix}" shadows UUID prefix match (${shadowedById.map((s) => s.sessionId.slice(0, 8)).join(", ")}). Using named session.`,
      );
    }
    return nameMatches[0].sessionId;
  }

  if (matches.length === 0 && nameMatches.length === 0) {
    d.printError(`No session matching "${prefix}"`);
    d.exit(1);
  }

  if (matches.length > 1) {
    d.printError(`Ambiguous session prefix "${prefix}" — matches ${matches.length} sessions`);
    d.exit(1);
  }

  if (matches.length === 0) {
    // Multiple name matches
    d.printError(`Ambiguous session name "${prefix}" — matches ${nameMatches.length} sessions`);
    d.exit(1);
  }

  return matches[0].sessionId;
}

/**
 * Get the set of worktree names with active sessions from a session list tool.
 * Returns an empty set if the daemon is unreachable.
 */
export async function getActiveSessionWorktrees(listTool: string, d: SharedSessionDeps): Promise<Set<string>> {
  try {
    const result = await d.callTool(listTool, {});
    const text = formatToolResult(result);
    const sessions = JSON.parse(text) as Array<{ worktree?: string | null }>;
    return new Set(sessions.filter((s) => s.worktree).map((s) => s.worktree as string));
  } catch {
    return new Set();
  }
}

// ── Usage ──

function printClaudeUsage(): void {
  console.log(`mcx claude — manage Claude Code sessions

Usage:
  mcx claude spawn --task "description"    Start a new Claude session (non-blocking)
  mcx claude spawn --headed --task "desc"  Start Claude in a visible terminal tab
  mcx claude spawn "description"           Shorthand (positional task)
  mcx claude resume <worktree-or-branch>   Resume with conversation history (--continue)
  mcx claude resume <worktree> <session>   Resume specific session (--resume <id>)
  mcx claude resume <worktree> --fresh     Resume with git-context prompt (no history)
  mcx claude resume --all                  Resume all orphaned worktrees
  mcx claude ls [--pr] [--all]             List sessions (scoped to current repo by default)
  mcx claude send <session> <message>      Send follow-up prompt (non-blocking)
  mcx claude wait [session] [--all]        Block until a session event occurs
  mcx claude bye <session>                 End session and stop process
  mcx claude interrupt <session>           Interrupt the current turn
  mcx claude approve <session>              Approve latest pending permission request
  mcx claude deny <session>                Deny latest pending permission request
  mcx claude log <session> [--last N]      View session transcript
  mcx claude log <session> --json          Raw JSON transcript output
  mcx claude log <session> --json --jq '.' Apply jq filter to JSON output
  mcx claude log <session> --full          Full output (no truncation)
  mcx claude worktrees                     List mcx-created worktrees
  mcx claude worktrees --prune             Remove orphaned worktrees + merged branches
  mcx claude patch-update                  Refresh the patched copy used for mcx spawns (#1808)

Spawn options:
  --task, -t "description"    Task prompt for Claude
  --headed                    Open Claude in a visible terminal tab (via tty)
  --wait                      Block until Claude produces a result
  --model, -m <name>          Model to use: opus, sonnet, haiku, or full ID (default: opus)
  --worktree, -w [name]       Git worktree isolation (auto-generates name if omitted)
  --resume <id>               Resume a previous session
  --allow <tools...>          Pre-approved tool patterns (default: Read Glob Grep Write Edit)
  --cwd <path>                Working directory for Claude
  --timeout <ms>              Max wait time (default: 270000, only with --wait)

Resume options:
  --fresh                     Use git-context prompt instead of conversation history
  --all                       Resume all orphaned worktrees (batch mode)
  --model, -m <name>          Model to use: opus, sonnet, haiku, or full ID
  --allow <tools...>          Pre-approved tool patterns
  --wait                      Block until Claude produces a result
  --timeout <ms>              Max wait time (default: 270000, only with --wait)

Send options:
  --wait                      Block until Claude produces a result

List/Wait options:
  --all, -a                   Show all sessions (bypass repo scoping)

Wait options:
  --after <seq>               Sequence cursor for race-free polling (from previous response)
  --timeout, -t <ms>          Max wait time (default: 270000)

Approve/Deny options:
  --request-id, -r <id>       Specific request ID (auto-detects latest if omitted)
  --message, -m <reason>      Denial reason (deny only)

Session IDs support prefix matching (like git SHAs).`);
}
