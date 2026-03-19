/**
 * `mcx update` — check for and apply updates to registry-installed servers.
 *
 * Compares installed server config against latest registry metadata.
 * If the URL, package version, or command has changed, updates the config.
 */

import { printError } from "../output";
import { extractJsonFlag, parseScope } from "../parse";
import { type RegistryOpts, type RegistryResponse, searchRegistry as realSearchRegistry } from "../registry/client";
import { buildConfigFromSelection, selectTransport } from "../registry/transport";
import { CONFIG_SCOPES, type ConfigScope, addServerToConfig, readConfigFile, resolveConfigPath } from "./config-file";

export interface UpdateDeps {
  searchRegistry: (query: string, opts?: RegistryOpts) => Promise<RegistryResponse>;
}

const defaultDeps: UpdateDeps = { searchRegistry: realSearchRegistry };

export interface ParsedUpdateArgs {
  slug?: string;
  all: boolean;
  scope: ConfigScope;
  json: boolean;
  noCache: boolean;
}

export function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const { json, rest } = extractJsonFlag(args);

  let scope: ConfigScope = "user";
  let all = false;
  let noCache = false;
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "--all" || arg === "-a") {
      all = true;
    } else if (arg === "--scope" || arg === "-s") {
      scope = parseScope(rest[++i], CONFIG_SCOPES);
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const slug = positional[0];
  if (!slug && !all) {
    throw new Error("Usage: mcx update <slug> or mcx update --all");
  }

  return { slug, all, scope, json, noCache };
}

export interface UpdateResult {
  name: string;
  status: "updated" | "up-to-date" | "not-found" | "skipped";
  oldConfig?: Record<string, unknown>;
  newConfig?: Record<string, unknown>;
}

/** Deep-compare two configs for equality (ignoring key order). */
function configsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function updateSingle(
  name: string,
  scope: ConfigScope,
  noCache: boolean,
  deps: UpdateDeps,
): Promise<UpdateResult> {
  const path = resolveConfigPath(scope);
  const configFile = readConfigFile(path);
  const installed = configFile.mcpServers?.[name];

  if (!installed) {
    return { name, status: "not-found" };
  }

  let result: RegistryResponse;
  try {
    result = await deps.searchRegistry(name, { noCache });
  } catch {
    return { name, status: "skipped" };
  }

  const entry = result.servers.find((s) => s._meta["com.anthropic.api/mcp-registry"].slug === name);
  if (!entry) {
    return { name, status: "not-found" };
  }

  const selection = selectTransport(entry);
  if (!selection || selection.kind === "templated") {
    return { name, status: "skipped" };
  }

  const newConfig = buildConfigFromSelection(selection);

  if (configsEqual(installed, newConfig)) {
    return { name, status: "up-to-date" };
  }

  addServerToConfig(scope, name, newConfig);
  return {
    name,
    status: "updated",
    oldConfig: installed as unknown as Record<string, unknown>,
    newConfig: newConfig as unknown as Record<string, unknown>,
  };
}

export async function cmdUpdate(args: string[], deps?: UpdateDeps): Promise<void> {
  const d = deps ?? defaultDeps;
  if (args.length === 0) {
    printError("Usage: mcx update <slug> [--scope user|project] or mcx update --all");
    process.exit(1);
  }

  const parsed = parseUpdateArgs(args);
  const results: UpdateResult[] = [];

  if (parsed.all) {
    const path = resolveConfigPath(parsed.scope);
    const configFile = readConfigFile(path);
    const servers = Object.keys(configFile.mcpServers ?? {});

    if (servers.length === 0) {
      console.error("No servers configured.");
      return;
    }

    for (const name of servers) {
      const result = await updateSingle(name, parsed.scope, parsed.noCache, d);
      results.push(result);

      if (!parsed.json) {
        switch (result.status) {
          case "updated":
            console.error(`Updated "${name}"`);
            break;
          case "up-to-date":
            console.error(`"${name}" is up to date`);
            break;
          case "not-found":
            // Skip — not a registry server
            break;
          case "skipped":
            break;
        }
      }
    }
  } else {
    const slug = parsed.slug as string; // guaranteed by parseUpdateArgs
    const result = await updateSingle(slug, parsed.scope, parsed.noCache, d);
    results.push(result);

    if (!parsed.json) {
      switch (result.status) {
        case "updated":
          console.error(`Updated "${result.name}"`);
          break;
        case "up-to-date":
          console.error(`"${result.name}" is already up to date`);
          break;
        case "not-found":
          throw new Error(
            `Server "${parsed.slug}" not found. Is it installed? Use "mcx install ${parsed.slug}" first.`,
          );
        case "skipped":
          console.error(`Skipped "${result.name}" (no usable transport)`);
          break;
      }
    }
  }

  if (parsed.json) {
    console.log(JSON.stringify(parsed.all ? results : results[0], null, 2));
  }
}
