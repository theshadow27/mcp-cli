#!/usr/bin/env bun
/**
 * mcp — MCP CLI
 *
 * Call MCP server tools from the command line.
 * Talks to mcpd daemon via Unix socket for connection management.
 *
 * Usage:
 *   mcp ls                                      # list servers
 *   mcp ls <server>                              # list tools for a server
 *   mcp call <server> <tool> [json|@file]        # call a tool
 *   mcp info <server> <tool>                     # show tool schema
 *   mcp grep <pattern>                           # search tools
 *   mcp status                                   # daemon status
 */

import { readFileSync } from "node:fs";
import type { AliasDetail, DaemonStatus, ServerStatus, ToolInfo } from "@mcp-cli/core";
import { VERSION } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { cmdAdd, cmdAddJson } from "./commands/add.js";
import { cmdAlias } from "./commands/alias.js";
import { cmdCompletions } from "./commands/completions.js";
import { cmdConfig } from "./commands/config.js";
import { cmdGet } from "./commands/get.js";
import { cmdInstall } from "./commands/install.js";
import { cmdLogs } from "./commands/logs.js";
import { cmdRegistryDispatch } from "./commands/registry-cmd.js";
import { cmdRemove } from "./commands/remove.js";
import { cmdRun, parseRunArgs } from "./commands/run.js";
import { cmdTypegen } from "./commands/typegen.js";
import { SIZE_HINT, SIZE_OK, applyJqFilter, generateAnalysis } from "./jq/index.js";
import {
  formatToolResult,
  printError,
  printRegistryList,
  printServerList,
  printToolInfo,
  printToolList,
  printToolResult,
} from "./output.js";
import { extractFullFlag, extractJqFlag, extractJsonFlag, splitServerTool } from "./parse.js";
import { searchRegistry } from "./registry/client.js";

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
          printError("Usage: mcp search <query>");
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

      case "typegen":
        await cmdTypegen(args.slice(1));
        break;

      case "completions":
        await cmdCompletions(args.slice(1));
        break;

      case "restart":
        await cmdRestart(args.slice(1));
        break;

      case "shutdown":
        await ipcCall("shutdown");
        console.error("Daemon shut down.");
        break;

      default: {
        // Check if it looks like "mcp server/tool" (slash notation shorthand)
        if (!command.startsWith("-") && splitServerTool(command)) {
          await cmdCall(args);
          break;
        }

        // Check if it looks like "mcp server tool" (missing "call")
        if (!command.startsWith("-") && args.length >= 2 && !args[1].startsWith("-")) {
          // Treat as shorthand: mcp <server> <tool> [args]
          await cmdCall(args);
          break;
        }

        // Check if command matches an alias name → run it
        if (!command.startsWith("-")) {
          const alias = (await ipcCall("getAlias", { name: command })) as AliasDetail | null;
          if (alias) {
            const { runAlias } = await import("./alias-runner.js");
            await runAlias(alias.filePath, parseRunArgs(args.slice(1)));
            break;
          }
        }

        printError(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
      }
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
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
    printError("Usage: mcp call <server> <tool> [json|@file] [--jq '<filter>'] [--full]");
    process.exit(1);
  }

  const [server, tool, ...rest] = resolved;
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
      console.error(`[mcp] ${(sizeBytes / 1024).toFixed(1)}KB response. Use --jq to filter.`);
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
    printError("Usage: mcp info <server> <tool>");
    process.exit(1);
  }

  const [server, tool] = resolved;
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
    printError("Usage: mcp grep <pattern>");
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
    printError("Usage: mcp auth <server>");
    process.exit(1);
  }

  const server = args[0];
  console.error(`Authenticating with ${server}...`);
  const result = (await ipcCall("triggerAuth", { server })) as { ok: boolean; message: string };
  console.error(result.message);
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
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  }

  // Inline JSON
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON argument: ${input}`);
  }
}

/** Read JSON from stdin (piped input) */
async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

// -- Help --

function printUsage(): void {
  console.log(`mcp — MCP tools from the command line

Usage:
  mcp ls                              List configured servers
  mcp ls <server>                     List tools for a server
  mcp tools <server>                  Alias for ls <server>
  mcp call <server> <tool> [json]     Call a tool (JSON from arg, @file, or stdin)
  mcp call <server/tool> [json]       Slash notation
  mcp <server> <tool> [json]          Shorthand for call
  mcp <server/tool> [json]            Shorthand with slash notation
  mcp info <server> <tool>            Show tool schema
  mcp info <server/tool>              Slash notation
  mcp grep <pattern>                  Search tools by name/description
  mcp search <query>                  Search local tools, then registry
  mcp install <slug>                  Install a server from the registry
  mcp registry search <query>         Search the MCP registry
  mcp registry list                   List available registry servers
  mcp add --transport {stdio|http|sse} <name> ...   Add a server
  mcp add-json <name> '<json>'        Add a server from raw JSON
  mcp remove <name>                   Remove a server
  mcp get <name>                      Inspect a server's config and status
  mcp auth <server>                   Authenticate with an OAuth server
  mcp config show                     Show resolved server config
  mcp config sources                  Show config file sources
  mcp status                          Daemon status
  mcp logs <server> [-f] [--lines N]  View server stderr output
  mcp typegen                         Generate TypeScript types for alias scripts
  mcp completions {bash|zsh|fish}     Generate shell completion script
  mcp restart [server]                Restart server connection(s)
  mcp shutdown                        Stop the daemon

Aliases:
  mcp alias ls                        List saved aliases
  mcp alias save <name> <@file | ->   Save a TypeScript alias script
  mcp alias show <name>               Print alias source
  mcp alias edit <name>               Open alias in $EDITOR
  mcp alias rm <name>                 Delete an alias
  mcp run <alias> [--key value ...]   Run an alias with arguments
  mcp <alias> [--key value ...]       Shorthand for run

Options:
  --format json, -j                 Machine-readable JSON output (ls, info, grep, status)
  --jq '<filter>'                   Apply jq filter to call output (client-side)
  --full, -f                        Bypass output size protection (call)

Examples:
  mcp ls atlassian
  mcp ls --format json
  mcp ls atlassian -j
  mcp call atlassian search '{"query":"sprint planning"}'
  mcp call atlassian/search '{"query":"sprint planning"}'
  mcp atlassian search '{"query":"sprint planning"}'
  mcp atlassian/search '{"query":"sprint planning"}'
  mcp call atlassian getJiraIssue @issue.json
  echo '{"query":"test"}' | mcp call atlassian search
  mcp info atlassian getConfluencePage
  mcp info atlassian/getConfluencePage -j
  mcp grep confluence
  mcp status -j
  mcp alias save get-time @get-time.ts
  mcp run get-time`);
}

main().then(() => process.exit(0));
