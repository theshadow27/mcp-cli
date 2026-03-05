/**
 * Transport selection and ServerConfig building from registry entries.
 *
 * Pure functions, no I/O.
 */

import type { ServerConfig } from "@mcp-cli/core";
import type { RegistryEntry, RegistryEnvVar } from "./client";

export interface TransportSelection {
  kind: "remote" | "package" | "templated";
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  commandArgs?: string[];
  envVars?: RegistryEnvVar[];
}

/** Check if a URL contains template placeholders like {{var}} */
function isTemplated(url: string): boolean {
  return /\{\{.+?\}\}/.test(url);
}

/**
 * Select the best transport from a registry entry.
 *
 * Priority: streamable-http > sse > package (stdio) > templated > null
 */
export function selectTransport(entry: RegistryEntry): TransportSelection | null {
  const { remotes, packages } = entry.server;

  // 1. Non-templated streamable-http remote
  const httpRemote = remotes?.find((r) => r.type === "streamable-http" && !isTemplated(r.url));
  if (httpRemote) {
    return { kind: "remote", transport: "http", url: httpRemote.url };
  }

  // 2. Non-templated SSE remote
  const sseRemote = remotes?.find((r) => r.type === "sse" && !isTemplated(r.url));
  if (sseRemote) {
    return { kind: "remote", transport: "sse", url: sseRemote.url };
  }

  // 3. Package with runtimeHint (stdio)
  const pkg = packages?.find((p) => p.runtimeHint);
  if (pkg) {
    const hint = pkg.runtimeHint;
    const id = pkg.identifier;
    let command: string;
    let commandArgs: string[];

    if (hint === "npx") {
      command = "npx";
      commandArgs = ["-y", id];
    } else if (hint === "uvx") {
      command = "uvx";
      commandArgs = [id];
    } else {
      command = hint;
      commandArgs = [id];
    }

    return {
      kind: "package",
      transport: "stdio",
      command,
      commandArgs,
      envVars: pkg.environmentVariables,
    };
  }

  // 4. Templated remote (last resort)
  const templated = remotes?.find((r) => isTemplated(r.url));
  if (templated) {
    return {
      kind: "templated",
      transport: templated.type === "streamable-http" ? "http" : "sse",
      url: templated.url,
    };
  }

  // 5. Nothing usable
  return null;
}

/**
 * Build a ServerConfig from a transport selection.
 *
 * Throws if the selection is templated (callers should handle that case).
 */
export function buildConfigFromSelection(
  selection: TransportSelection,
  envOverrides?: Record<string, string>,
): ServerConfig {
  if (selection.kind === "templated") {
    throw new Error("Cannot auto-configure a server with templated URLs. Manual setup required.");
  }

  if (selection.kind === "remote") {
    const url = selection.url ?? "";
    if (selection.transport === "http") {
      return { type: "http", url };
    }
    return { type: "sse", url };
  }

  // Package (stdio)
  const config: ServerConfig = {
    command: selection.command ?? "",
    args: selection.commandArgs,
  };

  // Merge env vars: required vars get empty-string placeholders, then overrides applied
  const envVars = selection.envVars?.filter((v) => v.isRequired) ?? [];
  if (envVars.length > 0 || (envOverrides && Object.keys(envOverrides).length > 0)) {
    const env: Record<string, string> = {};
    for (const v of envVars) {
      env[v.name] = "";
    }
    if (envOverrides) {
      Object.assign(env, envOverrides);
    }
    (config as { env?: Record<string, string> }).env = env;
  }

  return config;
}
