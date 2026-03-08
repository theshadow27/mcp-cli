/**
 * `mcx install` — install a server from the Anthropic MCP registry.
 *
 * Searches the registry by slug, selects the best transport,
 * and writes the config via addServerToConfig.
 */

import { printError } from "../output";
import { extractJsonFlag, parseEnvVar, parseScope } from "../parse";
import { searchRegistry } from "../registry/client";
import { buildConfigFromSelection, selectTransport } from "../registry/transport";
import { CONFIG_SCOPES, type ConfigScope, addServerToConfig, resolveConfigPath } from "./config-file";

export interface ParsedInstallArgs {
  slug: string;
  name?: string;
  scope: ConfigScope;
  env: Record<string, string>;
  json: boolean;
  noCache: boolean;
}

export function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const { json, rest } = extractJsonFlag(args);

  let scope: ConfigScope = "user";
  let name: string | undefined;
  let noCache = false;
  const env: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "--as") {
      name = rest[++i];
      if (!name) throw new Error("--as requires a name");
    } else if (arg === "--scope" || arg === "-s") {
      scope = parseScope(rest[++i], CONFIG_SCOPES);
    } else if (arg === "--env" || arg === "-e") {
      const [key, value] = parseEnvVar(rest[++i]);
      env[key] = value;
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const slug = positional[0];
  if (!slug) {
    throw new Error("Server slug is required. Usage: mcx install <slug> [--as name] [--scope user|project]");
  }

  return { slug, name, scope, env, json, noCache };
}

export async function cmdInstall(args: string[]): Promise<void> {
  if (args.length === 0) {
    printError("Usage: mcx install <slug> [--as name] [--scope user|project] [--env KEY=VALUE]");
    process.exit(1);
  }

  const parsed = parseInstallArgs(args);

  // Search registry for exact slug match
  const result = await searchRegistry(parsed.slug, { noCache: parsed.noCache });
  const entry = result.servers.find((s) => s._meta["com.anthropic.api/mcp-registry"].slug === parsed.slug);

  if (!entry) {
    throw new Error(`Server "${parsed.slug}" not found. Use "mcx registry search ${parsed.slug}" to find servers.`);
  }

  const meta = entry._meta["com.anthropic.api/mcp-registry"];
  const selection = selectTransport(entry);

  if (!selection) {
    throw new Error(`No usable transport found for "${parsed.slug}".`);
  }

  // Handle templated URLs — show instructions instead of installing
  if (selection.kind === "templated") {
    console.error(`Server "${meta.displayName}" requires manual configuration.`);
    console.error(`URL template: ${selection.url}`);
    if (meta.claudeCodeCopyText) {
      console.error(`\nClaude Code config:\n  ${meta.claudeCodeCopyText}`);
    }
    if (meta.documentation) {
      console.error(`\nDocumentation: ${meta.documentation}`);
    }
    process.exit(1);
  }

  // Warn about required env vars that aren't provided
  const requiredEnv = selection.envVars?.filter((v) => v.isRequired) ?? [];
  const missingEnv = requiredEnv.filter((v) => !parsed.env[v.name]);
  if (missingEnv.length > 0) {
    console.error("Warning: required environment variables not set:");
    for (const v of missingEnv) {
      const desc = v.description ? ` — ${v.description}` : "";
      console.error(`  ${v.name}${desc}`);
    }
    console.error("Set them with --env KEY=VALUE or edit the config file after install.\n");
  }

  const config = buildConfigFromSelection(selection, parsed.env);
  const serverName = parsed.name ?? parsed.slug;
  const existed = addServerToConfig(parsed.scope, serverName, config);
  const path = resolveConfigPath(parsed.scope);

  if (existed) {
    console.error(`Warning: overwrote existing server "${serverName}"`);
  }
  console.error(`Installed "${meta.displayName}" as "${serverName}" → ${path}`);

  if (parsed.json) {
    console.log(JSON.stringify({ name: serverName, config, path }, null, 2));
  }
}
