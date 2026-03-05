/**
 * MCP Registry API client.
 *
 * Talks to Anthropic's public MCP server registry.
 * Uses native fetch() — no daemon IPC needed.
 * Caches responses locally for speed and offline use.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_CACHE_TTL_MS, options } from "@mcp-cli/core";

const REGISTRY_BASE = "https://api.anthropic.com/mcp-registry/v0";

// -- API response types --

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

// -- API functions --

export interface RegistryOpts {
  limit?: number;
  cursor?: string;
  noCache?: boolean;
}

export async function searchRegistry(query: string, opts?: RegistryOpts): Promise<RegistryResponse> {
  const params = new URLSearchParams({
    search: query,
    version: "latest",
    visibility: "commercial",
  });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);

  return registryFetch(`${REGISTRY_BASE}/servers?${params}`, opts?.noCache);
}

export async function listRegistry(opts?: RegistryOpts): Promise<RegistryResponse> {
  const params = new URLSearchParams({
    version: "latest",
    visibility: "commercial",
  });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);

  return registryFetch(`${REGISTRY_BASE}/servers?${params}`, opts?.noCache);
}

async function registryFetch(url: string, noCache?: boolean): Promise<RegistryResponse> {
  if (!noCache) {
    const cached = readCache(url);
    if (cached) return cached;
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    // On network error, try serving stale cache for offline use
    if (!noCache) {
      const stale = readCache(url, true);
      if (stale) return stale;
    }
    if (err instanceof TypeError) {
      throw new Error("Failed to reach the MCP registry. Check your network connection.");
    }
    throw err;
  }

  if (!res.ok) {
    throw new Error(`MCP registry returned ${res.status}`);
  }

  const data = (await res.json()) as RegistryResponse;
  writeCache(url, data);
  return data;
}
