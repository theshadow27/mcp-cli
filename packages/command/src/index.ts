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

import type { AliasDetail, DaemonStatus, ServerStatus, ToolInfo } from "@mcp-cli/core";
import { IpcCallError, ProtocolMismatchError, VERSION } from "@mcp-cli/core";
import { cmdAdd, cmdAddJson } from "./commands/add";
import { cmdAlias } from "./commands/alias";
import { cmdClaude } from "./commands/claude";
import { cmdCompletions } from "./commands/completions";
import { cmdConfig } from "./commands/config";
import { cmdExport } from "./commands/export";
import { cmdGet } from "./commands/get";
import { cmdImport } from "./commands/import";
import { cmdInstall } from "./commands/install";
import { cmdLogs } from "./commands/logs";
import { cmdMail } from "./commands/mail";
import { cmdRegistryDispatch } from "./commands/registry-cmd";
import { cmdRemove } from "./commands/remove";
import { cmdRun, parseRunArgs } from "./commands/run";
import { cmdServe } from "./commands/serve";
import { cmdTty } from "./commands/tty";
import { cmdTypegen } from "./commands/typegen";
import { ipcCall, isDaemonRunning, stopDaemon } from "./daemon-lifecycle";
import { readFileWithLimit } from "./file-read";
import { SIZE_HINT, SIZE_OK, applyJqFilter, generateAnalysis } from "./jq/index";
import {
  formatToolResult,
  printError,
  printRegistryList,
  printServerList,
  printToolInfo,
  printToolList,
  printToolResult,
} from "./output";
import { extractFullFlag, extractJqFlag, extractJsonFlag, readStdinJson, splitServerTool } from "./parse";
import { searchRegistry } from "./registry/client";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`mcp-cli ${VERSION}`);
    return;
  }

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  const command = args[0];

  try {
    switch (command) {
      case "ls":
      case "list":
      case "tools":
        await cmdLs(args.slice(1));
        break;

      case "call":
        await cmdCall(args.slice(1));
        break;

      case "info":
        await cmdInfo(args.slice(1));
        break;

      case "grep":
        await cmdGrep(args.slice(1));
        break;

      case "search": {
        const { json: searchJson, rest: searchRest } = extractJsonFlag(args.slice(1));
        const searchPattern = searchRest.join(" ");
        if (!searchPattern) {
          printError("Usage: mcx search <query>");
          process.exit(1);
        }
        const searchTools = (await ipcCall("grepTools", { pattern: searchPattern })) as ToolInfo[];
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
        await cmdImport(args.slice(1));
        break;

      case "export":
        await cmdExport(args.slice(1));
        break;

      case "install":
        await cmdInstall(args.slice(1));
        break;

      case "registry":
        await cmdRegistryDispatch(args.slice(1));
        break;

      case "status":
        await cmdStatus(args.slice(1));
        break;

      case "config":
        await cmdConfig(args.slice(1));
        break;

      case "add":
        await cmdAdd(args.slice(1));
        break;

      case "add-json":
        await cmdAddJson(args.slice(1));
        break;

      case "remove":
        await cmdRemove(args.slice(1));
        break;

      case "get":
        await cmdGet(args.slice(1));
        break;

      case "auth":
        await cmdAuth(args.slice(1));
        break;

      case "alias":
        await cmdAlias(args.slice(1));
        break;

      case "run":
        await cmdRun(args.slice(1));
        break;

      case "logs":
        await cmdLogs(args.slice(1));
        break;

      case "mail":
        await cmdMail(args.slice(1));
        break;

      case "typegen":
        await cmdTypegen(args.slice(1));
        break;

      case "completions":
        await cmdCompletions(args.slice(1));
        break;

      case "tty":
        await cmdTty(args.slice(1));
        break;

      case "claude":
        await cmdClaude(args.slice(1));
        break;

      case "serve":
        await cmdServe();
        break;

      case "restart":
        await cmdRestart(args.slice(1));
        break;

      case "daemon":
        await cmdDaemon(args.slice(1));
        break;

      case "shutdown":
        await ipcCall("shutdown");
        console.error("Daemon shut down.");
        break;

      default: {
        // Check if it looks like "mcx server/tool" (slash notation shorthand)
        if (!command.startsWith("-") && splitServerTool(command)) {
          await cmdCall(args);
          break;
        }

        // Check if it looks like "mcx server tool" (missing "call")
        if (!command.startsWith("-") && args.length >= 2 && !args[1].startsWith("-")) {
          // Treat as shorthand: mcx <server> <tool> [args]
          await cmdCall(args);
          break;
        }

        // Check if command matches an alias name → run it
        // Only check if daemon is already running to avoid 5s startup delay on typos
        if (!command.startsWith("-") && (await isDaemonRunning())) {
          const alias = (await ipcCall("getAlias", { name: command })) as AliasDetail | null;
          if (alias) {
            const { runAlias } = await import("./alias-runner.js");
            const { jsonInput, cliArgs } = parseRunArgs(args.slice(1));
            await runAlias(alias.filePath, cliArgs, jsonInput);
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
    printError(err instanceof Error ? err.message : String(err));
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
    const tools = (await ipcCall("listTools", { server: serverName })) as ToolInfo[];
    if (json) {
      console.log(JSON.stringify(tools, null, 2));
    } else {
      printToolList(tools);
    }
  } else {
    // List servers
    const servers = (await ipcCall("listServers")) as ServerStatus[];
    if (json) {
      console.log(JSON.stringify(servers, null, 2));
    } else {
      printServerList(servers);
    }
  }
}

async function cmdCall(args: string[]): Promise<void> {
  // Extract --full/-f and --jq flags before parsing positional args
  const { full, rest: afterFull } = extractFullFlag(args);
  const { jq: jqFilter, rest: afterJq } = extractJqFlag(afterFull);

  // Support slash notation: "server/tool" → ["server", "tool"]
  const split = afterJq.length >= 1 ? splitServerTool(afterJq[0]) : null;
  const resolved = split ? [...split, ...afterJq.slice(1)] : afterJq;

  if (resolved.length < 2) {
    printError("Usage: mcx call <server> <tool> [json|@file] [--jq '<filter>'] [--full]");
    process.exit(1);
  }

  const [server, tool, ...rest] = resolved;

  // Warn on ambiguous multi-slash notation: "a/b/c" → tool="b/c"
  if (split && tool.includes("/")) {
    console.error(`Warning: tool name "${tool}" contains "/". Did you mean "${split[0]}/${tool.split("/")[0]}"?`);
  }
  const inputArg = rest.join(" ").trim();
  const toolArgs = await parseToolArgs(inputArg);

  const result = await ipcCall("callTool", { server, tool, arguments: toolArgs });

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
  const info = (await ipcCall("getToolInfo", { server, tool })) as ToolInfo & {
    inputSchema: Record<string, unknown>;
  };
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
  const tools = (await ipcCall("grepTools", { pattern })) as ToolInfo[];
  if (json) {
    console.log(JSON.stringify(tools, null, 2));
  } else {
    printToolList(tools);
  }
}

async function cmdStatus(args: string[] = []): Promise<void> {
  const { json } = extractJsonFlag(args);
  const status = (await ipcCall("status")) as DaemonStatus;

  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`Daemon PID: ${status.pid}`);
    console.log(`Uptime: ${Math.round(status.uptime)}s`);
    console.log(`Database: ${status.dbPath}\n`);
    printServerList(status.servers);
  }
}

async function cmdAuth(args: string[]): Promise<void> {
  if (args.length < 1) {
    printError("Usage: mcx auth <server>");
    process.exit(1);
  }

  const server = args[0];
  console.error(`Authenticating with ${server}...`);
  const result = (await ipcCall("triggerAuth", { server })) as { ok: boolean; message: string };
  console.error(result.message);
}

async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "restart") {
    // Directly stop — does not go through ensureDaemon (avoids ProtocolMismatchError)
    console.error("Stopping daemon...");
    await stopDaemon();
    // Next ipcCall auto-starts a fresh daemon with current code
    await ipcCall("ping");
    console.error("Daemon restarted.");
  } else if (sub === "shutdown" || sub === "stop") {
    // Direct stop — no ensureDaemon needed
    await stopDaemon();
    console.error("Daemon shut down.");
  } else {
    printError("Usage: mcx daemon restart|shutdown");
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
  mcx call <server> <tool> [json]     Call a tool (JSON from arg, @file, or stdin)
  mcx call <server/tool> [json]       Slash notation
  mcx <server> <tool> [json]          Shorthand for call
  mcx <server/tool> [json]            Shorthand with slash notation
  mcx info <server> <tool>            Show tool schema
  mcx info <server/tool>              Slash notation
  mcx grep <pattern>                  Search tools by name/description
  mcx search <query>                  Search local tools, then registry
  mcx install <slug>                  Install a server from the registry
  mcx registry search <query>         Search the MCP registry
  mcx registry list                   List available registry servers
  mcx import [source] [--scope ...]    Import servers from .mcp.json or config file
  mcx import --claude [--all]          Import servers from ~/.claude.json
  mcx export [file] [--scope ...]      Export servers to .mcp.json format
  mcx add --transport {stdio|http|sse} <name> ...   Add a server
  mcx add-json <name> '<json>'        Add a server from raw JSON
  mcx remove <name>                   Remove a server
  mcx get <name>                      Inspect a server's config and status
  mcx auth <server>                   Authenticate with an OAuth server
  mcx config show                     Show resolved server config
  mcx config sources                  Show config file sources
  mcx config set <key> <value>        Set a CLI option (e.g. trust-claude)
  mcx config get <key>                Get a CLI option value
  mcx config get <server>             Inspect a server's config (env, args, url)
  mcx config set <srv> env <K>:<V>    Set an env var on a stdio server
  mcx status                          Daemon status
  mcx mail -s "subject" <recipient>   Send a message (body from stdin)
  mcx mail -H                        List message headers
  mcx mail -u <user>                 Read a user's mailbox
  mcx mail -r <msgnum>               Reply to a message (body from stdin)
  mcx mail --wait [--timeout=N]      Block until a message arrives
  mcx mail --wait --for=<name>       Wait for mail to specific recipient
  mcx logs <server> [-f] [--lines N]  View server stderr output
  mcx typegen                         Generate TypeScript types for alias scripts
  mcx tty open <command>               Open command in new terminal tab
  mcx tty open --window <command>      Open command in new terminal window
  mcx tty open --headless <command>    Run command as background process
  mcx claude spawn --task "..."        Start a Claude Code session
  mcx claude ls                        List active Claude sessions
  mcx claude send <session> <msg>      Send follow-up prompt to session
  mcx claude kill <session>            Interrupt a session
  mcx claude log <session>             View session transcript
  mcx serve                           Run as stdio MCP server (for .mcp.json)
  mcx completions {bash|zsh|fish}     Generate shell completion script
  mcx restart [server]                Restart server connection(s)
  mcx daemon restart                  Restart the daemon (kills sessions)
  mcx daemon shutdown                 Stop the daemon
  mcx shutdown                        Stop the daemon (legacy)

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

main().then(() => process.exit(0));
