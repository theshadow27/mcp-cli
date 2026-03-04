/**
 * MCP Registry API client.
 *
 * Talks to Anthropic's public MCP server registry.
 * Uses native fetch() — no daemon IPC needed.
 */

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

// -- API functions --

export async function searchRegistry(
  query: string,
  opts?: { limit?: number; cursor?: string },
): Promise<RegistryResponse> {
  const params = new URLSearchParams({
    search: query,
    version: "latest",
    visibility: "commercial",
  });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);

  return registryFetch(`${REGISTRY_BASE}/servers?${params}`);
}

export async function listRegistry(opts?: { limit?: number; cursor?: string }): Promise<RegistryResponse> {
  const params = new URLSearchParams({
    version: "latest",
    visibility: "commercial",
  });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);

  return registryFetch(`${REGISTRY_BASE}/servers?${params}`);
}

async function registryFetch(url: string): Promise<RegistryResponse> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error("Failed to reach the MCP registry. Check your network connection.");
    }
    throw err;
  }

  if (!res.ok) {
    throw new Error(`MCP registry returned ${res.status}`);
  }

  return (await res.json()) as RegistryResponse;
}
