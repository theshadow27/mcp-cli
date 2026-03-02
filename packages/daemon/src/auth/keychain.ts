/**
 * Read Claude Code OAuth tokens from macOS Keychain.
 *
 * Claude Code stores MCP OAuth credentials under service "Claude Code-credentials"
 * in the macOS Keychain. Each entry is keyed by "serverName|hash" and contains
 * the server URL, tokens, client info, and discovery state.
 */

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export interface KeychainTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  scope?: string;
  discoveryState?: OAuthDiscoveryState;
}

interface KeychainEntry {
  serverName: string;
  serverUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  scope?: string;
  discoveryState?: {
    authorizationServerUrl: string;
    authorizationServerMetadata?: Record<string, unknown>;
    resourceMetadata?: Record<string, unknown>;
    resourceMetadataUrl?: string;
  };
}

interface KeychainData {
  mcpOAuth?: Record<string, KeychainEntry>;
}

/**
 * Read Claude Code OAuth tokens from macOS Keychain, matching by server URL.
 * Returns null if not on macOS, no tokens found, or URL doesn't match.
 */
export async function readKeychainTokens(serverUrl: string): Promise<KeychainTokens | null> {
  if (process.platform !== "darwin") return null;

  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const data: KeychainData = JSON.parse(raw.trim());
    const mcpOAuth = data.mcpOAuth;
    if (!mcpOAuth) return null;

    // Find entry matching our server URL
    for (const entry of Object.values(mcpOAuth)) {
      if (entry.serverUrl === serverUrl) {
        // Check if token is expired
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
          // Token expired but we may still have a refresh token
          if (!entry.refreshToken) return null;
        }

        return {
          accessToken: entry.accessToken,
          refreshToken: entry.refreshToken,
          expiresAt: entry.expiresAt,
          clientId: entry.clientId,
          scope: entry.scope ?? undefined,
          discoveryState: entry.discoveryState as OAuthDiscoveryState | undefined,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
