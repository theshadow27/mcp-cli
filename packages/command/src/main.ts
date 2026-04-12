#!/usr/bin/env bun
/**
 * mcx — MCP CLI
 *
 * Call MCP server tools from the command line.
 * Talks to mcpd daemon via Unix socket for connection management.
 *
 * Usage:
 *   mcx ls                                      # list servers
 *   mcx ls <server>                              # list tools for a server
 *   mcx call <server> <tool> [json|@file]        # call a tool
 *   mcx info <server> <tool>                     # show tool schema
 *   mcx grep <pattern>                           # search tools
 *   mcx status                                   # daemon status
 */

import type { DaemonStatus, QuotaStatusResult, ServerStatus } from "@mcp-cli/core";
import {
  IpcCallError,
  MCP_TOOL_TIMEOUT_MS,
  PING_TIMEOUT_MS,
  ProtocolMismatchError,
  VERSION,
  maybeShowTelemetryNotice,
  recordCommand,
} from "@mcp-cli/core";
import { cmdAdd, cmdAddJson } from "./commands/add";
import { cmdAgent } from "./commands/agent";
import { cmdAlias } from "./commands/alias";
import { cmdAuth } from "./commands/auth";
import { cmdClaude } from "./commands/claude";
import { cmdCompletions } from "./commands/completions";
import { cmdConfig } from "./commands/config";
import { cmdDump } from "./commands/dump";
import { cmdExport } from "./commands/export";
import { cmdGc } from "./commands/gc";
import { cmdGet } from "./commands/get";
import { isGitRemoteHelperInvocation, runGitRemoteHelper } from "./commands/git-remote-helper";
import { cmdAddFromClaudeDesktop, cmdImport } from "./commands/import";
import { cmdInstall } from "./commands/install";
import { cmdLogs } from "./commands/logs";
import { cmdMail } from "./commands/mail";
import { cmdNote } from "./commands/note";
import { cmdPhase } from "./commands/phase";
import { cmdRegistryDispatch } from "./commands/registry-cmd";
import { cmdRemove } from "./commands/remove";
import { cmdRun } from "./commands/run";
import { cmdScope } from "./commands/scope";
import { cmdServe } from "./commands/serve";
import { cmdServeKill } from "./commands/serve-kill";
import { cmdSpans } from "./commands/spans";
import { cmdTelemetry } from "./commands/telemetry";
import { cmdTrack, cmdTracked, cmdUntrack } from "./commands/track";
import { cmdTty } from "./commands/tty";
import { cmdTypegen } from "./commands/typegen";
import { cmdUpdate } from "./commands/update";
import { cmdUpgrade } from "./commands/upgrade";
import { cmdVersion } from "./commands/version";
import { cmdVfs } from "./commands/vfs";
import {
  ShutdownRefusedError,
  getSourceStalenessWarning,
  getStaleDaemonWarning,
  ipcCall,
  isDaemonInitializing,
  isDaemonRunning,
  stopDaemon,
} from "./daemon-lifecycle";
import { checkDeprecatedName } from "./deprecation";
import { maybeAutoSaveEphemeral } from "./ephemeral";
import { readFileWithLimit } from "./file-read";
import { maybeShowFirstRunPrompt } from "./first-run";
import { SIZE_HINT, SIZE_OK, applyJqFilter, generateAnalysis } from "./jq/index";
import {
  extractErrorMessage,
  formatToolResult,
  printError,
  printRegistryList,
  printServerList,
  printToolInfo,
  printToolList,
  printToolResult,
} from "./output";
import {
  extractDryRunFlag,
  extractFullFlag,
  extractJqFlag,
  extractJsonFlag,
  extractQuietFlag,
  extractTimeoutFlag,
  extractVerboseFlag,
  readStdinJson,
  splitServerTool,
} from "./parse";
import { searchRegistry } from "./registry/client";

/** Module-level dry-run flag — avoids env var propagation to child processes (Bun.spawn inherits env) */
let _dryRun = false;

async function main(): Promise<void> {
  // When invoked via the `git-remote-mcx` symlink, git passes the remote
  // name + URL on argv and drives the helper protocol on stdin/stdout.
  // This check must run before any normal CLI dispatch.
  if (isGitRemoteHelperInvocation(process.argv[1] ?? "")) {
    try {
      await runGitRemoteHelper();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
    return;
  }

  checkDeprecatedName(process.argv[1] ?? "");
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`mcp-cli ${VERSION}`);
    return;
  }

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  // Extract global flags before command dispatch
  const { verbose, rest: afterVerbose } = extractVerboseFlag(args);
  const { dryRun, rest: afterDryRun } = extractDryRunFlag(afterVerbose);
  const { quiet, rest: cleanArgs } = extractQuietFlag(afterDryRun);
  _dryRun = dryRun;
  if (verbose) process.env.MCX_VERBOSE = "1";

  const command = cleanArgs[0];

  // First-run prompt: show once per directory when .mcp.json detected
  if (!quiet) {
    try {
      maybeShowFirstRunPrompt();
    } catch {
      // Best-effort — never block CLI startup
    }
  }

  // First-run telemetry notice — show once, before any data is sent
  if (!quiet) {
    maybeShowTelemetryNotice();
  }

  // Fire-and-forget telemetry — never blocks, never throws
  // Skip for the telemetry command itself (don't track opt-out attempts)
  if (command !== "telemetry") {
    recordCommand(command, cleanArgs[1]);
  }

  // --dry-run is only valid for call (and shorthand call forms handled in the default branch)
  // and for commands that opt in (gc).
  if (dryRun && command && command !== "call" && command !== "gc") {
    const isShorthand =
      !command.startsWith("-") &&
      (splitServerTool(command) !== null || (cleanArgs.length >= 2 && !cleanArgs[1].startsWith("-")));
    if (!isShorthand) {
      printError(`--dry-run is only supported for the 'call' command, not '${command}'`);
      process.exit(1);
    }
  }

  try {
    switch (command) {
      case "ls":
      case "list":
      case "tools":
        await cmdLs(cleanArgs.slice(1));
        break;

      case "call":
        await cmdCall(cleanArgs.slice(1));
        break;

      case "info":
        await cmdInfo(cleanArgs.slice(1));
        break;

      case "grep":
      case "find":
        await cmdGrep(cleanArgs.slice(1));
        break;

      case "search": {
        const { json: searchJson, rest: searchRest } = extractJsonFlag(cleanArgs.slice(1));
        const searchPattern = searchRest.join(" ");
        if (!searchPattern) {
          printError("Usage: mcx search <query>");
          process.exit(1);
        }
        const searchTools = await ipcCall("grepTools", { pattern: searchPattern });
        if (searchTools.length > 0) {
          if (searchJson) {
            console.log(JSON.stringify(searchTools, null, 2));
          } else {
            printToolList(searchTools);
          }
        } else {
          try {
            const registryResult = await searchRegistry(searchPattern, { limit: 20 });
            if (registryResult.servers.length > 0) {
              if (searchJson) {
                console.log(JSON.stringify(registryResult.servers, null, 2));
              } else {
                console.error("No local tools matched. Registry results:\n");
                printRegistryList(registryResult.servers);
              }
            } else {
              console.error("No results found locally or in the registry.");
            }
          } catch {
            console.error("No local tools matched. (Registry unavailable.)");
          }
        }
        break;
      }

      case "import":
        await cmdImport(cleanArgs.slice(1));
        break;

      case "export":
        await cmdExport(cleanArgs.slice(1));
        break;

      case "install":
        await cmdInstall(cleanArgs.slice(1));
        break;

      case "update":
        await cmdUpdate(cleanArgs.slice(1));
        break;

      case "upgrade":
        await cmdUpgrade(cleanArgs.slice(1));
        break;

      case "registry":
        await cmdRegistryDispatch(cleanArgs.slice(1));
        break;

      case "version":
        await cmdVersion(cleanArgs.slice(1));
        break;

      case "status":
        await cmdStatus(cleanArgs.slice(1));
        break;

      case "metrics":
        await cmdMetrics(cleanArgs.slice(1));
        break;

      case "dump":
        await cmdDump(cleanArgs.slice(1));
        break;

      case "config":
        await cmdConfig(cleanArgs.slice(1));
        break;

      case "telemetry":
        cmdTelemetry(cleanArgs.slice(1));
        break;

      case "add":
        await cmdAdd(cleanArgs.slice(1));
        break;

      case "add-json":
        await cmdAddJson(cleanArgs.slice(1));
        break;

      case "add-from-claude-desktop":
        await cmdAddFromClaudeDesktop(cleanArgs.slice(1));
        break;

      case "remove":
        await cmdRemove(cleanArgs.slice(1));
        break;

      case "get":
        await cmdGet(cleanArgs.slice(1));
        break;

      case "gc":
        await cmdGc(cleanArgs.slice(1), { dryRun: _dryRun });
        break;

      case "phase":
        await cmdPhase(cleanArgs.slice(1));
        break;

      case "auth":
        await cmdAuth(cleanArgs.slice(1));
        break;

      case "alias":
        await cmdAlias(cleanArgs.slice(1));
        break;

      case "aliases":
        await cmdAlias(["ls", ...cleanArgs.slice(1)]);
        break;

      case "save":
        await cmdAlias(["save", ...cleanArgs.slice(1)]);
        break;

      case "run": {
        const { _recordPromise } = await cmdRun(cleanArgs.slice(1));
        await _recordPromise;
        break;
      }

      case "logs":
        await cmdLogs(cleanArgs.slice(1));
        break;

      case "spans":
        await cmdSpans(cleanArgs.slice(1));
        break;

      case "mail":
        await cmdMail(cleanArgs.slice(1));
        break;

      case "note":
        await cmdNote(cleanArgs.slice(1));
        break;

      case "phase":
        await cmdPhase(cleanArgs.slice(1));
        break;

      case "track":
        await cmdTrack(cleanArgs.slice(1));
        break;

      case "untrack":
        await cmdUntrack(cleanArgs.slice(1));
        break;

      case "tracked":
        await cmdTracked(cleanArgs.slice(1));
        break;

      case "typegen":
        await cmdTypegen(cleanArgs.slice(1));
        break;

      case "completions":
        await cmdCompletions(cleanArgs.slice(1));
        break;

      case "tty":
        await cmdTty(cleanArgs.slice(1));
        break;

      case "agent":
        await cmdAgent(cleanArgs.slice(1));
        break;

      case "claude":
        await cmdClaude(cleanArgs.slice(1));
        break;

      case "codex":
      case "acp":
      case "copilot":
      case "gemini":
      case "opencode":
        console.error(`Warning: "mcx ${command}" is deprecated. Use "mcx agent ${command}" instead.`);
        await cmdAgent([command, ...cleanArgs.slice(1)]);
        break;

      case "vfs":
        await cmdVfs(cleanArgs.slice(1), { dryRun: _dryRun });
        break;

      case "scope":
        await cmdScope(cleanArgs.slice(1));
        break;

      case "serve":
        if (cleanArgs[1] === "kill") {
          await cmdServeKill(cleanArgs.slice(2));
        } else {
          await cmdServe();
        }
        break;

      case "connect":
        await cmdStatus(cleanArgs.slice(1));
        break;

      case "restart":
      case "reconnect":
        await cmdRestart(cleanArgs.slice(1));
        break;

      case "daemon":
        await cmdDaemon(cleanArgs.slice(1));
        break;

      case "shutdown": {
        const force = cleanArgs.includes("--force");
        const result = await ipcCall("shutdown", { force });
        if (!result.ok) {
          printError(result.message ?? "Shutdown refused");
          process.exit(1);
        }
        console.error("Daemon shut down.");
        break;
      }

      default: {
        // Check if it looks like "mcx server/tool" (slash notation shorthand)
        if (!command.startsWith("-") && splitServerTool(command)) {
          await cmdCall(cleanArgs);
          break;
        }

        // Check if subcommand matches a configured server name (case-insensitive).
        // This handles "mcx grafana get_dashboard ..." → "mcx call grafana get_dashboard ..."
        // Only check when daemon is already running to avoid 5s startup delay on typos.
        if (!command.startsWith("-") && (await isDaemonRunning())) {
          const servers: ServerStatus[] = await ipcCall("listServers");
          const match = servers.find((s) => s.name.toLowerCase() === command.toLowerCase());
          if (match) {
            // Use the exact server name from config (handles case mismatch)
            await cmdCall([match.name, ...cleanArgs.slice(1)]);
            break;
          }
        }

        // Fallback: if it looks like "mcx <word> <word> ..." (two non-flag args),
        // try as call shorthand even if the daemon isn't running yet (auto-starts it).
        if (!command.startsWith("-") && cleanArgs.length >= 2 && !cleanArgs[1].startsWith("-")) {
          await cmdCall(cleanArgs);
          break;
        }

        // Check if command matches an alias name → run it.
        // Only aliases with scope IS NULL are dispatched at the top level.
        // `global` and path-scoped aliases are invisible here; use `mcx alias run` or `mcx call _aliases`.
        // Only check if daemon is already running to avoid 5s startup delay on typos.
        if (!command.startsWith("-") && (await isDaemonRunning())) {
          const alias = await ipcCall("getAlias", { name: command });
          if (alias && alias.scope == null) {
            const { _recordPromise } = await cmdRun([command, ...cleanArgs.slice(1)]);
            await _recordPromise;
            break;
          }
        }

        printError(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      printError(err.message);
      process.exit(2);
    }
    printError(extractErrorMessage(err));
    if (process.env.MCX_DEBUG === "1" && err instanceof IpcCallError && err.remoteStack) {
      console.error("\nRemote stack trace:");
      console.error(err.remoteStack);
    }
    process.exit(1);
  }
}

// -- Commands --

async function cmdLs(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);
  const serverName = rest[0];

  if (serverName) {
    // List tools for a specific server
    const tools = await ipcCall("listTools", { server: serverName });
    if (json) {
      console.log(JSON.stringify(tools, null, 2));
    } else {
      printToolList(tools);
    }
  } else {
    // List servers
    const servers = await ipcCall("listServers");
    if (json) {
      console.log(JSON.stringify(servers, null, 2));
    } else {
      printServerList(servers);
    }
  }
}

async function cmdCall(args: string[]): Promise<void> {
  // Extract known flags before parsing positional args (prevents flags from contaminating @file paths)
  const { full, rest: afterFull } = extractFullFlag(args);
  const { jq: jqFilter, rest: afterJq } = extractJqFlag(afterFull);
  const { timeoutMs, rest: afterTimeout } = extractTimeoutFlag(afterJq);
  const { rest: afterJson } = extractJsonFlag(afterTimeout);

  // Support slash notation: "server/tool" → ["server", "tool"]
  const split = afterJson.length >= 1 ? splitServerTool(afterJson[0]) : null;
  const resolved = split ? [...split, ...afterJson.slice(1)] : afterJson;

  if (resolved.length < 2) {
    printError("Usage: mcx call <server> <tool> [json|@file] [--jq '<filter>'] [--full] [--timeout <seconds>]");
    process.exit(1);
  }

  const [server, tool, ...rest] = resolved;

  // Warn on ambiguous multi-slash notation: "a/b/c" → tool="b/c"
  if (split && tool.includes("/")) {
    console.error(`Warning: tool name "${tool}" contains "/". Did you mean "${split[0]}/${tool.split("/")[0]}"?`);
  }
  const inputArg = rest.join(" ").trim();
  const toolArgs = await parseToolArgs(inputArg);

  // IPC layer timeout must exceed the MCP SDK timeout; default to MCP_TOOL_TIMEOUT_MS + 5s buffer
  const toolTimeoutMs = timeoutMs ?? MCP_TOOL_TIMEOUT_MS;

  // --dry-run: show what would be called without executing
  if (_dryRun) {
    const call = {
      method: "callTool" as const,
      server,
      tool,
      arguments: toolArgs,
      timeoutMs: toolTimeoutMs,
    };
    console.log(JSON.stringify(call, null, 2));
    return;
  }

  const result = await ipcCall(
    "callTool",
    { server, tool, arguments: toolArgs, timeoutMs: toolTimeoutMs, cwd: process.cwd() },
    { timeoutMs: toolTimeoutMs + 5_000 },
  );

  // Auto-save long calls as ephemeral aliases (best-effort, non-blocking)
  maybeAutoSaveEphemeral(server, tool, toolArgs, { ipcCall });

  // Explicit --jq filter: apply client-side regardless of size/env
  if (jqFilter) {
    const formatted = formatToolResult(result);
    try {
      const data = JSON.parse(formatted);
      const filtered = await applyJqFilter(data, jqFilter);
      console.log(JSON.stringify(filtered, null, 2));
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  // Size protection: only under CLAUDE=1 and without --full
  const isClaude = process.env.CLAUDE === "1";
  if (isClaude && !full) {
    const formatted = formatToolResult(result);
    const sizeBytes = Buffer.byteLength(formatted, "utf-8");

    if (sizeBytes > SIZE_HINT) {
      // Too large — replace with structural analysis
      try {
        const data = JSON.parse(formatted);
        console.log(generateAnalysis(data, sizeBytes));
      } catch {
        // Not valid JSON — just report size
        console.log(
          `Response too large (${(sizeBytes / 1024).toFixed(1)}KB). Use --jq '<filter>' to filter, or --full for raw output.`,
        );
      }
      return;
    }

    if (sizeBytes > SIZE_OK) {
      // Medium — pass through + stderr hint
      console.log(formatted);
      console.error(`[mcx] ${(sizeBytes / 1024).toFixed(1)}KB response. Use --jq to filter.`);
      return;
    }

    // Small — pass through unchanged
    console.log(formatted);
    return;
  }

  // Default: no protection (no CLAUDE env, or --full)
  printToolResult(result);
}

async function cmdInfo(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);

  // Support slash notation: "server/tool" → ["server", "tool"]
  const split = rest.length >= 1 ? splitServerTool(rest[0]) : null;
  const resolved = split ? [...split, ...rest.slice(1)] : rest;

  if (resolved.length < 2) {
    printError("Usage: mcx info <server> <tool>");
    process.exit(1);
  }

  const [server, tool] = resolved;

  if (split && tool.includes("/")) {
    console.error(`Warning: tool name "${tool}" contains "/". Did you mean "${split[0]}/${tool.split("/")[0]}"?`);
  }
  const info = await ipcCall("getToolInfo", { server, tool });
  if (json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    printToolInfo(info);
  }
}

async function cmdGrep(args: string[]): Promise<void> {
  const { json, rest } = extractJsonFlag(args);

  if (rest.length === 0) {
    printError("Usage: mcx grep <pattern>");
    process.exit(1);
  }

  const pattern = rest.join(" ");
  const tools = await ipcCall("grepTools", { pattern });
  if (json) {
    console.log(JSON.stringify(tools, null, 2));
  } else {
    printToolList(tools);
  }
}

async function cmdStatus(args: string[] = []): Promise<void> {
  const noStart = args.includes("--no-start");
  const { json } = extractJsonFlag(args.filter((a) => a !== "--no-start"));

  // --no-start: report state without spawning (original semantics).
  if (noStart) {
    let running: boolean;
    try {
      running = await isDaemonRunning();
    } catch (err) {
      if (err instanceof ProtocolMismatchError) {
        printProtocolMismatchStatus(err, json);
        return;
      }
      throw err;
    }
    if (!running) {
      if (isDaemonInitializing()) {
        if (json) {
          console.log(JSON.stringify({ state: "starting" }));
        } else {
          console.error("Daemon is starting...");
        }
        return;
      }
      if (json) {
        console.log(JSON.stringify({ state: "stopped" }));
      } else {
        console.error("Daemon is not running. Start it with: mcx daemon start");
      }
      return;
    }
  }

  // Auto-start daemon if not running — after a crash, `mcx status` is the first
  // thing users check, so it should bring the daemon back (#412).
  // ipcCall() wraps ensureDaemon(), so this handles auto-start + status in one call.
  let status: DaemonStatus;
  try {
    status = await ipcCall("status", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      printProtocolMismatchStatus(err, json);
      return;
    }
    throw err;
  }

  // Fetch quota status in parallel (non-blocking — don't fail status if quota unavailable)
  let quota: QuotaStatusResult | null = null;
  try {
    quota = await ipcCall("quotaStatus", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch {
    // Quota monitoring unavailable — continue without it
  }

  const staleWarning = getStaleDaemonWarning();
  const sourceWarning = getSourceStalenessWarning();

  if (json) {
    let output = { ...status, quota };
    if (staleWarning) output = { ...output, staleBuild: true, staleWarning } as typeof output;
    if (sourceWarning) output = { ...output, staleSource: true, sourceWarning } as typeof output;
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Daemon PID: ${status.pid}`);
    console.log(`Uptime: ${Math.round(status.uptime)}s`);
    console.log(`Database: ${status.dbPath}\n`);
    printServerList(status.servers);
    printQuotaStatus(quota);
    if (staleWarning) {
      console.error(`\n⚠ ${staleWarning}`);
    }
    if (sourceWarning) {
      console.error(`\n⚠ ${sourceWarning}`);
    }
  }
}

function printQuotaStatus(quota: QuotaStatusResult | null): void {
  if (!quota || quota.fetchedAt === 0) return;

  console.log("\nQuota:");
  if (quota.fiveHour) {
    const reset = new Date(quota.fiveHour.resetsAt).toLocaleTimeString();
    const warn = quota.fiveHour.utilization > 80 ? " ⚠" : "";
    console.log(`  5h window:  ${quota.fiveHour.utilization}% used (resets ${reset})${warn}`);
  }
  if (quota.sevenDay) {
    console.log(`  7d window:  ${quota.sevenDay.utilization}% used`);
  }
  if (quota.sevenDaySonnet) {
    console.log(`  7d sonnet:  ${quota.sevenDaySonnet.utilization}% used`);
  }
  if (quota.sevenDayOpus) {
    console.log(`  7d opus:    ${quota.sevenDayOpus.utilization}% used`);
  }
  if (quota.extraUsage) {
    console.log(
      `  Extra:      ${quota.extraUsage.utilization.toFixed(1)}% ($${quota.extraUsage.usedCredits} / $${quota.extraUsage.monthlyLimit})`,
    );
  }
  if (quota.lastError) {
    console.error(`  Last error: ${quota.lastError}`);
  }
}

function printProtocolMismatchStatus(err: ProtocolMismatchError, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          state: "protocol_mismatch",
          daemonProtocol: err.daemonVersion,
          cliProtocol: err.cliVersion,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(err.message);
  }
  process.exitCode = 2;
}

async function cmdMetrics(args: string[] = []): Promise<void> {
  const { json } = extractJsonFlag(args);
  const snap = await ipcCall("getMetrics", undefined, { timeoutMs: PING_TIMEOUT_MS });

  if (json) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }

  // Human-readable summary
  if (snap.gauges.length > 0) {
    console.log("Gauges:");
    for (const g of snap.gauges) {
      const labels = formatMetricLabels(g.labels);
      console.log(`  ${g.name}${labels} = ${g.value}`);
    }
    console.log();
  }

  if (snap.counters.length > 0) {
    console.log("Counters:");
    for (const c of snap.counters) {
      const labels = formatMetricLabels(c.labels);
      console.log(`  ${c.name}${labels} = ${c.value}`);
    }
    console.log();
  }

  if (snap.histograms.length > 0) {
    console.log("Histograms:");
    for (const h of snap.histograms) {
      const labels = formatMetricLabels(h.labels);
      const avg = h.count > 0 ? (h.sum / h.count).toFixed(1) : "0";
      console.log(`  ${h.name}${labels}  count=${h.count} sum=${h.sum.toFixed(1)}ms avg=${avg}ms`);
    }
    console.log();
  }

  if (snap.counters.length === 0 && snap.gauges.length === 0 && snap.histograms.length === 0) {
    console.log("No metrics collected yet.");
  }
}

function formatMetricLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}

async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "restart") {
    // Directly stop — does not go through ensureDaemon (avoids ProtocolMismatchError)
    // restart is intentionally destructive — force:true bypasses active session guard
    console.error("Stopping daemon...");
    await stopDaemon({ force: true });
    // Next ipcCall auto-starts a fresh daemon with current code
    await ipcCall("ping");
    console.error("Daemon restarted.");
  } else if (sub === "shutdown" || sub === "stop") {
    const force = args.includes("--force");
    try {
      await stopDaemon({ force });
    } catch (err) {
      if (err instanceof ShutdownRefusedError) {
        printError(err.message);
        process.exit(1);
      }
      throw err;
    }
    console.error("Daemon shut down.");
  } else {
    printError("Usage: mcx daemon restart|shutdown [--force]");
    process.exit(1);
  }
}

async function cmdRestart(args: string[]): Promise<void> {
  const server = args[0];
  await ipcCall("restartServer", server ? { server } : {});
  console.error(server ? `Restarted ${server}` : "Restarted all servers");
}

// -- Argument parsing --

/**
 * Parse tool arguments from CLI input.
 * Supports: JSON string, @file.json, stdin pipe, empty (defaults to {}).
 */
async function parseToolArgs(input: string): Promise<Record<string, unknown>> {
  // Empty input
  if (!input) {
    // Check for piped stdin
    if (!process.stdin.isTTY) {
      return readStdinJson();
    }
    return {};
  }

  // File reference: @file.json
  if (input.startsWith("@")) {
    const filePath = input.slice(1);
    const content = readFileWithLimit(filePath);
    return JSON.parse(content);
  }

  // Inline JSON
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON argument: ${input}`);
  }
}

// -- Help --

function printUsage(): void {
  console.log(`mcx — MCP tools from the command line

Tools:
  mcx ls [server]                     List servers or tools
  mcx call <server> <tool> [json]     Call a tool (also: mcx <server> <tool>)
  mcx info <server> <tool>            Show tool schema
  mcx grep <pattern>                  Search tools by name/description

Sessions:
  mcx claude <subcommand>             Manage Claude Code sessions
  mcx agent <provider> <subcommand>   Manage agent sessions (codex, acp, opencode)

Servers:
  mcx status                          Server/daemon status
  mcx auth [server]                   Auth status or trigger login
  mcx restart [server]                Restart connection(s)
  mcx add/remove/get <server>         Manage server config
  mcx config <subcommand>             Show or modify configuration
  mcx import/export [file]            Import/export server config

Aliases:
  mcx alias ls|save|show|edit|rm      Manage alias scripts
  mcx run <alias> [args]              Run an alias (also: mcx <alias>)

Utility:
  mcx search/install/update           Registry search and install
  mcx gc [--dry-run]                  Prune merged branches + stale worktrees
  mcx logs <server> [-f]              View server stderr
  mcx mail <subcommand>               Inter-session messaging
  mcx note <subcommand>               Tool annotations
  mcx serve                           Run as stdio MCP server
  mcx scope <subcommand>              Directory scope management
  mcx dump/metrics/spans              Diagnostics and observability
  mcx telemetry [on|off|status]       Control anonymous usage telemetry
  mcx version                         Version info
  mcx completions {bash|zsh|fish}     Shell completions

Options:  -j (JSON) | -V (verbose) | -q (quiet) | -f (full) | --dry-run | --jq '<filter>'

Run 'mcx <command> --help' for details and examples.`);
}

if (import.meta.main) {
  main().then(() => process.exit(process.exitCode ?? 0));
}
