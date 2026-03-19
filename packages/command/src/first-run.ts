/**
 * First-run prompt: when .mcp.json is detected in CWD but no project config
 * exists in ~/.mcp-cli/projects/, show a one-time informational message.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpConfigFile } from "@mcp-cli/core";
import { PROJECT_MCP_FILENAME, projectConfigPath, readCliConfig, writeCliConfig } from "@mcp-cli/core";

/**
 * Check for .mcp.json and show import prompt if this is the first run
 * for this directory. Writes to stderr only. No-op if already prompted
 * or if no .mcp.json exists.
 */
export function maybeShowFirstRunPrompt(cwd = process.cwd()): void {
  const resolvedCwd = resolve(cwd);

  // Check for .mcp.json in CWD (not walking up — only CWD for first-run)
  const mcpJsonPath = `${resolvedCwd}/${PROJECT_MCP_FILENAME}`;
  if (!existsSync(mcpJsonPath)) return;

  // Check if project config already exists
  const projConfig = projectConfigPath(resolvedCwd);
  if (existsSync(projConfig)) return;

  // Check if we already prompted for this directory
  const config = readCliConfig();
  const prompted = config.promptedDirs ?? [];
  if (prompted.includes(resolvedCwd)) return;

  // Count servers in .mcp.json
  let serverCount = 0;
  let serverNames: string[] = [];
  try {
    const content = readFileSync(mcpJsonPath, "utf-8");
    const parsed = JSON.parse(content) as McpConfigFile;
    if (parsed.mcpServers) {
      serverNames = Object.keys(parsed.mcpServers);
      serverCount = serverNames.length;
    }
  } catch {
    // Malformed .mcp.json — skip prompt
    return;
  }

  if (serverCount === 0) return;

  // Show the prompt
  const nameList = serverNames.length <= 5 ? serverNames.join(", ") : `${serverNames.slice(0, 4).join(", ")}, ...`;
  console.error(`Found ${PROJECT_MCP_FILENAME} with ${serverCount} server(s) (${nameList}).`);
  console.error("Run `mcx import` to add them, or `mcx import .` to anchor to this directory.");

  // Mark as prompted
  writeCliConfig({ ...config, promptedDirs: [...prompted, resolvedCwd] });
}
