/**
 * `mcx export` — export mcp-cli server configs to a standard .mcp.json file.
 *
 * Source:
 *   --scope user       ~/.mcp-cli/servers.json (default)
 *   --scope project    ~/.mcp-cli/projects/{mangled-cwd}/servers.json
 *   --all              Both scopes merged (project first, user overrides)
 *
 * Filtering:
 *   --server <name>    Export only specific servers (repeatable)
 *
 * Output:
 *   mcx export <file>           Write to file
 *   mcx export (no file arg)    Write to stdout
 */

import { writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { options, projectConfigPath } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { parseScope } from "../parse";
import { CONFIG_SCOPES_NO_LOCAL, readConfigFile } from "./config-file";

type ExportScope = "user" | "project";

export async function cmdExport(args: string[]): Promise<void> {
  const { flags, positionals, errors, help } = parseFlags(args, {
    scope: { type: "string", alias: "s" },
    server: { type: "string", repeatable: true },
    all: { type: "boolean", alias: "a" },
  });

  if (help) {
    printExportUsage();
    return;
  }
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  const scope = flags.scope ? parseScope(flags.scope as string, CONFIG_SCOPES_NO_LOCAL) : undefined;
  const serverFilter = flags.server as string[];
  const all = flags.all === true;

  if (all && scope) {
    throw new Error("Cannot use --all with --scope");
  }

  const outputFile = positionals[0];

  // Collect servers from the requested scope(s)
  const servers: Record<string, ServerConfig> = {};

  if (all) {
    // Merge both: project first, user overrides
    const projectConfig = readConfigFile(projectConfigPath(process.cwd()));
    Object.assign(servers, projectConfig.mcpServers);
    const userConfig = readConfigFile(options.USER_SERVERS_PATH);
    Object.assign(servers, userConfig.mcpServers);
  } else {
    const effectiveScope = scope ?? "user";
    const configPath = effectiveScope === "project" ? projectConfigPath(process.cwd()) : options.USER_SERVERS_PATH;
    const config = readConfigFile(configPath);
    Object.assign(servers, config.mcpServers);
  }

  // Apply --server filter
  let filtered: Record<string, ServerConfig>;
  if (serverFilter.length > 0) {
    filtered = {};
    const missing: string[] = [];
    for (const name of serverFilter) {
      if (name in servers) {
        filtered[name] = servers[name];
      } else {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      console.error(`Warning: server(s) not found: ${missing.join(", ")}`);
    }
  } else {
    filtered = servers;
  }

  if (Object.keys(filtered).length === 0) {
    console.error("No servers to export.");
    return;
  }

  const output: McpConfigFile = { mcpServers: filtered };
  const json = `${JSON.stringify(output, null, 2)}\n`;

  if (outputFile) {
    const dir = dirname(outputFile);
    if (dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputFile, json);
    console.error(`Exported ${Object.keys(filtered).length} server(s) to ${outputFile}`);
    for (const name of Object.keys(filtered)) {
      console.error(`  ${name}`);
    }
  } else {
    // Write JSON to stdout for piping
    process.stdout.write(json);
  }
}

function printExportUsage(): void {
  console.log(`mcx export — export server configs to .mcp.json format

Usage:
  mcx export <file>                 Export servers to a file
  mcx export                        Export servers to stdout

Options:
  --scope user|project              Source scope (default: user)
  -s                                Shorthand for --scope
  --server <name>                   Export specific server(s) (repeatable)
  --all, -a                         Export all scopes merged
  --help, -h                        Show this help

Examples:
  mcx export .mcp.json              Export user servers to .mcp.json
  mcx export --scope project .mcp.json
  mcx export --server github --server notion .mcp.json
  mcx export --all servers.json     Export everything
  mcx export | jq .                 Pipe to jq`);
}
