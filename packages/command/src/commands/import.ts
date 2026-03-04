/**
 * `mcp import` — import servers from external config files into mcp-cli's own config.
 *
 * Source resolution:
 *   mcp import                  Walk up from CWD to find .mcp.json, import those servers
 *   mcp import <file>           Import from a specific JSON config file
 *   mcp import . | <dir>        Import from .mcp.json in the given directory (project scope)
 *
 * Target:
 *   --scope user    → ~/.mcp-cli/servers.json (default for file / no-arg)
 *   --scope project → ~/.mcp-cli/projects/{mangled-cwd}/servers.json (default for . / dir)
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpConfigFile } from "@mcp-cli/core";
import { PROJECT_MCP_FILENAME, findFileUpward } from "@mcp-cli/core";
import { printError } from "../output.js";
import { type ConfigScope, addServerToConfig, resolveConfigPath } from "./config-file.js";

export async function cmdImport(args: string[]): Promise<void> {
  // Parse flags
  let scope: ConfigScope | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" || arg === "-s") {
      const val = args[++i];
      if (val !== "user" && val !== "project") {
        throw new Error(`Invalid scope "${val}": must be user or project`);
      }
      scope = val;
    } else if (arg === "--help" || arg === "-h") {
      printImportUsage();
      return;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const source = positional[0];
  const { filePath, defaultScope } = resolveSource(source);
  const effectiveScope = scope ?? defaultScope;

  // Read and validate source file
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read ${filePath}`);
  }

  let config: McpConfigFile;
  try {
    config = JSON.parse(content) as McpConfigFile;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }

  const servers = config.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    console.error(`No servers found in ${filePath}`);
    return;
  }

  // Import each server
  const names = Object.keys(servers);
  let overwritten = 0;
  for (const name of names) {
    const existed = addServerToConfig(effectiveScope, name, servers[name]);
    if (existed) overwritten++;
  }

  const targetPath = resolveConfigPath(effectiveScope);
  console.error(`Imported ${names.length} server(s) from ${filePath} → ${targetPath}`);
  for (const name of names) {
    console.error(`  ${name}`);
  }
  if (overwritten > 0) {
    console.error(`(${overwritten} existing server(s) overwritten)`);
  }
}

interface ResolvedSource {
  filePath: string;
  defaultScope: ConfigScope;
}

function resolveSource(source: string | undefined): ResolvedSource {
  // No arg: walk up to find .mcp.json
  if (!source) {
    const found = findFileUpward(PROJECT_MCP_FILENAME, process.cwd());
    if (!found) {
      throw new Error(`No ${PROJECT_MCP_FILENAME} found in ${process.cwd()} or any parent directory`);
    }
    return { filePath: found, defaultScope: "user" };
  }

  const resolved = resolve(source);

  // Directory: look for .mcp.json inside it
  if (existsSync(resolved) && lstatSync(resolved).isDirectory()) {
    const candidate = join(resolved, PROJECT_MCP_FILENAME);
    if (!existsSync(candidate)) {
      throw new Error(`No ${PROJECT_MCP_FILENAME} found in ${resolved}`);
    }
    return { filePath: candidate, defaultScope: "project" };
  }

  // File path
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return { filePath: resolved, defaultScope: "user" };
}

function printImportUsage(): void {
  console.log(`mcp import — import servers from external config files

Usage:
  mcp import                          Find .mcp.json by walking up, import servers
  mcp import <file>                   Import from a specific config file
  mcp import .                        Import from .mcp.json in CWD (project scope)
  mcp import <dir>                    Import from .mcp.json in directory (project scope)

Options:
  --scope user|project                Override target scope (default varies by source)
  -s                                  Shorthand for --scope

Servers are copied into mcp-cli's own config. The daemon picks up changes automatically.`);
}
