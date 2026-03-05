/**
 * `mcx add` — register a new MCP server.
 * `mcx add-json` — register from raw JSON config.
 *
 * Writes to the config file directly; the daemon's ConfigWatcher picks up changes.
 */

import type { ServerConfig } from "@mcp-cli/core";
import { printError } from "../output";
import { type ConfigScope, addServerToConfig, resolveConfigPath } from "./config-file";

// -- Arg parsing --

export interface ParsedAddArgs {
  transport: "stdio" | "http" | "sse";
  name: string;
  url?: string;
  command?: string;
  commandArgs?: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  scope: ConfigScope;
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
}

/**
 * Parse `mcx add` arguments.
 *
 * Format: mcx add [flags...] <name> [<url> | -- <command> [args...]]
 *
 * Flags:
 *   --transport {stdio|http|sse}  (required)
 *   --env KEY=VALUE               (repeatable)
 *   --header "Name: Value"        (repeatable, http/sse only)
 *   --scope {user|project|local}  (default: user)
 */
export function parseAddArgs(args: string[]): ParsedAddArgs {
  // Split at -- separator (for stdio command)
  const ddIndex = args.indexOf("--");
  const flagArgs = ddIndex >= 0 ? args.slice(0, ddIndex) : args;
  const afterDd = ddIndex >= 0 ? args.slice(ddIndex + 1) : [];

  let transport: "stdio" | "http" | "sse" | undefined;
  let scope: ConfigScope = "user";
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let callbackPort: number | undefined;

  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];

    if (arg === "--transport" || arg === "-t") {
      const val = flagArgs[++i];
      if (val !== "stdio" && val !== "http" && val !== "sse") {
        throw new Error(`Invalid transport "${val}": must be stdio, http, or sse`);
      }
      transport = val;
    } else if (arg === "--env" || arg === "-e") {
      const val = flagArgs[++i];
      if (!val || !val.includes("=")) {
        throw new Error(`Invalid --env value "${val}": expected KEY=VALUE`);
      }
      const eqIndex = val.indexOf("=");
      env[val.slice(0, eqIndex)] = val.slice(eqIndex + 1);
    } else if (arg === "--header") {
      const val = flagArgs[++i];
      if (!val || !val.includes(":")) {
        throw new Error(`Invalid --header value "${val}": expected "Name: Value"`);
      }
      const colonIndex = val.indexOf(":");
      headers[val.slice(0, colonIndex).trim()] = val.slice(colonIndex + 1).trim();
    } else if (arg === "--scope" || arg === "-s") {
      const val = flagArgs[++i];
      if (val !== "user" && val !== "project" && val !== "local") {
        throw new Error(`Invalid scope "${val}": must be user, project, or local`);
      }
      scope = val;
    } else if (arg === "--client-id") {
      clientId = flagArgs[++i];
      if (!clientId) throw new Error("--client-id requires a value");
    } else if (arg === "--client-secret") {
      clientSecret = flagArgs[++i];
      if (!clientSecret) throw new Error("--client-secret requires a value");
    } else if (arg === "--callback-port") {
      const val = flagArgs[++i];
      if (!val) throw new Error("--callback-port requires a value");
      callbackPort = Number.parseInt(val, 10);
      if (!Number.isFinite(callbackPort) || callbackPort <= 0) {
        throw new Error(`Invalid --callback-port "${val}": must be a positive integer`);
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!transport) {
    throw new Error("--transport is required (stdio, http, or sse)");
  }

  const name = positional[0];
  if (!name) {
    throw new Error("Server name is required");
  }

  // Validate transport-specific args
  if (transport === "http" || transport === "sse") {
    const url = positional[1];
    if (!url) {
      throw new Error(`URL is required for ${transport} transport`);
    }
    if (afterDd.length > 0) {
      throw new Error(`-- command separator is not valid for ${transport} transport`);
    }
    return { transport, name, url, env, headers, scope, clientId, clientSecret, callbackPort };
  }

  // stdio
  if (Object.keys(headers).length > 0) {
    throw new Error("--header is not valid for stdio transport");
  }
  if (clientId || clientSecret || callbackPort) {
    throw new Error("--client-id, --client-secret, and --callback-port are not valid for stdio transport");
  }
  if (afterDd.length === 0) {
    throw new Error("stdio transport requires a command after --");
  }
  const [command, ...commandArgs] = afterDd;
  return { transport, name, command, commandArgs, env, headers, scope };
}

/** Build a ServerConfig from parsed args. Caller must ensure fields are valid (parseAddArgs does this). */
export function buildServerConfig(parsed: ParsedAddArgs): ServerConfig {
  if (parsed.transport === "http" || parsed.transport === "sse") {
    const url = parsed.url ?? "";
    const config: ServerConfig = parsed.transport === "http" ? { type: "http", url } : { type: "sse", url };
    if (Object.keys(parsed.headers).length > 0) config.headers = parsed.headers;
    if (parsed.clientId) config.clientId = parsed.clientId;
    if (parsed.clientSecret) config.clientSecret = parsed.clientSecret;
    if (parsed.callbackPort) config.callbackPort = parsed.callbackPort;
    return config;
  }
  // stdio
  const command = parsed.command ?? "";
  const config: ServerConfig = { command };
  if (parsed.commandArgs && parsed.commandArgs.length > 0) config.args = parsed.commandArgs;
  if (Object.keys(parsed.env).length > 0) config.env = parsed.env;
  return config;
}

// -- Commands --

export async function cmdAdd(args: string[]): Promise<void> {
  if (args.length === 0) {
    printError(
      'Usage: mcx add --transport {stdio|http|sse} [--env KEY=VALUE] [--header "Name: Value"] [--client-id ID] [--client-secret SECRET] [--callback-port PORT] [--scope {user|project}] <name> [<url> | -- <command> [args...]]',
    );
    process.exit(1);
  }

  const parsed = parseAddArgs(args);
  const config = buildServerConfig(parsed);
  const existed = addServerToConfig(parsed.scope, parsed.name, config);
  const path = resolveConfigPath(parsed.scope);

  if (existed) {
    console.error(`Warning: overwrote existing server "${parsed.name}"`);
  }
  console.error(`Added server "${parsed.name}" → ${path}`);
}

export async function cmdAddJson(args: string[]): Promise<void> {
  if (args.length < 2) {
    printError("Usage: mcx add-json <name> '<json>'");
    process.exit(1);
  }

  const [name, jsonStr, ...rest] = args;

  // Extract --scope flag from remaining args
  let scope: ConfigScope = "user";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--scope" || rest[i] === "-s") {
      const val = rest[++i];
      if (val !== "user" && val !== "project" && val !== "local") {
        throw new Error(`Invalid scope "${val}": must be user, project, or local`);
      }
      scope = val;
    }
  }

  let config: ServerConfig;
  try {
    config = JSON.parse(jsonStr) as ServerConfig;
  } catch {
    throw new Error(`Invalid JSON: ${jsonStr}`);
  }

  // Basic validation: must have either command (stdio) or url (http/sse)
  if (!("command" in config) && !("url" in config)) {
    throw new Error("Server config must have either 'command' (stdio) or 'url' (http/sse)");
  }

  const existed = addServerToConfig(scope, name, config);
  const path = resolveConfigPath(scope);

  if (existed) {
    console.error(`Warning: overwrote existing server "${name}"`);
  }
  console.error(`Added server "${name}" → ${path}`);
}
