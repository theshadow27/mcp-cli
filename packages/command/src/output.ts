/**
 * Output formatting for CLI results.
 *
 * JSON to stdout (pipeable), errors/status to stderr.
 */

import { type JsonSchema, jsonSchemaToTs } from "@mcp-cli/core";
import type { RegistryEntry } from "./registry/client.js";

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
};

/**
 * Format a tool call result into a string (pure, no side effects).
 * Returns the formatted text content.
 */
export function formatToolResult(result: unknown): string {
  if (result === null || result === undefined) return "";

  // MCP tool results have a content[] array
  if (typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (item.type === "text" && item.text) {
          parts.push(formatJson(item.text));
        } else {
          parts.push(JSON.stringify(item, null, 2));
        }
      }
      return parts.join("\n");
    }
  }

  // Fallback: print as JSON
  return JSON.stringify(result, null, 2);
}

/** Format and print a tool call result to stdout */
export function printToolResult(result: unknown): void {
  const text = formatToolResult(result);
  if (text) console.log(text);
}

/** Try to pretty-format as JSON string, fallback to raw text */
function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Print a server list in compact format */
export function printServerList(
  servers: Array<{
    name: string;
    transport: string;
    state: string;
    toolCount: number;
    source: string;
    recentStderr?: string[];
  }>,
): void {
  if (servers.length === 0) {
    console.error("No MCP servers configured.");
    return;
  }

  const maxName = Math.max(...servers.map((s) => s.name.length));

  for (const s of servers) {
    const stateColor = s.state === "connected" ? c.green : s.state === "error" ? c.red : c.dim;
    console.log(
      `  ${c.cyan}${s.name.padEnd(maxName)}${c.reset}  ${stateColor}${s.state.padEnd(12)}${c.reset}  ${c.dim}${s.transport}${c.reset}  ${s.toolCount > 0 ? `${s.toolCount} tools` : ""}`,
    );
    // Show last stderr line for error-state servers
    if (s.state === "error" && s.recentStderr?.length) {
      const lastLine = s.recentStderr[s.recentStderr.length - 1];
      console.log(`  ${"".padEnd(maxName)}  ${c.dim}stderr: ${lastLine}${c.reset}`);
    }
  }
  console.log(`\n${servers.length} server(s)`);
}

/** Print a tool list in compact format */
export function printToolList(
  tools: Array<{
    name: string;
    server: string;
    description: string;
  }>,
): void {
  if (tools.length === 0) {
    console.error("No tools found.");
    return;
  }

  const maxName = Math.max(...tools.map((t) => t.name.length));
  const maxServer = Math.max(...tools.map((t) => t.server.length));

  for (const t of tools) {
    const desc = t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
    console.log(
      `  ${c.green}${t.name.padEnd(maxName)}${c.reset}  ${c.dim}${t.server.padEnd(maxServer)}${c.reset}  ${desc}`,
    );
  }
  console.log(`\n${tools.length} tool(s)`);
}

/** Print a single tool's schema info */
export function printToolInfo(tool: {
  name: string;
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
  signature?: string;
}): void {
  console.log(`${c.bold}${tool.server}/${tool.name}${c.reset}`);
  if (tool.description) {
    console.log(`${c.dim}${tool.description}${c.reset}\n`);
  }

  if (tool.signature) {
    console.log(`${c.cyan}${tool.signature}${c.reset}\n`);
  }

  // Print input schema as compact TS-like notation
  const schema = tool.inputSchema as JsonSchema;
  const props = schema.properties;
  const required = schema.required ?? [];

  if (props) {
    console.log("Parameters:");
    for (const [name, propSchema] of Object.entries(props)) {
      const isRequired = required.includes(name);
      const typeStr = jsonSchemaToTs(propSchema as JsonSchema);
      const optMark = isRequired ? "" : "?";
      const desc = (propSchema as JsonSchema).description
        ? `  ${c.dim}// ${(propSchema as JsonSchema).description}${c.reset}`
        : "";
      console.log(`  ${c.yellow}${name}${optMark}${c.reset}: ${typeStr}${desc}`);
    }
  }
}

/** Print a list of aliases */
export function printAliasList(
  aliases: Array<{ name: string; description: string; filePath: string; updatedAt: number }>,
): void {
  if (aliases.length === 0) {
    console.error("No aliases saved. Use `mcp alias save <name> <@file | ->` to create one.");
    return;
  }

  const maxName = Math.max(...aliases.map((a) => a.name.length));

  for (const a of aliases) {
    const desc = a.description ? `  ${c.dim}${a.description}${c.reset}` : "";
    console.log(`  ${c.green}${a.name.padEnd(maxName)}${c.reset}  ${a.filePath}${desc}`);
  }
  console.log(`\n${aliases.length} alias(es)`);
}

/** Print a list of registry servers */
export function printRegistryList(entries: RegistryEntry[]): void {
  if (entries.length === 0) {
    console.error("No servers found.");
    return;
  }

  const maxSlug = Math.max(...entries.map((e) => e._meta["com.anthropic.api/mcp-registry"].slug.length));
  const maxName = Math.max(...entries.map((e) => e._meta["com.anthropic.api/mcp-registry"].displayName.length));

  for (const e of entries) {
    const meta = e._meta["com.anthropic.api/mcp-registry"];
    const oneLiner = meta.oneLiner.length > 60 ? `${meta.oneLiner.slice(0, 57)}...` : meta.oneLiner;
    const toolCount = meta.toolNames?.length ?? 0;
    const tools = toolCount > 0 ? `${c.dim}${toolCount} tools${c.reset}` : "";
    console.log(
      `  ${c.cyan}${meta.slug.padEnd(maxSlug)}${c.reset}  ${c.bold}${meta.displayName.padEnd(maxName)}${c.reset}  ${oneLiner}  ${tools}`,
    );
  }
  console.log(`\n${entries.length} server(s)`);
}

/** Print an error to stderr */
export function printError(message: string): void {
  console.error(`${c.red}Error${c.reset}: ${message}`);
}
