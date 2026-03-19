/**
 * `mcx agent <provider> <subcommand>` — unified command for all agent providers.
 *
 * Dispatches subcommands parameterized by the provider registry, eliminating
 * the duplication across claude.ts, codex.ts, acp.ts, opencode.ts.
 *
 * Subcommands: spawn, ls, send, bye, wait, interrupt, log, resume, worktrees
 * Provider-specific flags (--headed, --agent, --provider) are gated by feature flags.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentProviderConfig } from "@mcp-cli/core";
import {
  PROMPT_IPC_TIMEOUT_MS,
  buildHookEnv,
  getProvider,
  hasWorktreeHooks,
  listProviders,
  readWorktreeConfig,
  resolveWorktreePath,
} from "@mcp-cli/core";
import { getStaleDaemonWarning, ipcCall } from "../daemon-lifecycle";
import { applyJqFilter } from "../jq/index";
import { c, printError as defaultPrintError, formatToolResult } from "../output";
import { extractFullFlag, extractJqFlag, extractJsonFlag } from "../parse";
import { type SharedSessionDeps, cleanupWorktree, parseByeResult, resolveSessionId } from "./claude";
import { colorState, extractContentSummary, formatSessionShort } from "./session-display";
import { parseSharedSpawnArgs } from "./spawn-args";
import { ttyOpen } from "./tty";

// ── Dependency injection ──

export interface AgentDeps extends SharedSessionDeps {
  getStaleDaemonWarning: () => string | null;
  /** Resolve the git repo root for the current working directory. */
  getGitRoot: () => string | null;
  /** Get diff stats for a worktree path. */
  getDiffStats: (worktreePath: string) => Promise<string | null>;
  /** Get PR status for a worktree path. */
  getPrStatus: (worktreePath: string) => Promise<{ number: number; state: string } | null>;
  /** Open a command in a terminal tab/window. */
  ttyOpen: (args: string[]) => Promise<void>;
}

function makeCallTool(
  provider: AgentProviderConfig,
): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  const p = provider.toolPrefix;
  return (tool, args) => {
    const needsLongTimeout = (tool === `${p}_prompt` && args.wait) || tool === `${p}_wait`;
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

export function makeDefaultDeps(provider: AgentProviderConfig): AgentDeps {
  return {
    callTool: makeCallTool(provider),
    printError: defaultPrintError,
    exit: (code) => process.exit(code),
    getStaleDaemonWarning,
    getGitRoot,
    getDiffStats: defaultGetDiffStats,
    getPrStatus: defaultGetPrStatus,
    ttyOpen: (args) => ttyOpen(args),
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
    printAgentUsage();
    return;
  }

  const provider = getProvider(providerName);
  if (!provider) {
    const available = listProviders().join(", ");
    (deps?.printError ?? defaultPrintError)(`Unknown provider: ${providerName}. Available: ${available}`);
    (deps?.exit ?? ((code: number) => process.exit(code)))(1);
    return; // unreachable but helps TS
  }

  // For copilot/gemini, the provider resolves to ACP — set the agent override
  const agentOverride = providerName !== provider.name ? providerName : undefined;

  const d: AgentDeps = { ...makeDefaultDeps(provider), ...deps };
  // Override callTool if deps provided their own (testing)
  if (deps?.callTool) d.callTool = deps.callTool;

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    printProviderUsage(provider, providerName, agentOverride);
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
      if (!provider.features.resume) {
        d.printError(
          `"${providerName}" does not support resume. Only providers with native session resume support this.`,
        );
        d.exit(1);
      }
      // Resume is Claude-specific — delegate to the existing cmdClaude
      d.printError(`Use "mcx claude resume" for session resume — it requires Claude-specific features.`);
      d.exit(1);
      break;
    case "worktrees":
    case "wt":
      if (!provider.features.resume) {
        d.printError(`Use "mcx claude worktrees" for worktree management — it requires Claude-specific features.`);
        d.exit(1);
      }
      d.printError(`Use "mcx claude worktrees" for worktree management.`);
      d.exit(1);
      break;
    default:
      d.printError(
        `Unknown ${providerName} subcommand: ${sub}. Use "spawn", "ls", "send", "bye", "interrupt", "log", or "wait".`,
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
  error: string | undefined;
}

export function parseAgentSpawnArgs(
  args: string[],
  providerConfig: AgentProviderConfig,
  agentOverride?: string,
): AgentSpawnArgs {
  let json = false;
  let worktree: string | undefined;
  let headed = false;
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
      if (!providerConfig.features.headed) {
        extraError = `--headed is not supported by ${providerConfig.displayName}`;
        return 0;
      }
      headed = true;
      return 0;
    }
    if (arg === "--agent" || arg === "-a") {
      if (!providerConfig.features.agentSelect) {
        extraError = `--agent is not supported by ${providerConfig.displayName}`;
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
      if (!providerConfig.features.providerSelect) {
        extraError = `--provider is not supported by ${providerConfig.displayName}`;
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
      // Claude-specific: not handled in unified spawn, but consume the arg
      extraError = 'Use "mcx claude spawn --resume" for session resume';
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
  };
}

async function agentSpawn(
  args: string[],
  provider: AgentProviderConfig,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSpawnUsage(provider, agentOverride);
    return;
  }

  const parsed = parseAgentSpawnArgs(args, provider, agentOverride);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  // ACP requires --agent
  if (provider.features.agentSelect && !parsed.agent) {
    d.printError("--agent is required for ACP. Specify which agent to spawn (e.g. copilot, gemini).");
    d.exit(1);
  }

  if (!parsed.task) {
    const name = agentOverride ?? provider.name;
    d.printError(`Usage: mcx agent ${name} spawn --task "description" [options]`);
    d.exit(1);
  }

  if (parsed.headed) {
    await agentSpawnHeaded(parsed, provider, d);
    return;
  }

  const P = provider.toolPrefix;
  const toolArgs: Record<string, unknown> = { prompt: parsed.task };
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
    console.log(text);
    return;
  }

  try {
    const data = JSON.parse(text) as { sessionId?: string };
    if (data.sessionId) {
      const label = agentOverride
        ? agentOverride.charAt(0).toUpperCase() + agentOverride.slice(1)
        : provider.displayName;
      console.error(`${label} session started: ${data.sessionId.slice(0, 8)}`);
    }
  } catch {
    // Not JSON — fall through
  }
  console.log(text);
}

/** Shell-quote a string (wrap in single quotes, escape internal single quotes). */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._:/@=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function agentSpawnHeaded(parsed: AgentSpawnArgs, provider: AgentProviderConfig, d: AgentDeps): Promise<void> {
  if (parsed.wait) {
    d.printError("--headed and --wait are incompatible. Headed sessions are interactive.");
    d.exit(1);
  }

  let cwd = parsed.cwd;
  if (parsed.worktree) {
    const repoRoot = process.cwd();
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
  const repoRoot = process.cwd();
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
    toolArgs.worktree = worktreeName;
  }
}

// ── List ──

async function agentList(
  args: string[],
  provider: AgentProviderConfig,
  agentOverride: string | undefined,
  d: AgentDeps,
): Promise<void> {
  const P = provider.toolPrefix;
  const { json } = extractJsonFlag(args);
  const short = args.includes("--short");
  const showPr = args.includes("--pr");
  const showAll = args.includes("--all") || args.includes("-a");

  const toolArgs: Record<string, unknown> = {};

  // Repo-scoped filtering (Claude only, unless --all)
  if (provider.features.repoScoped && !showAll) {
    const gitRoot = d.getGitRoot();
    if (gitRoot) toolArgs.repoRoot = gitRoot;
  }

  // Agent filter for ACP variants
  const agentFilter = agentOverride ?? extractFlag(args, "--agent", "-a");
  if (agentFilter && provider.features.agentSelect) toolArgs.agent = agentFilter;

  const result = await d.callTool(`${P}_session_list`, toolArgs);
  const text = formatToolResult(result);

  if (json) {
    console.log(text);
    return;
  }

  let sessions: Array<Record<string, unknown>>;
  try {
    sessions = JSON.parse(text);
  } catch {
    console.log(text);
    return;
  }

  if (sessions.length === 0) {
    const label = agentOverride ?? provider.displayName;
    console.error(`No active ${label} sessions.`);
    return;
  }

  if (short) {
    for (const s of sessions) {
      console.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
    }
    return;
  }

  // Gather diff stats and (optionally) PR status for worktree sessions in parallel
  const [diffStats, prStatuses] = await Promise.all([
    provider.features.repoScoped
      ? Promise.all(sessions.map((s) => (s.worktree ? d.getDiffStats(s.worktree as string) : Promise.resolve(null))))
      : Promise.resolve(sessions.map(() => null)),
    showPr
      ? Promise.all(sessions.map((s) => (s.worktree ? d.getPrStatus(s.worktree as string) : Promise.resolve(null))))
      : Promise.resolve(sessions.map(() => null)),
  ]);

  const hasAnyDiff = diffStats.some((stat) => stat !== null);
  const hasAnyPr = showPr && prStatuses.some((pr) => pr !== null);
  const showAgent = provider.features.agentSelect && !agentOverride;

  // Build header
  const agentHeader = showAgent ? ` ${"AGENT".padEnd(10)}` : "";
  const diffHeader = hasAnyDiff ? ` ${"DIFF".padEnd(16)}` : "";
  const prHeader = hasAnyPr ? ` ${"PR".padEnd(12)}` : "";
  const header = `${"SESSION".padEnd(10)} ${"STATE".padEnd(12)}${agentHeader} ${"MODEL".padEnd(16)} ${"COST".padEnd(8)} ${"TOKENS".padEnd(10)}${diffHeader}${prHeader} CWD`;
  console.log(`${c.dim}${header}${c.reset}`);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const id = String(s.sessionId ?? "").slice(0, 8);
    const state = colorState(String(s.state ?? "unknown"));
    const agentCol = showAgent ? ` ${String(s.agent ?? "—").padEnd(10)}` : "";
    const model = String(s.model ?? "—").padEnd(16);
    const costVal = s.cost as number | null;
    const cost =
      provider.features.costTracking && costVal != null && costVal > 0
        ? `$${costVal.toFixed(4)}`.padEnd(8)
        : (provider.features.costTracking ? "—" : "N/A").padEnd(8);
    const tokens = (s.tokens as number) > 0 ? String(s.tokens).padEnd(10) : "—".padEnd(10);
    const diff = hasAnyDiff ? ` ${(diffStats[i] ?? "—").padEnd(16)}` : "";
    const pr = hasAnyPr ? ` ${formatPrStatus(prStatuses[i]).padEnd(12)}` : "";
    const cwd = String(s.cwd ?? "—");
    console.log(
      `${c.cyan}${id}${c.reset}   ${state}${agentCol} ${model} ${cost} ${tokens}${diff}${pr} ${c.dim}${cwd}${c.reset}`,
    );
  }

  const staleWarning = d.getStaleDaemonWarning();
  if (staleWarning) {
    console.error(`\n⚠ ${staleWarning}`);
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

async function agentSend(args: string[], provider: AgentProviderConfig, d: AgentDeps): Promise<void> {
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
  console.log(formatToolResult(result));
}

// ── Bye ──

async function agentBye(args: string[], provider: AgentProviderConfig, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError(`Usage: mcx agent ${provider.name} bye <session-id>`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_bye`, { sessionId });

  const byeResult = parseByeResult(result);
  console.log(formatToolResult(result));

  if (byeResult.worktree) {
    if (byeResult.cwd) {
      cleanupWorktree(byeResult.worktree, byeResult.cwd, d, byeResult.repoRoot);
    } else if (provider.features.resume) {
      // Claude: daemon-created worktrees have cwd=null — resolve from local repo root
      const repoRoot = process.cwd();
      const wtConfig = readWorktreeConfig(repoRoot);
      const cwd = resolveWorktreePath(repoRoot, byeResult.worktree, wtConfig);
      cleanupWorktree(byeResult.worktree, cwd, d, repoRoot);
    }
  }
}

// ── Interrupt ──

async function agentInterrupt(args: string[], provider: AgentProviderConfig, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
  const sessionPrefix = args[0];

  if (!sessionPrefix) {
    d.printError(`Usage: mcx agent ${provider.name} interrupt <session-id>`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_interrupt`, { sessionId });
  console.log(formatToolResult(result));
}

// ── Log ──

async function agentLog(args: string[], provider: AgentProviderConfig, d: AgentDeps): Promise<void> {
  const P = provider.toolPrefix;
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

  if (error) {
    d.printError(error);
    d.exit(1);
  }

  if (!sessionPrefix) {
    d.printError(`Usage: mcx agent ${provider.name} log <session-id> [--last N]`);
    d.exit(1);
  }

  const sessionId = await resolveSessionId(sessionPrefix, d, `${P}_session_list`);
  const result = await d.callTool(`${P}_transcript`, { sessionId, limit: last });
  const text = formatToolResult(result);

  if (json) {
    if (jq) {
      try {
        const data = JSON.parse(text);
        const filtered = await applyJqFilter(data, jq);
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

  const truncate = (s: string) => (full || s.length <= 200 ? s : `${s.slice(0, 200)}…`);

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

async function agentWait(
  args: string[],
  provider: AgentProviderConfig,
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
    } else if (arg === "--all" || (arg === "-a" && !provider.features.agentSelect)) {
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
  if (provider.features.repoScoped && !all && !sessionPrefix) {
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
    console.log(text);
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
      console.log(JSON.stringify(unified, null, 2));
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
      console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    } else {
      for (const s of unified.sessions) {
        console.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
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
      console.log(JSON.stringify(waitResult, null, 2));
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
      console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
    }
    return;
  }

  // Timeout fallback: session list array (Codex/ACP/OpenCode)
  if (Array.isArray(data)) {
    if (!short) {
      console.log(text);
      return;
    }
    for (const s of data as Array<Record<string, unknown>>) {
      console.log(formatSessionShort(s as Parameters<typeof formatSessionShort>[0]));
    }
    return;
  }

  // Single event result (Codex/ACP/OpenCode)
  if (!short) {
    console.log(text);
    return;
  }
  const evt = data as { sessionId?: string; event?: string; cost?: number; numTurns?: number; result?: string };
  const id = evt.sessionId ? evt.sessionId.slice(0, 8) : "—";
  const event = evt.event ?? "—";
  const costVal = evt.cost;
  const cost =
    provider.features.costTracking && costVal != null && costVal > 0
      ? `$${costVal.toFixed(4)}`
      : provider.features.costTracking
        ? "—"
        : "N/A";
  const turns = evt.numTurns !== undefined ? String(evt.numTurns) : "—";
  const preview = evt.result ? evt.result.slice(0, 100) : "";
  console.log(`${id} ${event} ${cost} ${turns}${preview ? ` ${preview}` : ""}`);
}

// ── Usage ──

function printAgentUsage(): void {
  const providers = listProviders();
  console.log(`mcx agent — unified command for all agent providers

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

function printProviderUsage(provider: AgentProviderConfig, name: string, agentOverride?: string): void {
  const label = agentOverride ?? provider.displayName;
  const resumeLine = provider.features.resume
    ? `\n  mcx agent ${name} resume <worktree>        Resume with conversation history
  mcx agent ${name} worktrees                 List mcx-created worktrees`
    : "";

  console.log(`mcx agent ${name} — manage ${label} sessions

Usage:
  mcx agent ${name} spawn --task "description"   Start a new session
  mcx agent ${name} ls [--short] [--json]        List active sessions
  mcx agent ${name} send <session> <message>     Send follow-up prompt
  mcx agent ${name} wait [session]               Block until session event
  mcx agent ${name} bye <session>                End session
  mcx agent ${name} interrupt <session>          Interrupt current turn
  mcx agent ${name} log <session> [--last N]     View transcript${resumeLine}

Run "mcx agent ${name} spawn --help" for spawn options.`);
}

function printSpawnUsage(provider: AgentProviderConfig, agentOverride?: string): void {
  const name = agentOverride ?? provider.name;
  const lines: string[] = [
    `mcx agent ${name} spawn — Start a new ${agentOverride ?? provider.displayName} session`,
    "",
    "Options:",
    "  --task, -t <string>        Task prompt for the session (required)",
    "  --worktree, -w [name]      Run in a git worktree for branch isolation",
    "  --allow <tools...>         Space-separated tool patterns to auto-approve",
    "  --model, -m <name>         Model (default: provider default)",
    "  --cwd <path>               Working directory",
    "  --wait                     Block until result",
    "  --timeout <ms>             Max wait time (default: 300000)",
    "  --json                     Output raw JSON",
  ];

  if (provider.features.headed) {
    lines.push("  --headed                   Open in a visible terminal tab");
  }
  if (provider.features.agentSelect && !agentOverride) {
    lines.push("  --agent, -a <name>         ACP agent to spawn (e.g. copilot, gemini)");
  }
  if (provider.features.providerSelect) {
    lines.push("  --provider, -p <name>      LLM provider (e.g. anthropic, openai, google)");
  }

  console.log(lines.join("\n"));
}
