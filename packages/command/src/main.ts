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
import { IpcCallError, MCP_TOOL_TIMEOUT_MS, PING_TIMEOUT_MS, ProtocolMismatchError, VERSION } from "@mcp-cli/core";
import { cmdAdd, cmdAddJson } from "./commands/add";
import { cmdAgent } from "./commands/agent";
import { cmdAlias } from "./commands/alias";
import { cmdAuth } from "./commands/auth";
import { cmdClaude } from "./commands/claude";
import { cmdCompletions } from "./commands/completions";
import { cmdConfig } from "./commands/config";
import { cmdDump } from "./commands/dump";
import { cmdExport } from "./commands/export";
import { cmdGet } from "./commands/get";
import { cmdAddFromClaudeDesktop, cmdImport } from "./commands/import";
import { cmdInstall } from "./commands/install";
import { cmdLogs } from "./commands/logs";
import { cmdMail } from "./commands/mail";
import { cmdNote } from "./commands/note";
import { cmdRegistryDispatch } from "./commands/registry-cmd";
import { cmdRemove } from "./commands/remove";
import { cmdRun } from "./commands/run";
import { cmdScope } from "./commands/scope";
import { cmdServe } from "./commands/serve";
import { cmdSpans } from "./commands/spans";
import { cmdTty } from "./commands/tty";
import { cmdTypegen } from "./commands/typegen";
import { cmdUpdate } from "./commands/update";
import { cmdVersion } from "./commands/version";
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

  // --dry-run is only valid for call (and shorthand call forms handled in the default branch)
  if (dryRun && command && command !== "call") {
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

      case "auth":
        await cmdAuth(cleanArgs.slice(1));
        break;

      case "alias":
        await cmdAlias(cleanArgs.slice(1));
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

      case "scope":
        await cmdScope(cleanArgs.slice(1));
        break;

      case "serve":
        await cmdServe();
        break;

      case "restart":
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

        // Check if command matches an alias name → run it
        // Only check if daemon is already running to avoid 5s startup delay on typos
        if (!command.startsWith("-") && (await isDaemonRunning())) {
          const alias = await ipcCall("getAlias", { name: command });
          if (alias) {
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
  // Extract --full/-f, --jq, and --timeout flags before parsing positional args
  const { full, rest: afterFull } = extractFullFlag(args);
  const { jq: jqFilter, rest: afterJq } = extractJqFlag(afterFull);
  const { timeoutMs, rest: afterTimeout } = extractTimeoutFlag(afterJq);

  // Support slash notation: "server/tool" → ["server", "tool"]
  const split = afterTimeout.length >= 1 ? splitServerTool(afterTimeout[0]) : null;
  const resolved = split ? [...split, ...afterTimeout.slice(1)] : afterTimeout;

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
    { server, tool, arguments: toolArgs, timeoutMs: toolTimeoutMs },
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

Usage:
  mcx ls                              List configured servers
  mcx ls <server>                     List tools for a server
  mcx tools <server>                  Alias for ls <server>
  mcx call <server> <tool> [json]     Call a tool (JSON from arg, @file, or stdin); --timeout <s> overrides 10m default
  mcx call <server/tool> [json]       Slash notation
  mcx <server> <tool> [json]          Shorthand for call
  mcx <server/tool> [json]            Shorthand with slash notation
  mcx info <server> <tool>            Show tool schema
  mcx info <server/tool>              Slash notation
  mcx grep <pattern>                  Search tools by name/description
  mcx search <query>                  Search local tools, then registry
  mcx install <slug>                  Install a server from the registry
  mcx update <slug>                   Check for and apply server updates
  mcx update --all                    Check all installed servers for updates
  mcx registry search <query>         Search the MCP registry
  mcx registry list                   List available registry servers
  mcx import [source] [--scope ...]    Import servers from .mcp.json or config file
  mcx import --claude [--all]          Import servers from ~/.claude.json
  mcx export [file] [--scope ...]      Export servers to .mcp.json format
  mcx add --transport {stdio|http|sse} <name> ...   Add a server
  mcx add-json <name> '<json>'        Add a server from raw JSON
  mcx add-from-claude-desktop         Import servers from Claude Desktop config
  mcx remove <name>                   Remove a server
  mcx get <name>                      Inspect a server's config and status
  mcx auth                             List servers with auth status
  mcx auth <server>                   Trigger authentication (OAuth or auth tool)
  mcx auth <server> --status          Check auth status without login
  mcx config show                     Show resolved server config
  mcx config sources                  Show config file sources
  mcx config set <key> <value>        Set a CLI option (e.g. trust-claude)
  mcx config get <key>                Get a CLI option value
  mcx config get <server>             Inspect a server's config (env, args, url)
  mcx config set <srv> env <K>:<V>    Set an env var on a stdio server
  mcx version                         Show CLI, daemon, and protocol versions
  mcx status                          Daemon status
  mcx metrics                         Show daemon metrics (Prometheus-style)
  mcx metrics -j                      Metrics as JSON
  mcx dump                            Snapshot daemon state for bug reports
  mcx dump --stdout                   Dump JSON to stdout
  mcx dump --include-transcripts      Include session transcripts
  mcx mail -s "subject" <recipient>   Send a message (body from stdin)
  mcx mail -H                        List message headers
  mcx mail -u <user>                 Read a user's mailbox
  mcx mail -r <msgnum>               Reply to a message (body from stdin)
  mcx mail --wait [--timeout=N]      Block until a message arrives
  mcx mail --wait --for=<name>       Wait for mail to specific recipient
  mcx logs <server> [-f] [--lines N]  View server stderr output
  mcx logs --daemon [-f] [--lines N]  View daemon log file
  mcx spans [--trace-id ID]           View OpenTelemetry trace spans
  mcx typegen                         Generate TypeScript types for alias scripts
  mcx tty open <command>               Open command in new terminal tab
  mcx tty open --window <command>      Open command in new terminal window
  mcx tty open --headless <command>    Run command as background process
  mcx agent <provider> <subcommand>     Manage agent sessions (claude, codex, acp, opencode)
  mcx agent claude spawn --task "..."  Start a Claude Code session
  mcx agent codex spawn --task "..."   Start a Codex session
  mcx agent acp spawn --task "..."     Start an ACP agent session
  mcx claude <subcommand>              Alias for mcx agent claude <subcommand>
  mcx scope init [name] [--force]     Register current directory as a scope
  mcx scope list                      List all registered scopes
  mcx scope rm <name>                 Remove a scope
  mcx serve                           Run as stdio MCP server (for .mcp.json)
  mcx completions {bash|zsh|fish}     Generate shell completion script
  mcx restart [server]                Restart server connection(s)
  mcx daemon restart                  Restart the daemon (kills sessions)
  mcx daemon shutdown [--force]        Stop the daemon (--force if sessions active)
  mcx shutdown [--force]              Stop the daemon (legacy)

Notes:
  mcx note set <srv>.<tool> "text"    Attach a note to a tool
  mcx note get <srv>.<tool>           Get a tool's note
  mcx note ls                         List all notes
  mcx note rm <srv>.<tool>            Remove a note

Aliases:
  mcx alias ls                        List saved aliases
  mcx alias save <name> <@file | ->   Save a TypeScript alias script
  mcx alias show <name>               Print alias source
  mcx alias edit <name>               Open alias in $EDITOR
  mcx alias rm <name>                 Delete an alias
  mcx run <alias> [--key value ...]   Run an alias with arguments
  mcx <alias> [--key value ...]       Shorthand for run

Options:
  --format json, -j                 Machine-readable JSON output (ls, info, grep, status)
  --jq '<filter>'                   Apply jq filter to call output (client-side)
  --full, -f                        Bypass output size protection (call)
  --verbose, -V                     Show IPC requests/responses and debug info (stderr)
  --quiet, -q                       Suppress informational prompts (e.g. first-run hint)
  --dry-run                         Show what would be executed without running it (call)

Examples:
  mcx ls atlassian
  mcx ls --format json
  mcx ls atlassian -j
  mcx call atlassian search '{"query":"sprint planning"}'
  mcx call atlassian/search '{"query":"sprint planning"}'
  mcx atlassian search '{"query":"sprint planning"}'
  mcx atlassian/search '{"query":"sprint planning"}'
  mcx call atlassian getJiraIssue @issue.json
  echo '{"query":"test"}' | mcx call atlassian search
  mcx info atlassian getConfluencePage
  mcx info atlassian/getConfluencePage -j
  mcx grep confluence
  mcx status -j
  mcx alias save get-time @get-time.ts
  mcx run get-time`);
}

if (import.meta.main) {
  main().then(() => process.exit(process.exitCode ?? 0));
}
