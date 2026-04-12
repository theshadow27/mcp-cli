/**
 * `mcx agent <provider> <subcommand>` — unified command for all agent providers.
 *
 * Dispatches subcommands parameterized by the provider registry, eliminating
 * the duplication that existed across the former per-provider command files.
 *
 * Subcommands: spawn, ls, send, bye, wait, interrupt, log, resume, approve, deny, worktrees
 * Provider-specific flags (--headed, --agent, --provider) are gated by feature flags.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentFeatures, AgentProvider } from "@mcp-cli/core";
import {
  PROMPT_IPC_TIMEOUT_MS,
  WorktreeError,
  buildHookEnv,
  getAllProviders,
  getDefaultBranch,
  getProvider,
  hasWorktreeHooks,
  listMcxWorktrees,
  pruneWorktrees,
  readWorktreeConfig,
  resolveWorktreePath,
} from "@mcp-cli/core";
import { getStaleDaemonWarning, ipcCall } from "../daemon-lifecycle";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";
import {
  type SharedSessionDeps,
  buildResumePrompt,
  cleanupWorktree,
  extractIssueNumber,
  parseApproveArgs,
  parseByeResult,
  parseDenyArgs,
  resolvePermissionTarget,
  resolveSessionId,
  resolveWorktree,
} from "./claude";
import { colorState, extractContentSummary, formatAge, formatSessionShort } from "./session-display";
import { looksLikeToolName, parseSharedSpawnArgs } from "./spawn-args";
import { ttyOpen } from "./tty";

// ── Dependency injection ──

export interface AgentDeps extends SharedSessionDeps {
  getStaleDaemonWarning: () => string | null;
  /** Resolve the git repo root for the current working directory. */
  getGitRoot: () => string | null;
  /** Get the current working directory. */
  getCwd: () => string;
  /** Get diff stats for a worktree path. */
  getDiffStats: (worktreePath: string) => Promise<string | null>;
  /** Get PR status for a worktree path. */
  getPrStatus: (worktreePath: string) => Promise<{ number: number; state: string } | null>;
  /** Open a command in a terminal tab/window. */
  ttyOpen: (args: string[]) => Promise<void>;
  /** Write to stdout (default: console.log). Injected for testability. */
  log: (...args: unknown[]) => void;
  /** Write to stderr (default: console.error). Injected for testability. */
  logError: (...args: unknown[]) => void;
}

function makeCallTool(provider: AgentProvider): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  const p = provider.toolPrefix;
  return (tool, args) => {
    const needsLongTimeout = tool === `${p}_prompt` || tool === `${p}_wait`;
    const timeoutMs = needsLongTimeout ? PROMPT_IPC_TIMEOUT_MS : undefined;
    return ipcCall("callTool", { server: provider.serverName, tool, arguments: args }, { timeoutMs });
  };
}

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
    const resolved = resolve(commonDir);
    return resolved.endsWith(".git") ? dirname(resolved) : resolved;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }
}

async function defaultGetPrStatus(worktreePath: string): Promise<{ number: number; state: string } | null> {
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

export function makeDefaultDeps(provider: AgentProvider): AgentDeps {
  return {
    callTool: makeCallTool(provider),
    printError: defaultPrintError,
    exit: (code) => process.exit(code),
    getStaleDaemonWarning,
    getGitRoot,
    getCwd: () => process.cwd(),
    getDiffStats: defaultGetDiffStats,
    getPrStatus: defaultGetPrStatus,
    ttyOpen: (args) => ttyOpen(args),
    log: console.log,
    logError: console.error,
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
}

// ── Helpers ──

/** Check if an error indicates the daemon is not running (ECONNREFUSED/ENOENT). */
function isDaemonUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED" || code === "ENOENT") return true;
  const msg = (err as { message?: string }).message;
  return typeof msg === "string" && (/ECONNREFUSED/.test(msg) || /ENOENT/.test(msg));
}

/** Parse a session list response, validating it's an array. Throws if not. */
function parseSessionList(text: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected session list to be an array, got ${typeof parsed}: ${text.slice(0, 200)}`);
  }
  return parsed as Array<Record<string, unknown>>;
}

/** Capitalize the first letter of a provider name for display. */
function providerDisplayName(provider: AgentProvider, override?: string): string {
  const n = override ?? provider.name;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Check a partial feature flag — undefined is treated as false. */
function hasFeature(provider: AgentProvider, feature: keyof AgentFeatures): boolean {
  return provider.native[feature] === true;
}

// ── Entry point ──

/**
 * `mcx agent <provider> <subcommand> [args...]`
 *
 * @param args - CLI arguments after `agent`
 * @param deps - Injectable dependencies for testing (optional)
 */
export async function cmdAgent(args: string[], deps?: Partial<AgentDeps>): Promise<void> {
  const providerName = args[0];

  if (!providerName || providerName === "--help" || providerName === "-h") {
    printAgentUsage(deps?.log);
    return;
  }

  const provider = getProvider(providerName);
  if (!provider) {
    const available = getAllProviders()
      .filter((p) => !["copilot", "gemini"].includes(p.name))
      .map((p) => p.name)
      .join(", ");
    (deps?.printError ?? defaultPrintError)(`Unknown provider: ${providerName}. Available: ${available}`);
    (deps?.exit ?? ((code: number) => process.exit(code)))(1);
    return; // unreachable but helps TS
  }

  // Derive agent override from buildSpawnArgs (copilot/gemini inject agentOverride into spawn args)
  const dummySpawnArgs = provider.buildSpawnArgs({ task: "" });
  const agentOverride = typeof dummySpawnArgs.agentOverride === "string" ? dummySpawnArgs.agentOverride : undefined;

  const d: AgentDeps = { ...makeDefaultDeps(provider), ...deps };

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    printProviderUsage(provider, providerName, agentOverride, d.log);
    return;
  }

  switch (sub) {
    case "spawn":
      await agentSpawn(args.slice(2), provider, agentOverride, d);
      break;
    case "ls":
    case "list":
      await agentList(args.slice(2), provider, agentOverride, d);
      break;
    case "send":
      await agentSend(args.slice(2), provider, d);
      break;
    case "bye":
    case "quit":
      await agentBye(args.slice(2), provider, d);
      break;
    case "interrupt":
      await agentInterrupt(args.slice(2), provider, d);
      break;
    case "log":
      await agentLog(args.slice(2), provider, d);
      break;
    case "wait":
      await agentWait(args.slice(2), provider, agentOverride, d);
      break;
    case "resume":
      await agentResume(args.slice(2), provider, agentOverride, d);
      break;
    case "worktrees":
    case "wt":
      await agentWorktrees(args.slice(2), provider, d);
      break;
    case "approve":
      await agentApprove(args.slice(2), provider, d);
      break;
    case "deny":
      await agentDeny(args.slice(2), provider, d);
      break;
    default:
      d.printError(
        `Unknown ${providerName} subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", "wait", "resume", "approve", "deny", or "worktrees".`,
      );
      d.exit(1);
  }
}

// ── Spawn ──

interface AgentSpawnArgs {
  task: string | undefined;
  allow: string[];
  cwd: string | undefined;
  timeout: number | undefined;
  model: string | undefined;
  wait: boolean;
  json: boolean;
  worktree: string | undefined;
  headed: boolean;
  agent: string | undefined;
  provider: string | undefined;
  resume: string | undefined;
  error: string | undefined;
}

export function parseAgentSpawnArgs(
  args: string[],
  providerConfig: AgentProvider,
  agentOverride?: string,
): AgentSpawnArgs {
  let json = false;
  let worktree: string | undefined;
  let headed = false;
  let resume: string | undefined;
  let agent: string | undefined = agentOverride;
  let llmProvider: string | undefined;
  let extraError: string | undefined;

  const shared = parseSharedSpawnArgs(args, (arg, allArgs, i) => {
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
      worktree = `${providerConfig.name}-${Date.now().toString(36)}`;
      return 0;
    }
    if (arg === "--headed") {
      if (!hasFeature(providerConfig, "headed")) {
        extraError = `--headed is not supported by ${providerDisplayName(providerConfig)}`;
        return 0;
      }
      headed = true;
      return 0;
    }
    if (arg === "--agent" || arg === "-a") {
      if (!hasFeature(providerConfig, "agentSelect")) {
        extraError = `--agent is not supported by ${providerDisplayName(providerConfig)}`;
        return 0;
      }
      if (agentOverride) return 1; // Already set by wrapper
      const val = allArgs[i + 1];
      if (!val || val.startsWith("-")) {
        extraError = "--agent requires a value (e.g. copilot, gemini)";
        return 0;
      }
      agent = val;
      return 1;
    }
    if (arg === "--provider" || arg === "-p") {
      if (providerConfig.name !== "opencode") {
        extraError = `--provider is not supported by ${providerDisplayName(providerConfig)}`;
        return 0;
      }
      const val = allArgs[i + 1];
      if (!val || val.startsWith("-")) {
        extraError = "--provider requires a value (e.g. anthropic, openai, google)";
        return 0;
      }
      llmProvider = val;
      return 1;
    }
    if (arg === "--resume") {
      if (!hasFeature(providerConfig, "resume")) {
        extraError = `--resume is not supported by ${providerDisplayName(providerConfig)}`;
        return 1;
      }
      resume = allArgs[i + 1];
      if (!resume) {
        extraError = "--resume requires a session ID";
      }
      return 1;
    }
    return undefined;
  });

  return {
    ...shared,
    error: shared.error ?? extraError,
    json,
    worktree,
    headed,
    agent,
    provider: llmProvider,
    resume,
  };
}

async function agentSpawn(
  args: string[],
  provider: AgentProvider,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSpawnUsage(provider, agentOverride, d.log);
    return;
  }

  const parsed = parseAgentSpawnArgs(args, provider, agentOverride);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  // ACP requires --agent
  if (hasFeature(provider, "agentSelect") && !parsed.agent) {
    d.printError("--agent is required for ACP. Specify which agent to spawn (e.g. copilot, gemini).");
    d.exit(1);
  }

  if (!parsed.task && !parsed.resume) {
    const name = agentOverride ?? provider.name;
    d.printError(`Usage: mcx agent ${name} spawn --task "description" [options]`);
    d.exit(1);
  }

  if (parsed.headed) {
    if (parsed.resume) {
      d.printError("--headed and --resume are incompatible. Use headless spawn for session resume.");
      d.exit(1);
    }
    await agentSpawnHeaded(parsed, provider, d);
    return;
  }

  const P = provider.toolPrefix;
  const toolArgs: Record<string, unknown> = {
    prompt: parsed.task ?? "Continue from where you left off.",
  };
  if (parsed.resume) toolArgs.sessionId = parsed.resume;
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.cwd) toolArgs.cwd = parsed.cwd;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.wait) toolArgs.wait = true;
  if (parsed.agent) toolArgs.agent = parsed.agent;
  if (parsed.provider) toolArgs.provider = parsed.provider;

  // Handle worktree creation (shared across all providers)
  if (parsed.worktree) {
    setupWorktree(parsed.worktree, toolArgs, d);
  }

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  const text = formatToolResult(result);

  if (parsed.json) {
    d.log(text);
    return;
  }

  let parsed_data: { sessionId?: string } | undefined;
  try {
    parsed_data = JSON.parse(text) as { sessionId?: string };
  } catch {
    // Not JSON — daemon returned an error string. Route to stderr.
    d.printError(text);
    return;
  }
  if (parsed_data?.sessionId) {
    const label = providerDisplayName(provider, agentOverride);
    d.logError(`${label} session started: ${parsed_data.sessionId.slice(0, 8)}`);
  }
  d.log(text);
}

/** Shell-quote a string (wrap in single quotes, escape internal single quotes). */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._:/@=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function agentSpawnHeaded(parsed: AgentSpawnArgs, provider: AgentProvider, d: AgentDeps): Promise<void> {
  if (parsed.wait) {
    d.printError("--headed and --wait are incompatible. Headed sessions are interactive.");
    d.exit(1);
  }

  let cwd = parsed.cwd;
  if (parsed.worktree) {
    const repoRoot = d.getCwd();
    const wtConfig = readWorktreeConfig(repoRoot);
    const worktreePath = resolveWorktreePath(repoRoot, parsed.worktree, wtConfig);

    if (hasWorktreeHooks(wtConfig)) {
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

  // Build the CLI command for the headed provider
  const parts: string[] = [provider.name === "claude" ? "claude" : provider.name];
  if (parsed.task) parts.push("-p", shellQuote(parsed.task));
  if (parsed.model) parts.push("--model", shellQuote(parsed.model));
  if (parsed.allow.length > 0) parts.push("--allowedTools", ...parsed.allow.map(shellQuote));

  const command = cwd ? `cd ${shellQuote(cwd)} && ${parts.join(" ")}` : parts.join(" ");
  await d.ttyOpen([command]);
}

/** Set up a worktree for spawn — shared logic across all providers. */
function setupWorktree(worktreeName: string, toolArgs: Record<string, unknown>, d: AgentDeps): void {
  // Prefer getGitRoot() over getCwd(): it resolves to the main repo even when
  // invoked from a worktree, and works when core.bare=true is set on the
  // ambient repo (see #1243, #1206).
  const repoRoot = d.getGitRoot() ?? d.getCwd();
  const wtConfig = readWorktreeConfig(repoRoot);

  if (hasWorktreeHooks(wtConfig)) {
    const worktreePath = resolveWorktreePath(repoRoot, worktreeName, wtConfig);
    const hookEnv = buildHookEnv({ branch: worktreeName, path: worktreePath, cwd: repoRoot });
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
    toolArgs.worktree = worktreeName;
    toolArgs.repoRoot = repoRoot;
    d.printError(`Created worktree via hook: ${worktreePath}`);
  } else if (wtConfig?.branchPrefix === false) {
    const worktreePath = resolveWorktreePath(repoRoot, worktreeName, wtConfig);
    const { exitCode, stdout } = d.exec(["git", "worktree", "add", worktreePath, "-b", worktreeName, "HEAD"]);
    if (exitCode !== 0) {
      d.printError(`Failed to create worktree: ${stdout}`);
      d.exit(1);
    }
    toolArgs.cwd = worktreePath;
    toolArgs.worktree = worktreeName;
    toolArgs.repoRoot = repoRoot;
    d.printError(`Created worktree: ${worktreePath}`);
  } else {
    // Native worktree path (provider creates the worktree itself). We still
    // record repoRoot so session scoping, hook lookup at teardown, and
    // cross-repo filters work correctly (#1243).
    toolArgs.worktree = worktreeName;
    toolArgs.repoRoot = repoRoot;
  }
}

// ── List ──

async function agentList(
  args: string[],
  provider: AgentProvider,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  const P = provider.toolPrefix;
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr") && hasFeature(provider, "repoScoped");
  const showAll = args.includes("--all");

  const toolArgs: Record<string, unknown> = {};

  // Repo-scoped filtering (Claude only, unless --all)
  if (hasFeature(provider, "repoScoped") && !showAll) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) toolArgs.repoRoot = gitRoot;
  }

  // Agent filter for ACP variants
  const agentFilter = agentOverride ?? extractFlag(args, "--agent", "-a");
  if (agentFilter && hasFeature(provider, "agentSelect")) toolArgs.agent = agentFilter;

  const result = await d.callTool(`${P}_session_list`, toolArgs);
  const text = formatToolResult(result);

  if (json) {
    d.log(text);
    return;
  }

  let sessions: Array<Record<string, unknown>>;
  try {
    sessions = parseSessionList(text);
  } catch {
    d.log(text);
    return;
  }

  if (sessions.length === 0) {
    const label = agentOverride ?? providerDisplayName(provider);
    d.logError(`No active ${label} sessions.`);
    return;
  }

  if (short) {
    for (const s of sessions) {
      d.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
    }
    return;
  }

  // Gather diff stats and (optionally) PR status for worktree sessions in parallel
  const [diffStats, prStatuses] = await Promise.all([
    hasFeature(provider, "repoScoped")
      ? Promise.all(sessions.map((s) => (s.worktree ? d.getDiffStats(s.worktree as string) : Promise.resolve(null))))
      : Promise.resolve(sessions.map(() => null)),
    showPr
      ? Promise.all(sessions.map((s) => (s.worktree ? d.getPrStatus(s.worktree as string) : Promise.resolve(null))))
      : Promise.resolve(sessions.map(() => null)),
  ]);

  const hasAnyDiff = diffStats.some((stat) => stat !== null);
  const hasAnyPr = showPr && prStatuses.some((pr) => pr !== null);
  const showAgent = hasFeature(provider, "agentSelect") && !agentOverride;

  // Build header
  const agentHeader = showAgent ? ` ${"AGENT".padEnd(10)}` : "";
  const diffHeader = hasAnyDiff ? ` ${"DIFF".padEnd(16)}` : "";
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)}${agentHeader} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${diffHeader}${prHeader} CWD`;
  d.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = String(s.sessionId ?? "").slice(0, 8);
    const state = colorState(String(s.state ?? "unknown"));
    const agentCol = showAgent ? ` ${String(s.agent ?? "—").padEnd(10)}` : "";
    const model = String(s.model ?? "—").padEnd(16);
    const costVal = s.cost as number | null;
    const cost =
      hasFeature(provider, "costTracking") && costVal != null && costVal > 0
        ? `$${costVal.toFixed(4)}`.padEnd(8)
        : (hasFeature(provider, "costTracking") ? "—" : "N/A").padEnd(8);
    const tokens = (s.tokens as number) > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const diff = hasAnyDiff ? ` ${(diffStats[i] ?? "—").padEnd(16)}` : "";
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = String(s.cwd ?? "—");
    const age = formatAge(s.createdAt as number | null | undefined);
    const ageSuffix = age ? ` ${c.yellow}${age}${c.reset}` : "";
    d.log(
      `${c.cyan}${id}${c.reset}   ${state}${agentCol} ${model} ${cost} ${tokens}${diff}${pr} ${c.dim}${cwd}${c.reset}${ageSuffix}`,
    );
  }

  const staleWarning = d.getStaleDaemonWarning();
  if (staleWarning) {
    d.logError(`\n⚠ ${staleWarning}`);
  }
}

function formatPrStatus(pr: { number: number; state: string } | null): string {
  if (!pr) return "—";
  return `#${pr.number} ${pr.state}`;
}

/** Extract a flag value from args without consuming them. */
function extractFlag(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("-")) {
      return args[i + 1];
    }
  }
  return undefined;
}

// ── Send ──

async function agentSend(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
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
    d.printError(`Usage: mcx agent ${provider.name} send [--wait] <session-id> <message>`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const toolArgs: Record<string, unknown> = { sessionId, prompt: message };
  if (wait) toolArgs.wait = true;

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  d.log(formatToolResult(result));
}

// ── Bye ──

async function agentBye(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError(`Usage: mcx agent ${provider.name} bye <session-id>`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_bye`, { sessionId });

  const byeResult = parseByeResult(result);
  d.log(formatToolResult(result));

  if (byeResult.worktree) {
    if (byeResult.cwd) {
      cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
    } else if (hasFeature(provider, "resume")) {
      // Claude: daemon-created worktrees have cwd=null — resolve from local repo root
      const repoRoot = d.getCwd();
      const wtConfig = readWorktreeConfig(repoRoot);
      const worktreeCwd = resolveWorktreePath(repoRoot, byeResult.worktree, wtConfig);
      cleanupWorktree(byeResult.worktree, worktreeCwd, d, repoRoot);
    }
  }
}

// ── Interrupt ──

async function agentInterrupt(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError(`Usage: mcx agent ${provider.name} interrupt <session-id>`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_interrupt`, { sessionId });
  d.log(formatToolResult(result));
}

// ── Log ──

async function agentLog(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const { json, rest: r1 } = extractJsonFlag(args);
  const { full, rest: r2 } = extractFullFlag(r1);
  const { jq, rest: r3 } = extractJqFlag(r2);

  let sessionPrefix: string | undefined;
  let last = 20;
  let compact = false;
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
    } else if (arg === "--compact") {
      compact = true;
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  if (error) {
    d.printError(error);
    d.exit(1);
  }

  if (!sessionPrefix) {
    d.printError(
      `Usage: mcx agent ${provider.name} log <session-id> [--last N]${hasFeature(provider, "compactLog") ? " [--compact]" : ""}`,
    );
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const toolArgs: Record<string, unknown> = { sessionId, limit: last };
  if (compact && hasFeature(provider, "compactLog")) toolArgs.compact = true;
  const result = await d.callTool(`${P}_transcript`, toolArgs);
  const text = formatToolResult(result);

  if (json) {
    if (jq) {
      try {
        const data = JSON.parse(text);
        const filtered = await applyJqFilter(data, jq);
        d.log(JSON.stringify(filtered, null, 2));
      } catch (err) {
        d.printError(err instanceof Error ? err.message : String(err));
        d.exit(1);
      }
      return;
    }
    d.log(text);
    return;
  }

  let entries: Array<{ timestamp: number; direction: string; message: { type: string; [k: string]: unknown } }>;
  try {
    entries = JSON.parse(text);
  } catch {
    d.log(text);
    return;
  }

  const truncate = (s: string) => (full || s.length <= 200 ? s : `${s.slice(0, 200)}…`);

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const dir = entry.direction === "outbound" ? `${c.green}→${c.reset}` : `${c.cyan}←${c.reset}`;
    const type = entry.message.type ?? "unknown";
    d.log(`${c.dim}${time}${c.reset} ${dir} ${c.bold}${type}${c.reset}`);

    if ((type === "user" || type === "assistant") && entry.message.message) {
      const msg = entry.message.message as { content?: unknown };
      const summary = extractContentSummary(msg.content);
      if (summary) {
        d.log(`  ${type === "assistant" ? truncate(summary) : summary}`);
      }
    } else if (type === "result") {
      const res = entry.message as { result?: string };
      if (res.result) {
        d.log(`  ${c.dim}${truncate(res.result)}${c.reset}`);
      }
    }
  }
}

// ── Wait ──

async function agentWait(
  args: string[],
  provider: AgentProvider,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  const P = provider.toolPrefix;

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
    } else if (arg === "--all" || (arg === "-a" && !hasFeature(provider, "agentSelect"))) {
      all = true;
    } else if (!arg.startsWith("-")) {
      sessionPrefix = arg;
    }
  }

  if (error) {
    d.printError(error);
    d.exit(1);
  }

  const toolArgs: Record<string, unknown> = {};

  if (sessionPrefix) {
    const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
    toolArgs.sessionId = sessionId;
  }
  if (timeout) toolArgs.timeout = timeout;
  if (afterSeq !== undefined) toolArgs.afterSeq = afterSeq;

  // Repo-scoped filtering (Claude only)
  let repoFilter: string | undefined;
  if (hasFeature(provider, "repoScoped") && !all && !sessionPrefix) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) {
      toolArgs.repoRoot = gitRoot;
      repoFilter = gitRoot;
    }
  }

  const result = await d.callTool(`${P}_wait`, toolArgs);
  const text = formatToolResult(result);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    d.log(text);
    return;
  }

  // Unified { event?, sessions } shape (Claude)
  if (data && typeof data === "object" && "sessions" in data) {
    const unified = data as {
      event?: Record<string, unknown>;
      sessions: Array<Record<string, unknown>>;
    };
    if (repoFilter) {
      unified.sessions = unified.sessions.filter((s) => !s.repoRoot || s.repoRoot === repoFilter);
      if (unified.event?.session) {
        const eventRepo = (unified.event.session as Record<string, unknown>).repoRoot;
        if (eventRepo && eventRepo !== repoFilter) {
          unified.event = undefined;
        }
      }
    }
    if (!short) {
      d.log(JSON.stringify(unified, null, 2));
      return;
    }
    if (unified.event) {
      const evt = unified.event;
      const id = evt.sessionId ? String(evt.sessionId).slice(0, 8) : "—";
      const event = (evt.event as string) ?? "—";
      const costVal = evt.cost as number | undefined;
      const cost = costVal && costVal > 0 ? `$${costVal.toFixed(4)}` : "—";
      const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
      const preview = (evt.result as string) ? (evt.result as string).slice(0, 100) : "";
      d.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    } else {
      for (const s of unified.sessions) {
        d.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
      }
    }
    return;
  }

  // Cursor-based result with events array
  if (data && typeof data === "object" && "events" in data) {
    const waitResult = data as { seq: number; events: Array<Record<string, unknown>> };
    let events = waitResult.events;
    if (repoFilter) {
      events = events.filter((e) => {
        const repo = e.session && (e.session as Record<string, unknown>).repoRoot;
        return !repo || repo === repoFilter;
      });
    }
    if (!short) {
      waitResult.events = events;
      d.log(JSON.stringify(waitResult, null, 2));
      return;
    }
    for (const e of events) {
      const session = e.session as Record<string, unknown> | undefined;
      const id = session?.sessionId ? String(session.sessionId).slice(0, 8) : "—";
      const event = (e.event as string) ?? "—";
      const costVal = session?.cost as number | undefined;
      const cost = costVal && costVal > 0 ? `$${costVal.toFixed(4)}` : "—";
      const turns = session?.numTurns !== undefined ? String(session.numTurns) : "—";
      const preview = (e.result as string) ? (e.result as string).slice(0, 100) : "";
      d.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    }
    return;
  }

  // Timeout fallback: session list array (Codex/ACP/OpenCode)
  if (Array.isArray(data)) {
    if (!short) {
      d.log(text);
      return;
    }
    for (const s of data as Array<Record<string, unknown>>) {
      d.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
    }
    return;
  }

  // Single event result (Codex/ACP/OpenCode)
  if (!short) {
    d.log(text);
    return;
  }
  const evt = data as { sessionId?: string; event?: string; cost?: number; numTurns?: number; result?: string };
  const id = evt.sessionId ? evt.sessionId.slice(0, 8) : "—";
  const event = evt.event ?? "—";
  const costVal = evt.cost;
  const cost =
    hasFeature(provider, "costTracking") && costVal != null && costVal > 0
      ? `$${costVal.toFixed(4)}`
      : hasFeature(provider, "costTracking")
        ? "—"
        : "N/A";
  const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
  const preview = evt.result ? evt.result.slice(0, 100) : "";
  d.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
}

// ── Resume ──

interface AgentResumeArgs {
  target: string | undefined;
  sessionId: string | undefined;
  all: boolean;
  fresh: boolean;
  allow: string[];
  model: string | undefined;
  wait: boolean;
  timeout: number | undefined;
  error: string | undefined;
}

export function parseAgentResumeArgs(args: string[]): AgentResumeArgs {
  let all = false;
  let fresh = false;
  let wait = false;
  let timeout: number | undefined;
  let model: string | undefined;
  let error: string | undefined;
  const allow: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--fresh") {
      fresh = true;
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout" || arg === "-t") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (arg === "--model" || arg === "-m") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        error = "--model requires a value";
      } else {
        model = val;
      }
    } else if (arg === "--allow") {
      while (i + 1 < args.length && looksLikeToolName(args[i + 1])) {
        allow.push(args[++i]);
      }
      if (allow.length === 0) error = "--allow requires at least one tool pattern";
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  const target = positionals[0];
  const sessionId = positionals[1];

  if (fresh && sessionId) {
    error = "--fresh cannot be combined with an explicit session ID";
  } else if (!all && !target) {
    error =
      "Usage: mcx agent <provider> resume <worktree> [--fresh] [--model M] [--allow tools...]\n       mcx agent <provider> resume --all";
  }

  return { target, sessionId, all, fresh, allow, model, wait, timeout, error };
}

async function agentResume(
  args: string[],
  provider: AgentProvider,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  const parsed = parseAgentResumeArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const P = provider.toolPrefix;
  const cwd = d.getCwd();

  // List all worktrees
  let mcxWorktrees: ReturnType<typeof listMcxWorktrees>["worktrees"];
  let allWorktrees: ReturnType<typeof listMcxWorktrees>["allWorktrees"];
  let worktreeBase: string;
  try {
    const listed = listMcxWorktrees(cwd, d);
    mcxWorktrees = listed.worktrees;
    allWorktrees = listed.allWorktrees;
    worktreeBase = listed.worktreeBase;
  } catch (e) {
    d.printError(e instanceof WorktreeError ? e.message : String(e));
    d.exit(1);
    return; // unreachable
  }

  // Get active sessions to find orphaned worktrees
  let sessionWorktrees = new Set<string>();
  try {
    const result = await d.callTool(`${P}_session_list`, {});
    const text = formatToolResult(result);
    const sessions = parseSessionList(text);
    sessionWorktrees = new Set(sessions.filter((s) => s.worktree).map((s) => s.worktree as string));
  } catch (err) {
    // Only treat connection errors as "daemon not running"
    if (!isDaemonUnavailable(err)) throw err;
  }

  if (parsed.all) {
    const orphaned = mcxWorktrees.filter((wt) => {
      const wtName = wt.path.slice(`${worktreeBase}/`.length);
      return !sessionWorktrees.has(wtName);
    });

    if (orphaned.length === 0) {
      d.printError("No orphaned worktrees to resume.");
      return;
    }

    d.printError(`Resuming ${orphaned.length} orphaned worktree${orphaned.length === 1 ? "" : "s"}...`);

    for (const wt of orphaned) {
      try {
        await resumeAgentWorktree(wt, parsed, provider, d);
      } catch (err) {
        const wtName = wt.path.slice(`${worktreeBase}/`.length);
        d.printError(`Failed to resume "${wtName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return;
  }

  // Single worktree resume
  const target = parsed.target ?? "";
  const resolved = resolveWorktree(target, mcxWorktrees);

  if (!resolved) {
    const resolvedAll = resolveWorktree(target, allWorktrees);
    if (resolvedAll) {
      d.printError(`Worktree "${target}" exists but is not an mcx worktree (not under .claude/worktrees/).`);
    } else {
      d.printError(
        `No worktree matching "${target}". Use "mcx agent ${provider.name} worktrees" to list available worktrees.`,
      );
    }
    d.exit(1);
    return; // unreachable
  }

  // Check if it already has an active session
  const wtName = resolved.path.slice(`${worktreeBase}/`.length);
  if (sessionWorktrees.has(wtName)) {
    d.printError(
      `Worktree "${wtName}" already has an active session. Use "mcx agent ${provider.name} send" to interact with it.`,
    );
    d.exit(1);
    return; // unreachable
  }

  const skipped = await resumeAgentWorktree(resolved, parsed, provider, d);
  if (skipped) {
    d.exit(1);
    return; // unreachable
  }
}

/** Resume a worktree session. Returns true if skipped (e.g. branch already merged). */
async function resumeAgentWorktree(
  wt: { path: string; branch: string | null },
  parsed: AgentResumeArgs,
  provider: AgentProvider,
  d: AgentDeps,
): Promise<boolean> {
  const P = provider.toolPrefix;
  const branch = wt.branch;

  // Detached HEAD — skip merge check but warn
  if (!branch) {
    d.printError(`Warning: worktree at ${wt.path} has detached HEAD — skipping merge check`);
  }

  // Check if branch is already merged into the default branch
  const defaultBranch = getDefaultBranch(d, wt.path);
  if (branch) {
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
          `Skipping "${branch}" — already merged into ${defaultBranch}. Use "mcx agent ${provider.name} worktrees --prune" to clean up.`,
        );
        return true;
      }
    }
  }

  const toolArgs: Record<string, unknown> = { cwd: wt.path };
  if (parsed.allow.length > 0) toolArgs.allowedTools = parsed.allow;
  if (parsed.model) toolArgs.model = parsed.model;
  if (parsed.timeout) toolArgs.timeout = parsed.timeout;

  const useNativeResume = hasFeature(provider, "resume") && !parsed.fresh;

  if (useNativeResume) {
    // Native resume: restore conversation history (Claude only)
    toolArgs.resumeSessionId = parsed.sessionId ?? "continue";
    toolArgs.prompt =
      "Your previous conversation history has just been restored via --continue/--resume. " +
      "Please review the restored context and continue where you left off, picking up any in-progress work.";
    d.printError(`Resuming session in ${wt.path} (branch: ${branch ?? "detached"}) [restoring conversation history]`);
  } else {
    // Git-context shim: build prompt from git state
    const branchRef = branch ?? "HEAD";
    const { stdout: gitLog } = d.exec([
      "git",
      "-C",
      wt.path,
      "log",
      "--oneline",
      `${defaultBranch}..${branchRef}`,
      "--",
    ]);
    const { stdout: gitDiff } = d.exec(["git", "-C", wt.path, "diff", "--stat"]);

    const issueNumber = branch ? extractIssueNumber(branch) : null;

    let prInfo: string | null = null;
    const prStatus = await d.getPrStatus(wt.path);
    if (prStatus) {
      prInfo = `#${prStatus.number} (${prStatus.state})`;
    }

    toolArgs.prompt = buildResumePrompt({ branch: branchRef, issueNumber, gitLog, gitDiff, prInfo });
    d.printError(`Resuming session in ${wt.path} (branch: ${branch ?? "detached"}) [git context prompt]`);
  }

  const result = await d.callTool(`${P}_prompt`, toolArgs);
  const text = formatToolResult(result);
  console.log(text);

  // Client-side wait: block until session reaches idle/ended state
  if (parsed.wait) {
    let sessionId: string | undefined;
    try {
      const data = JSON.parse(text) as { sessionId?: string };
      sessionId = data.sessionId;
    } catch {
      // Not JSON — cannot wait without a session ID
    }
    if (sessionId) {
      const waitArgs: Record<string, unknown> = { sessionId };
      if (parsed.timeout) waitArgs.timeout = parsed.timeout;
      const waitResult = await d.callTool(`${P}_wait`, waitArgs);
      console.log(formatToolResult(waitResult));
    } else {
      d.printError("--wait specified but no sessionId in response — cannot wait");
    }
  }
  return false;
}

// ── Worktrees ──

async function agentWorktrees(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const prune = args.includes("--prune");
  const cwd = d.getCwd();

  let mcxWorktrees: ReturnType<typeof listMcxWorktrees>["worktrees"];
  let worktreeBase: string;
  try {
    const listed = listMcxWorktrees(cwd, d);
    mcxWorktrees = listed.worktrees;
    worktreeBase = listed.worktreeBase;
  } catch (e) {
    d.printError(e instanceof WorktreeError ? e.message : String(e));
    d.exit(1);
    return; // unreachable
  }

  // Get active sessions
  let sessionWorktrees = new Set<string>();
  try {
    const result = await d.callTool(`${P}_session_list`, {});
    const text = formatToolResult(result);
    const sessions = parseSessionList(text);
    sessionWorktrees = new Set(sessions.filter((s) => s.worktree).map((s) => s.worktree as string));
  } catch (err) {
    // Only treat connection errors as "daemon not running"
    if (!isDaemonUnavailable(err)) throw err;
  }

  if (prune) {
    const { pruned, skippedUnmerged } = pruneWorktrees({
      repoRoot: cwd,
      activeWorktrees: sessionWorktrees,
      deps: d,
    });
    if (pruned > 0) {
      d.printError(`Pruned ${pruned} worktree${pruned === 1 ? "" : "s"}.`);
    } else {
      d.printError("Nothing to prune.");
    }
    if (skippedUnmerged.length > 0) {
      d.printError(`Skipped unmerged: ${skippedUnmerged.join(", ")}`);
    }
    return;
  }

  if (mcxWorktrees.length === 0) {
    d.printError("No mcx worktrees found.");
    return;
  }

  // Gather diff stats in parallel
  const diffStats = await Promise.all(mcxWorktrees.map((wt) => d.getDiffStats(wt.path)));

  const header = `${"WORKTREE".padEnd(30)} ${"BRANCH".padEnd(30)} ${"STATUS".padEnd(10)} DIFF`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < mcxWorktrees.length; i++) {
    const wt = mcxWorktrees[i];
    const wtName = wt.path.slice(`${worktreeBase}/`.length);
    const branch = wt.branch ?? "—";
    const isActive = sessionWorktrees.has(wtName);
    const statusLabel = isActive ? "active" : "orphaned";
    const statusColor = isActive ? c.green : c.yellow;
    const status = `${statusColor}${statusLabel.padEnd(10)}${c.reset}`;
    const diff = diffStats[i] ?? "—";
    console.log(`${c.cyan}${wtName.padEnd(30)}${c.reset} ${branch.padEnd(30)} ${status} ${c.dim}${diff}${c.reset}`);
  }
}

// ── Usage ──

// ── Approve / Deny ──

async function agentApprove(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const { sessionPrefix, requestId } = parseApproveArgs(args, d);

  const { sessionId, resolvedRequestId } = await resolvePermissionTarget(
    sessionPrefix,
    requestId,
    d,
    `${P}_session_list`,
  );
  const result = await d.callTool(`${P}_approve`, { sessionId, requestId: resolvedRequestId });
  console.log(formatToolResult(result));
}

async function agentDeny(args: string[], provider: AgentProvider, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const { sessionPrefix, requestId, message } = parseDenyArgs(args, d);

  const { sessionId, resolvedRequestId } = await resolvePermissionTarget(
    sessionPrefix,
    requestId,
    d,
    `${P}_session_list`,
  );
  const toolArgs: Record<string, unknown> = { sessionId, requestId: resolvedRequestId };
  if (message) toolArgs.message = message;
  const result = await d.callTool(`${P}_deny`, toolArgs);
  console.log(formatToolResult(result));
}

function printAgentUsage(log: ((...args: unknown[]) => void) | undefined = console.log): void {
  const out = log ?? console.log;
  const providers = getAllProviders()
    .filter((p) => !["copilot", "gemini"].includes(p.name))
    .map((p) => p.name);
  out(`mcx agent — unified command for all agent providers

Usage:
  mcx agent <provider> <subcommand> [options]

Providers:
  ${providers.join(", ")}
  Also: copilot, gemini (ACP aliases)

Examples:
  mcx agent claude spawn -t "fix the bug"
  mcx agent codex ls --short
  mcx agent copilot wait --timeout 30000
  mcx agent gemini bye <session>

Run "mcx agent <provider> --help" for provider-specific subcommands.`);
}

function printProviderUsage(
  provider: AgentProvider,
  name: string,
  agentOverride: string | undefined,
  log: (...args: unknown[]) => void = console.log,
): void {
  const label = agentOverride ?? providerDisplayName(provider);
  const resumeNote = hasFeature(provider, "resume")
    ? "Resume with conversation history"
    : "Resume with git-context prompt";

  log(`mcx agent ${name} — manage ${label} sessions

Usage:
  mcx agent ${name} spawn --task "description"   Start a new session
  mcx agent ${name} ls [--short] [--json]        List active sessions
  mcx agent ${name} send <session> <message>     Send follow-up prompt
  mcx agent ${name} wait [session]               Block until session event
  mcx agent ${name} bye <session>                End session
  mcx agent ${name} interrupt <session>          Interrupt current turn
  mcx agent ${name} log <session> [--last N]     View transcript
  mcx agent ${name} resume <worktree>            ${resumeNote}
  mcx agent ${name} approve <session> [req-id]  Approve pending permission request
  mcx agent ${name} deny <session> [req-id]     Deny pending permission request
  mcx agent ${name} worktrees [--prune]          List mcx-created worktrees

Run "mcx agent ${name} spawn --help" for spawn options.`);
}

function printSpawnUsage(
  provider: AgentProvider,
  agentOverride: string | undefined,
  log: (...args: unknown[]) => void = console.log,
): void {
  const name = agentOverride ?? provider.name;
  const lines: string[] = [
    `mcx agent ${name} spawn — Start a new ${agentOverride ?? providerDisplayName(provider)} session`,
    "",
    "Options:",
    `  --task, -t <string>        Task prompt for the session (required${hasFeature(provider, "resume") ? " unless --resume" : ""})`,
    "  --worktree, -w [name]      Run in a git worktree for branch isolation",
    "  --allow <tools...>         Space-separated tool patterns to auto-approve",
    "  --model, -m <name>         Model (default: provider default)",
    "  --cwd <path>               Working directory",
    "  --wait                     Block until result",
    "  --timeout <ms>             Max wait time (default: 300000)",
    "  --json                     Output raw JSON",
  ];

  if (hasFeature(provider, "resume")) {
    lines.push("  --resume <id>              Resume a previous session by ID");
  }
  if (hasFeature(provider, "headed")) {
    lines.push("  --headed                   Open in a visible terminal tab");
  }
  if (hasFeature(provider, "agentSelect") && !agentOverride) {
    lines.push("  --agent, -a <name>         ACP agent to spawn (e.g. copilot, gemini)");
  }
  if (provider.name === "opencode") {
    lines.push("  --provider, -p <name>      LLM provider (e.g. anthropic, openai, google)");
  }

  log(lines.join("\n"));
}
