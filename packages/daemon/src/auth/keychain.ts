/**
 * Read Claude Code OAuth tokens from macOS Keychain.
 *
 * Claude Code stores MCP OAuth credentials under service "Claude Code-credentials"
 * in the macOS Keychain. Each entry is keyed by "serverName|hash" and contains
 * the server URL, tokens, client info, and discovery state.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { options, spawnCapture } from "@mcp-cli/core";
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
  claudeAiOauth?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/**
 * Read Claude Code OAuth tokens from macOS Keychain, matching by server URL.
 * Returns null if not on macOS, no tokens found, or URL doesn't match.
 */
export async function readKeychainTokens(serverUrl: string): Promise<KeychainTokens | null> {
  if (process.platform !== "darwin") return null;

  try {
    const result = await spawnCapture("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    if (!result.ok) return null;

    const data: KeychainData = JSON.parse(result.stdout.trim());
    const mcpOAuth = data.mcpOAuth;
    if (!mcpOAuth) return null;

    // Find entry matching our server URL
    for (const entry of Object.values(mcpOAuth)) {
      if (entry.serverUrl === serverUrl) {
        // An entry is usable if it has a refresh token (we can refresh)
        // or a non-expired access token. Entries with only a clientId and
        // empty/zero tokens are pre-authorization artifacts — return null
        // so the SDK falls through to dynamic client registration.
        const hasAccessToken = !!entry.accessToken && !!entry.expiresAt && entry.expiresAt > Date.now();
        if (!entry.refreshToken && !hasAccessToken) return null;

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

/** Token info for Claude Code's own OAuth session (used for quota/usage APIs). */
export interface ClaudeOAuthToken {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * Read the Claude Code session OAuth token from macOS Keychain.
 * This is stored under `claudeAiOauth` (separate from `mcpOAuth` used for MCP servers).
 * Returns null if not on macOS, no token found, or token is expired.
 */
export async function readClaudeOAuthToken(): Promise<ClaudeOAuthToken | null> {
  if (process.platform !== "darwin") return null;

  try {
    const result = await spawnCapture("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    if (!result.ok) return null;

    const data: KeychainData = JSON.parse(result.stdout.trim());
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    // Check if token is expired
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;

    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

/** Env value with surrounding whitespace removed, or undefined when unset/blank. */
function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve where Claude Code's on-disk OAuth credentials live, honouring the same
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` precedence verified against
 * the claude binary in `packages/command/src/claude-auth-store.ts`'s `defaultAuthPaths`.
 */
function credentialsFilePath(env: Record<string, string | undefined>): string {
  const dir = trimmedEnv(env.CLAUDE_SECURESTORAGE_CONFIG_DIR) ?? trimmedEnv(env.CLAUDE_CONFIG_DIR);
  return dir ? join(dir, ".credentials.json") : options.CLAUDE_CREDENTIALS_PATH;
}

/**
 * Read the Claude Code session OAuth token from the on-disk credentials file
 * Claude Code writes on Linux (`~/.claude/.credentials.json` by default — see
 * {@link credentialsFilePath}). This is the Linux counterpart of
 * {@link readClaudeOAuthToken}: macOS keeps the same `claudeAiOauth` payload in the
 * Keychain instead of a file, so this reader is not platform-gated — it simply finds
 * nothing on a platform where Claude Code never writes the file.
 *
 * Returns null if the file is missing, unreadable, malformed, or the token inside it
 * is expired.
 */
export async function readCredentialsFileToken(
  env: Record<string, string | undefined> = process.env,
): Promise<ClaudeOAuthToken | null> {
  try {
    const raw = readFileSync(credentialsFilePath(env), "utf-8");
    const data: KeychainData = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;

    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

/**
 * Read the Claude Code session OAuth token, trying macOS Keychain first (a no-op
 * off-darwin) and falling back to the on-disk credentials file Claude Code writes on
 * Linux. This is the token source the quota poller (`quota.ts`) uses so it works on
 * both platforms instead of silently finding nothing forever on Linux (#3223).
 */
export async function readClaudeSessionToken(
  env: Record<string, string | undefined> = process.env,
): Promise<ClaudeOAuthToken | null> {
  const keychainToken = await readClaudeOAuthToken();
  if (keychainToken) return keychainToken;
  return readCredentialsFileToken(env);
}
