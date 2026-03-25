/**
 * MCP Registry API client for the control package.
 *
 * Lightweight fetch-based client that talks directly to Anthropic's
 * public MCP server registry. Mirrors the API from packages/command
 * but avoids the cross-package dependency.
 *
 * Pure functions + I/O — no React dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_CACHE_TTL_MS, options } from "@mcp-cli/core";

const REGISTRY_BASE = "https://api.anthropic.com/mcp-registry/v0";

// -- Types --

export interface RegistryRemote {
  type: "streamable-http" | "sse";
  url: string;
}

export interface RegistryEnvVar {
  name: string;
  isRequired: boolean;
  isSecret: boolean;
  description?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  runtimeHint: string;
  transport: { type: "stdio" };
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryServerData {
  name: string;
  title: string;
  description: string;
  version: string;
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}

export interface RegistryMeta {
  slug: string;
  displayName: string;
  oneLiner: string;
  toolNames?: string[];
  isAuthless: boolean;
  claudeCodeCopyText?: string;
  worksWith?: string[];
  documentation?: string;
}

export interface RegistryEntry {
  server: RegistryServerData;
  _meta: { "com.anthropic.api/mcp-registry": RegistryMeta };
}

export interface RegistryResponse {
  servers: RegistryEntry[];
  metadata: { count: number; nextCursor?: string };
}

// -- Cache helpers --

let _cacheDir = options.CACHE_DIR;

/** @internal Override cache directory (for tests). Pass null to reset. */
export function _setCacheDir(dir: string | null): void {
  _cacheDir = dir ?? options.CACHE_DIR;
}

interface CacheEntry {
  timestamp: number;
  data: RegistryResponse;
}

function cacheKeyFor(url: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(url);
  return hasher.digest("hex").slice(0, 16);
}

function readCache(url: string, ignoreTtl = false): RegistryResponse | null {
  try {
    const path = join(_cacheDir, `${cacheKeyFor(url)}.json`);
    const entry = JSON.parse(readFileSync(path, "utf-8")) as CacheEntry;
    if (ignoreTtl || Date.now() - entry.timestamp < REGISTRY_CACHE_TTL_MS) {
      return entry.data;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(url: string, data: RegistryResponse): void {
  try {
    mkdirSync(_cacheDir, { recursive: true });
    const path = join(_cacheDir, `${cacheKeyFor(url)}.json`);
    const entry: CacheEntry = { timestamp: Date.now(), data };
    writeFileSync(path, JSON.stringify(entry));
  } catch {
    // cache write failure is non-fatal
  }
}

async function registryFetch(url: string): Promise<RegistryResponse> {
  const cached = readCache(url);
  if (cached) return cached;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // On network error, try serving stale cache
    const stale = readCache(url, true);
    if (stale) return stale;
    throw new Error("Failed to reach the MCP registry. Check your network connection.");
  }

  if (!res.ok) {
    throw new Error(`MCP registry returned ${res.status}`);
  }

  const data = (await res.json()) as RegistryResponse;
  writeCache(url, data);
  return data;
}

// -- Transport selection --

export interface TransportSelection {
  kind: "remote" | "package" | "templated";
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  commandArgs?: string[];
  envVars?: RegistryEnvVar[];
}

function isTemplated(url: string): boolean {
  return /\{\{.+?\}\}/.test(url);
}

export function selectTransport(entry: RegistryEntry): TransportSelection | null {
  const { remotes, packages } = entry.server;

  const httpRemote = remotes?.find((r) => r.type === "streamable-http" && !isTemplated(r.url));
  if (httpRemote) return { kind: "remote", transport: "http", url: httpRemote.url };

  const sseRemote = remotes?.find((r) => r.type === "sse" && !isTemplated(r.url));
  if (sseRemote) return { kind: "remote", transport: "sse", url: sseRemote.url };

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
    return { kind: "package", transport: "stdio", command, commandArgs, envVars: pkg.environmentVariables };
  }

  const templated = remotes?.find((r) => isTemplated(r.url));
  if (templated) {
    return { kind: "templated", transport: templated.type === "streamable-http" ? "http" : "sse", url: templated.url };
  }

  return null;
}

// -- Public API functions --

export async function searchRegistry(query: string, limit?: number): Promise<RegistryResponse> {
  const params = new URLSearchParams({ search: query, version: "latest", visibility: "commercial" });
  if (limit) params.set("limit", String(limit));
  return registryFetch(`${REGISTRY_BASE}/servers?${params}`);
}

export async function listRegistry(limit?: number): Promise<RegistryResponse> {
  const params = new URLSearchParams({ version: "latest", visibility: "commercial" });
  if (limit) params.set("limit", String(limit));
  return registryFetch(`${REGISTRY_BASE}/servers?${params}`);
}
