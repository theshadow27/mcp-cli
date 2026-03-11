/**
 * `mcx claude` commands — manage Claude Code sessions via the _claude virtual server.
 *
 * All commands route through `callTool` on the `_claude` virtual server.
 * No dedicated IPC methods — the same tools work from any MCP client.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildHookEnv,
  fixCoreBare,
  hasWorktreeHooks,
  ipcCall,
  readWorktreeConfig,
  resolveModelName,
  resolveWorktreeBase,
  resolveWorktreePath,
} from "@mcp-cli/core";
import type { WorktreeHooksConfig } from "@mcp-cli/core";
import { getStaleDaemonWarning } from "../daemon-lifecycle";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";
import { ttyOpen } from "./tty";

import type { SessionInfo } from "@mcp-cli/core";

// ── Dependency injection ──

export interface PrStatus {
  number: number;
  state: string;
}

export interface ClaudeDeps {
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
  getDiffStats: (worktreePath: string) => Promise<string | null>;
  getPrStatus: (worktreePath: string) => Promise<PrStatus | null>;
  /** Run a command and return stdout + stderr + exit code. Used for git operations in `bye`. */
  exec: (
    cmd: string[],
    opts?: { env?: Record<string, string> },
  ) => { stdout: string; stderr: string; exitCode: number };
  /** Open a command in a terminal tab/window. Used for --headed spawn. */
  ttyOpen: (args: string[]) => Promise<void>;
  /** Resolve the git repo root for the current working directory. Returns null if not in a git repo. */
  getGitRoot: () => string | null;
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

const defaultDeps: ClaudeDeps = {
  callTool: (tool, args) => {
    const needsLongTimeout = (tool === "claude_prompt" && args.wait) || tool === "claude_wait";
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: "_claude", tool, arguments: args }, { timeoutMs });
  },
  printError: defaultPrintError,
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
    case "resume":
      await claudeResume(args.slice(1), d);
      break;
    case "worktrees":
    case "wt":
      await claudeWorktrees(args.slice(1), d);
      break;
    default:
      d.printError(
        `Unknown claude subcommand: ${sub}. Use "spawn", "resume", "ls", "send", "bye", "interrupt", "log", "wait", or "worktrees".`,
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
  headed: boolean;
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
  let headed = false;
  const allow: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--headed") {
      headed = true;
    } else if (arg === "--task" || arg === "-t") {
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

  return { task, worktree, resume, allow, cwd, timeout, model, wait, headed, error };
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

  if (parsed.headed) {
    await claudeSpawnHeaded(parsed, d);
    return;
  }

  const toolArgs: Record<string, unknown> = {
    prompt: parsed.task ?? "Continue from where you left off.",
  };
  if (parsed.resume) toolArgs.sessionId = parsed.resume;
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.wait) toolArgs.wait = true;

  // Handle worktree with lifecycle hooks: pre-create via hook,
  // then pass cwd (not --worktree) so Claude doesn't try to create another.
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
      // Pass cwd + worktree name + repoRoot — daemon will use cwd but skip --worktree flag
      toolArgs.cwd = worktreePath;
      toolArgs.worktree = parsed.worktree;
      toolArgs.repoRoot = repoRoot;
      d.printError(`Created worktree via hook: ${worktreePath}`);
    } else if (wtConfig?.branchPrefix === false) {
      // branchPrefix: false — pre-create worktree with raw branch name (no claude/ prefix)
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

  const result = await d.callTool("claude_prompt", toolArgs);
  console.log(formatToolResult(result));
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
    const repoRoot = process.cwd();
    const wtConfig = readWorktreeConfig(repoRoot);
    const worktreePath = resolveWorktreePath(repoRoot, parsed.worktree, wtConfig);

    if (hasWorktreeHooks(wtConfig)) {
      // Run the setup hook instead of git worktree add
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
    } else {
      const branchName = wtConfig?.branchPrefix === false ? parsed.worktree : `headed/${parsed.worktree}`;
      const { exitCode, stdout } = d.exec(["git", "worktree", "add", worktreePath, "-b", branchName, "HEAD"]);
      if (exitCode !== 0) {
        d.printError(`Failed to create worktree: ${stdout}`);
        d.exit(1);
      }
    }
    cwd = worktreePath;
    d.printError(`Created worktree: ${worktreePath}`);
  }

  // Build the claude command and prepend cd if cwd is set
  const command = cwd ? `cd ${shellQuote(cwd)} && ${buildHeadedCommand(parsed)}` : buildHeadedCommand(parsed);

  await d.ttyOpen([command]);
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

async function claudeResume(args: string[], d: ClaudeDeps): Promise<void> {
  const parsed = parseResumeArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const cwd = process.cwd();
  const wtConfig = readWorktreeConfig(cwd);
  const worktreeParent = resolveWorktreeBase(cwd, wtConfig);

  // List all worktrees
  const { stdout: wtOutput, exitCode: wtExit } = d.exec(["git", "-C", cwd, "worktree", "list", "--porcelain"]);
  if (wtExit !== 0) {
    d.printError("Failed to list git worktrees (not a git repo?)");
    d.exit(1);
  }

  const allWorktrees = parseWorktreeList(wtOutput);
  const mcxWorktrees = allWorktrees.filter((wt) => wt.path.startsWith(`${worktreeParent}/`));

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

    d.printError(`Resuming ${orphaned.length} orphaned worktree${orphaned.length === 1 ? "" : "s"}...`);

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

/**
 * Detect the default branch (e.g. "main" or "master") from origin/HEAD.
 * Falls back to "main" if git symbolic-ref is unavailable or returns nothing.
 */
function getDefaultBranch(exec: ClaudeDeps["exec"], cwd: string): string {
  const { stdout, exitCode } = exec(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (exitCode === 0 && stdout.trim()) {
    // e.g. "refs/remotes/origin/main" → "main"
    const parts = stdout.trim().split("/");
    return parts[parts.length - 1] || "main";
  }
  return "main";
}

async function resumeWorktree(
  wt: { path: string; branch: string | null },
  parsed: ResumeArgs,
  d: ClaudeDeps,
): Promise<void> {
  const branch = wt.branch ?? "unknown";

  // Check if branch is already merged into the default branch
  const defaultBranch = getDefaultBranch(d.exec, wt.path);
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

async function claudeList(args: string[], d: ClaudeDeps): Promise<void> {
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr");
  const showAll = args.includes("--all") || args.includes("-a");

  // Pass repoRoot to daemon for server-side filtering unless --all
  const toolArgs: Record<string, unknown> = {};
  if (!showAll) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) toolArgs.repoRoot = gitRoot;
  }

  const result = await d.callTool("claude_session_list", toolArgs);
  const text = formatToolResult(result);

  if (json) {
    console.log(text);
    return;
  }

  let sessions: (SessionInfo & { repoRoot?: string | null })[];
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

  if (short) {
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

  // Table output
  const diffHeader = hasAnyDiff ? ` ${"DIFF".padEnd(16)}` : "";
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${diffHeader}${prHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = s.sessionId.slice(0, 8);
    const state = colorState(s.state);
    const model = (s.model ?? "—").padEnd(16);
    const cost = s.cost > 0 ? `$${s.cost.toFixed(4)}`.padEnd(8) : "—".padEnd(8);
    const tokens = s.tokens > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const diff = hasAnyDiff ? ` ${(diffStats[i] ?? "—").padEnd(16)}` : "";
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = s.cwd ?? "—";
    console.log(`${c.cyan}${id}${c.reset}   ${state} ${model} ${cost} ${tokens}${diff}${pr} ${c.dim}${cwd}${c.reset}`);
  }

  const staleWarning = getStaleDaemonWarning();
  if (staleWarning) {
    console.error(`\n⚠ ${staleWarning}`);
  }
}

/** Compact one-line format: SESSION STATE MODEL COST TOKENS TURNS */
export function formatSessionShort(s: {
  sessionId: string;
  state: string;
  model?: string | null;
  cost?: number | null;
  tokens?: number;
  numTurns?: number;
}): string {
  const id = s.sessionId.slice(0, 8);
  const state = s.state;
  const model = s.model ?? "—";
  const cost = s.cost && s.cost > 0 ? `$${s.cost.toFixed(4)}` : "—";
  const tokens = s.tokens && s.tokens > 0 ? String(s.tokens) : "—";
  const turns = s.numTurns !== undefined ? String(s.numTurns) : "—";
  return `${id} ${state} ${model} ${cost} ${tokens} ${turns}`;
}

function formatPrStatus(pr: PrStatus | null): string {
  if (!pr) return "—";
  return `#${pr.number} ${pr.state}`;
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
    cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
  }
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

/** Clean up a worktree after session ends: remove if clean, warn if dirty. */
export function cleanupWorktree(worktree: string, cwd: string, d: ClaudeDeps, repoRoot?: string | null): void {
  // repoRoot is stored in session metadata at spawn time and returned by bye.
  // For hook-based worktrees, cwd is the worktree path (not repo root), so repoRoot is required.
  // For non-hook worktrees, cwd from bye IS the repo root — use it as fallback.
  const effectiveRoot = repoRoot ?? cwd;
  const wtConfig = readWorktreeConfig(effectiveRoot);
  const worktreeBase = resolveWorktreeBase(effectiveRoot, wtConfig);
  const worktreePath = join(worktreeBase, worktree);

  // Guard against path traversal (worktree name comes from daemon response)
  if (!worktreePath.startsWith(`${worktreeBase}/`)) return;

  // Check for uncommitted changes in the worktree
  const { stdout: status, exitCode: statusExit } = d.exec(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (statusExit !== 0) return; // worktree gone, not a git repo, or git unavailable

  if (status === "") {
    // Capture branch name before removing worktree (removal deletes the .git link)
    const { stdout: branch } = d.exec(["git", "-C", worktreePath, "branch", "--show-current"]);

    if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
      // Run teardown hook instead of git worktree remove
      const hookEnv = buildHookEnv({ branch: worktree, path: worktreePath, cwd: effectiveRoot });
      const { exitCode: hookExit, stderr: hookStderr } = d.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
      if (hookExit === 0) {
        d.printError(`Removed worktree via hook: ${worktreePath}`);
        // Clean up the branch (same as non-hook path)
        if (branch) {
          const { exitCode: branchExit } = d.exec(["git", "-C", effectiveRoot, "branch", "-d", branch]);
          if (branchExit === 0) {
            d.printError(`Deleted branch: ${branch} (merged)`);
          }
        }
      } else {
        d.printError(`Worktree teardown hook failed for: ${worktreePath}: ${hookStderr}`);
      }
    } else {
      // Default: git worktree remove
      const { exitCode: removeExit } = d.exec(["git", "-C", effectiveRoot, "worktree", "remove", worktreePath]);
      if (removeExit === 0) {
        if (fixCoreBare(effectiveRoot, d.exec)) d.printError("Fixed core.bare=true after worktree removal");
        d.printError(`Removed worktree: ${worktreePath}`);
        // Delete the local branch if it was merged (git branch -d is safe — refuses unmerged)
        if (branch) {
          const { exitCode: branchExit } = d.exec(["git", "-C", effectiveRoot, "branch", "-d", branch]);
          if (branchExit === 0) {
            d.printError(`Deleted branch: ${branch} (merged)`);
          }
          // If -d fails the branch is unmerged — silently keep it
        }
      } else {
        d.printError(`Failed to remove worktree: ${worktreePath}`);
      }
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
  jq: string | undefined;
  error: string | undefined;
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
    if (arg === "--last" || arg === "-n") {
      const val = r3[++i];
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

  return { sessionPrefix, last, json, full, jq, error };
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
  error: string | undefined;
}

export function parseWaitArgs(args: string[]): WaitArgs {
  let sessionPrefix: string | undefined;
  let timeout: number | undefined;
  let afterSeq: number | undefined;
  let short = false;
  let all = false;
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
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  return { sessionPrefix, timeout, afterSeq, short, all, error };
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

  // Pass repoRoot to daemon for server-side filtering (only when no explicit session and no --all)
  if (!parsed.all && !parsed.sessionPrefix) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) toolArgs.repoRoot = gitRoot;
  }

  const result = await d.callTool("claude_wait", toolArgs);
  const text = formatToolResult(result);

  if (!parsed.short) {
    console.log(text);
    return;
  }

  // --short: try to parse the result
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  // Timeout fallback returns a session list array
  if (Array.isArray(data)) {
    const sessions = data as Array<{
      sessionId: string;
      state: string;
      model?: string | null;
      cost?: number | null;
      tokens?: number;
      numTurns?: number;
      repoRoot?: string | null;
    }>;
    for (const s of sessions) {
      console.log(formatSessionShort(s));
    }
    return;
  }

  // Cursor-based result with events array
  if (data && typeof data === "object" && "events" in data) {
    const waitResult = data as { seq: number; events: Array<Record<string, unknown>> };
    for (const e of waitResult.events) {
      const session = e.session as Record<string, unknown> | undefined;
      const id = session?.sessionId ? String(session.sessionId).slice(0, 8) : "—";
      const event = (e.event as string) ?? "—";
      const cost = session?.cost && (session.cost as number) > 0 ? `$${(session.cost as number).toFixed(4)}` : "—";
      const turns = session?.numTurns !== undefined ? String(session.numTurns) : "—";
      const preview = (e.result as string) ? (e.result as string).slice(0, 100) : "";
      console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    }
    return;
  }

  // Normal event result: SESSION EVENT COST TURNS RESULT_PREVIEW
  const evt = data as {
    sessionId?: string;
    event?: string;
    cost?: number;
    numTurns?: number;
    result?: string;
  };

  const id = evt.sessionId ? evt.sessionId.slice(0, 8) : "—";
  const event = evt.event ?? "—";
  const cost = evt.cost && evt.cost > 0 ? `$${evt.cost.toFixed(4)}` : "—";
  const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
  const preview = evt.result ? evt.result.slice(0, 100) : "";
  console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
}

/** Parse `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeList(output: string): Array<{ path: string; branch: string | null }> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath) entries.push({ path: currentPath, branch: currentBranch });
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    }
  }
  if (currentPath) entries.push({ path: currentPath, branch: currentBranch });
  return entries;
}

async function claudeWorktrees(args: string[], d: ClaudeDeps): Promise<void> {
  const prune = args.includes("--prune");
  const cwd = process.cwd();
  const wtConfig = readWorktreeConfig(cwd);
  const worktreeParent = resolveWorktreeBase(cwd, wtConfig);

  // Get all git worktrees
  const { stdout: wtOutput, exitCode: wtExit } = d.exec(["git", "-C", cwd, "worktree", "list", "--porcelain"]);
  if (wtExit !== 0) {
    d.printError("Failed to list git worktrees (not a git repo?)");
    d.exit(1);
  }

  const allWorktrees = parseWorktreeList(wtOutput);
  // Filter to mcx-created worktrees under .claude/worktrees/
  const mcxWorktrees = allWorktrees.filter((wt) => wt.path.startsWith(`${worktreeParent}/`));

  if (mcxWorktrees.length === 0 && !prune) {
    d.printError("No mcx worktrees found.");
    return;
  }

  // Get active sessions to cross-reference
  let sessionWorktrees = new Set<string>();
  try {
    const result = await d.callTool("claude_session_list", {});
    const text = formatToolResult(result);
    const sessions = JSON.parse(text) as SessionInfo[];
    sessionWorktrees = new Set(sessions.filter((s) => s.worktree).map((s) => s.worktree as string));
  } catch {
    // Daemon may not be running — continue without session info
  }

  if (prune) {
    const defaultBranch = getDefaultBranch(d.exec, cwd);
    // Get list of branches merged into the default branch
    const { stdout: mergedOutput, exitCode: mergedExit } = d.exec([
      "git",
      "-C",
      cwd,
      "branch",
      "--merged",
      defaultBranch,
    ]);
    let mergedBranches: Set<string>;
    let skipMergeCheck = false;
    if (mergedExit !== 0) {
      d.printError(
        "Warning: could not determine merged branches (git branch --merged failed). Pruning clean orphaned worktrees without merge check.",
      );
      mergedBranches = new Set();
      skipMergeCheck = true;
    } else {
      mergedBranches = new Set(
        mergedOutput
          .split("\n")
          .map((line) => line.replace(/^\*?\s+/, "").trim())
          .filter(Boolean),
      );
    }

    let pruned = 0;
    const skipped: string[] = [];
    for (const wt of mcxWorktrees) {
      const wtName = wt.path.slice(`${worktreeParent}/`.length);
      // Skip worktrees with active sessions
      if (sessionWorktrees.has(wtName)) continue;

      // Only prune worktrees whose branch has been merged (unless merge check failed)
      if (!skipMergeCheck && wt.branch && !mergedBranches.has(wt.branch)) {
        skipped.push(wt.branch);
        continue;
      }

      // Check if clean
      const { stdout: status, exitCode: statusExit } = d.exec(["git", "-C", wt.path, "status", "--porcelain"]);
      if (statusExit !== 0 || status !== "") continue; // gone or dirty — skip

      // Remove worktree
      if (hasWorktreeHooks(wtConfig) && wtConfig.teardown) {
        const hookEnv = buildHookEnv({ branch: wtName, path: wt.path, cwd });
        const { exitCode: hookExit, stderr: hookStderr } = d.exec(["sh", "-c", wtConfig.teardown], { env: hookEnv });
        if (hookExit === 0) {
          d.printError(`Removed worktree via hook: ${wt.path}`);
          pruned++;
          // Clean up the branch
          if (wt.branch) {
            const { exitCode: branchExit } = d.exec(["git", "-C", cwd, "branch", "-d", wt.branch]);
            if (branchExit === 0) {
              d.printError(`Deleted branch: ${wt.branch} (merged)`);
            }
          }
        } else {
          d.printError(`Worktree teardown hook failed for: ${wt.path}: ${hookStderr}`);
        }
      } else {
        const { exitCode: removeExit } = d.exec(["git", "-C", cwd, "worktree", "remove", wt.path]);
        if (removeExit === 0) {
          if (fixCoreBare(cwd, d.exec)) d.printError("Fixed core.bare=true after worktree removal");
          d.printError(`Removed worktree: ${wt.path}`);
          pruned++;
          // Delete branch only if git branch -d succeeds
          if (wt.branch) {
            const { exitCode: branchExit } = d.exec(["git", "-C", cwd, "branch", "-d", wt.branch]);
            if (branchExit === 0) {
              d.printError(`Deleted branch: ${wt.branch} (merged)`);
            }
          }
        }
      }
    }
    if (pruned === 0) {
      d.printError("Nothing to prune.");
    } else {
      d.printError(`Pruned ${pruned} worktree${pruned === 1 ? "" : "s"}.`);
    }
    if (skipped.length > 0) {
      d.printError(`Skipped ${skipped.length} unmerged: ${skipped.join(", ")}`);
    }
    return;
  }

  // List mode — display table
  const header = `${"WORKTREE".padEnd(28)} ${"BRANCH".padEnd(32)} ${"STATUS".padEnd(10)} SESSION`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (const wt of mcxWorktrees) {
    const wtName = wt.path.slice(`${worktreeParent}/`.length);
    const branch = (wt.branch ?? "—").padEnd(32);
    const hasSession = sessionWorktrees.has(wtName);

    // Check dirty/clean
    const { stdout: status, exitCode: statusExit } = d.exec(["git", "-C", wt.path, "status", "--porcelain"]);
    let wtStatus: string;
    if (statusExit !== 0) {
      wtStatus = `${c.red}${"gone".padEnd(10)}${c.reset}`;
    } else if (status === "") {
      wtStatus = `${c.green}${"clean".padEnd(10)}${c.reset}`;
    } else {
      wtStatus = `${c.yellow}${"dirty".padEnd(10)}${c.reset}`;
    }

    const session = hasSession ? `${c.green}active${c.reset}` : `${c.dim}—${c.reset}`;
    console.log(`${c.cyan}${wtName.padEnd(28)}${c.reset} ${branch} ${wtStatus} ${session}`);
  }
}

// ── Helpers ──

export async function resolveSessionId(
  prefix: string,
  d: ClaudeDeps,
  listTool = "claude_session_list",
): Promise<string> {
  const result = await d.callTool(listTool, {});
  const text = formatToolResult(result);
  let sessions: Array<{ sessionId: string }>;
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

export function colorState(state: string): string {
  const padded = state.padEnd(12);
  switch (state) {
    case "active":
      return `${c.green}${padded}${c.reset}`;
    case "connecting":
    case "init":
      return `${c.yellow}${padded}${c.reset}`;
    case "waiting_permission":
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
  mcx claude log <session> [--last N]      View session transcript
  mcx claude log <session> --json          Raw JSON transcript output
  mcx claude log <session> --json --jq '.' Apply jq filter to JSON output
  mcx claude log <session> --full          Full output (no truncation)
  mcx claude worktrees                     List mcx-created worktrees
  mcx claude worktrees --prune             Remove orphaned worktrees + merged branches

Spawn options:
  --task, -t "description"    Task prompt for Claude
  --headed                    Open Claude in a visible terminal tab (via tty)
  --wait                      Block until Claude produces a result
  --model, -m <name>          Model to use: opus, sonnet, haiku, or full ID (default: opus)
  --worktree, -w [name]       Git worktree isolation (auto-generates name if omitted)
  --resume <id>               Resume a previous session
  --allow <tools...>          Pre-approved tool patterns (default: Read Glob Grep Write Edit)
  --cwd <path>                Working directory for Claude
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Resume options:
  --fresh                     Use git-context prompt instead of conversation history
  --all                       Resume all orphaned worktrees (batch mode)
  --model, -m <name>          Model to use: opus, sonnet, haiku, or full ID
  --allow <tools...>          Pre-approved tool patterns
  --wait                      Block until Claude produces a result
  --timeout <ms>              Max wait time (default: 300000, only with --wait)

Send options:
  --wait                      Block until Claude produces a result

List/Wait options:
  --all, -a                   Show all sessions (bypass repo scoping)

Wait options:
  --after <seq>               Sequence cursor for race-free polling (from previous response)
  --timeout, -t <ms>          Max wait time (default: 300000)

Session IDs support prefix matching (like git SHAs).`);
}
