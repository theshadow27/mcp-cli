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
import { cmdAlias } from "./commands/alias.js";
import { cmdConfig } from "./commands/config.js";
import { cmdLogs } from "./commands/logs.js";
import { cmdRun, parseRunArgs } from "./commands/run.js";
import { cmdTypegen } from "./commands/typegen.js";
import { printError, printServerList, printToolInfo, printToolList, printToolResult } from "./output.js";

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
        await cmdLs(args.slice(1));
        break;

      case "call":
        await cmdCall(args.slice(1));
        break;

      case "info":
        await cmdInfo(args.slice(1));
        break;

      case "grep":
      case "search":
        await cmdGrep(args.slice(1));
        break;

      case "status":
        await cmdStatus();
        break;

      case "config":
        await cmdConfig(args.slice(1));
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

      case "restart":
        await cmdRestart(args.slice(1));
        break;

      case "shutdown":
        await ipcCall("shutdown");
        console.error("Daemon shut down.");
        break;

      default: {
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
  const serverName = args[0];

  if (serverName) {
    // List tools for a specific server
    const tools = (await ipcCall("listTools", { server: serverName })) as ToolInfo[];
    printToolList(tools);
  } else {
    // List servers
    const servers = (await ipcCall("listServers")) as ServerStatus[];
    printServerList(servers);
  }
}

async function cmdCall(args: string[]): Promise<void> {
  if (args.length < 2) {
    printError("Usage: mcp call <server> <tool> [json|@file]");
    process.exit(1);
  }

  const [server, tool, ...rest] = args;
  const inputArg = rest.join(" ").trim();
  const toolArgs = await parseToolArgs(inputArg);

  const result = await ipcCall("callTool", { server, tool, arguments: toolArgs });
  printToolResult(result);
}

async function cmdInfo(args: string[]): Promise<void> {
  if (args.length < 2) {
    printError("Usage: mcp info <server> <tool>");
    process.exit(1);
  }

  const [server, tool] = args;
  const info = (await ipcCall("getToolInfo", { server, tool })) as ToolInfo & {
    inputSchema: Record<string, unknown>;
  };
  printToolInfo(info);
}

async function cmdGrep(args: string[]): Promise<void> {
  if (args.length === 0) {
    printError("Usage: mcp grep <pattern>");
    process.exit(1);
  }

  const pattern = args.join(" ");
  const tools = (await ipcCall("grepTools", { pattern })) as ToolInfo[];
  printToolList(tools);
}

async function cmdStatus(): Promise<void> {
  const status = (await ipcCall("status")) as DaemonStatus;

  console.log(`Daemon PID: ${status.pid}`);
  console.log(`Uptime: ${Math.round(status.uptime)}s`);
  console.log(`Database: ${status.dbPath}\n`);
  printServerList(status.servers);
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
  mcp call <server> <tool> [json]     Call a tool (JSON from arg, @file, or stdin)
  mcp <server> <tool> [json]          Shorthand for call
  mcp info <server> <tool>            Show tool schema
  mcp grep <pattern>                  Search tools by name/description
  mcp auth <server>                   Authenticate with an OAuth server
  mcp config show                     Show resolved server config
  mcp config sources                  Show config file sources
  mcp status                          Daemon status
  mcp logs <server> [-f] [--lines N]  View server stderr output
  mcp typegen                         Generate TypeScript types for alias scripts
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

Examples:
  mcp ls atlassian
  mcp call atlassian search '{"query":"sprint planning"}'
  mcp atlassian search '{"query":"sprint planning"}'
  mcp call atlassian getJiraIssue @issue.json
  echo '{"query":"test"}' | mcp call atlassian search
  mcp info atlassian getConfluencePage
  mcp grep confluence
  mcp alias save get-time @get-time.ts
  mcp run get-time`);
}

main().then(() => process.exit(0));
