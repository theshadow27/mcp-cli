/**
 * MCP OAuth client provider backed by SQLite + macOS Keychain.
 *
 * Token resolution order:
 * 1. SQLite (our own tokens from previous auth flows)
 * 2. macOS Keychain (Claude Code's tokens — read-only)
 * 3. undefined → triggers SDK auth flow
 *
 * Writes always go to SQLite (never touch Keychain).
 */

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { StateDb } from "../db/state";
import { type KeychainTokens, readKeychainTokens } from "./keychain";

/** Return the platform-appropriate command to open a URL in a browser. */
export function getBrowserCommand(url: string): string[] {
  if (process.platform === "darwin") {
    return ["open", url];
  }
  if (process.platform === "win32") {
    return ["cmd.exe", "/c", "start", "", url];
  }
  // Linux — prefer wslview when running under WSL
  if (process.env.WSL_DISTRO_NAME) {
    return ["wslview", url];
  }
  return ["xdg-open", url];
}

/** Default fallback scope for OIDC-compatible providers (matches mcp-remote). */
export const DEFAULT_OAUTH_SCOPE = "openid email profile";

export interface OAuthProviderOpts {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  /** OAuth scope from per-server config (highest priority in scope resolution). */
  scope?: string;
  readKeychain?: (url: string) => Promise<KeychainTokens | null>;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private serverUrl: string;
  private db: StateDb;
  private _redirectUrl: string | undefined;
  private keychainCache: KeychainTokens | null | undefined; // undefined = not loaded
  private opts: OAuthProviderOpts;

  constructor(serverName: string, serverUrl: string, db: StateDb, opts?: OAuthProviderOpts) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.db = db;
    this.opts = opts ?? {};
  }

  /** Get the configured callback port (if any) */
  get callbackPort(): number | undefined {
    return this.opts.callbackPort;
  }

  /** Set the redirect URL (callback server URL) before starting auth flow */
  setRedirectUrl(url: string): void {
    this._redirectUrl = url;
  }

  get redirectUrl(): string | URL | undefined {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const meta: OAuthClientMetadata = {
      redirect_uris: [this._redirectUrl ?? "http://localhost/callback"],
      client_name: "mcp-cli",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    // Only include scope in clientMetadata when explicitly configured per-server.
    // A hardcoded fallback here would break non-OIDC servers on dynamic registration
    // (RFC 7591) and token exchange (SDK reads clientMetadata.scope directly in fetchToken).
    if (this.opts.scope) {
      meta.scope = this.opts.scope;
    }
    return meta;
  }

  /**
   * Compute the effective OAuth scope using a priority cascade:
   *  1. Per-server config scope (from OAuthProviderOpts)
   *  2. Fallback: "openid email profile" (matches mcp-remote)
   *
   * Tiers 2–5 of mcp-remote's cascade (WWW-Authenticate, Protected Resource
   * Metadata, registration response, auth server metadata) are handled internally
   * by the MCP SDK when this scope is passed to auth().
   *
   * Pass the result to the SDK's auth() `scope` parameter — NOT clientMetadata.
   */
  getEffectiveScope(): string {
    if (this.opts.scope?.trim()) {
      return this.opts.scope;
    }
    return DEFAULT_OAUTH_SCOPE;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // 0. Config-level credentials take priority (from mcx add --client-id)
    if (this.opts.clientId) {
      const info: OAuthClientInformationMixed = { client_id: this.opts.clientId };
      if (this.opts.clientSecret) info.client_secret = this.opts.clientSecret;
      return info;
    }

    // 1. Check SQLite
    const dbInfo = this.db.getClientInfo(this.serverName);
    if (dbInfo) return dbInfo;

    // 2. Check Keychain (Claude Code may have registered a client)
    const kc = await this.loadKeychain();
    if (kc) {
      return { client_id: kc.clientId };
    }

    // 3. No client info → SDK will attempt dynamic registration
    return undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.db.saveClientInfo(this.serverName, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // 1. Check SQLite (our own tokens, most recent)
    const dbTokens = this.db.getTokens(this.serverName);
    if (dbTokens) return dbTokens;

    // 2. Check Keychain (Claude Code tokens)
    const kc = await this.loadKeychain();
    if (kc) {
      const tokens: OAuthTokens = {
        access_token: kc.accessToken,
        token_type: "Bearer",
      };
      if (kc.refreshToken) tokens.refresh_token = kc.refreshToken;
      if (kc.scope) tokens.scope = kc.scope;
      if (kc.expiresAt) {
        const remainingSec = Math.floor((kc.expiresAt - Date.now()) / 1000);
        if (remainingSec > 0) tokens.expires_in = remainingSec;
      }
      return tokens;
    }

    return undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.db.saveTokens(this.serverName, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const urlStr = authorizationUrl.toString();
    console.error(`[auth] Opening browser for ${this.serverName}: ${urlStr}`);
    Bun.spawn(getBrowserCommand(urlStr), { stdout: "ignore", stderr: "ignore" });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.db.saveVerifier(this.serverName, codeVerifier);
  }

  codeVerifier(): string {
    const v = this.db.getVerifier(this.serverName);
    if (!v) throw new Error(`No PKCE code verifier found for "${this.serverName}"`);
    return v;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.db.saveDiscoveryState(this.serverName, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    // 1. SQLite
    const dbState = this.db.getDiscoveryState(this.serverName);
    if (dbState) return dbState;

    // 2. Keychain
    const kc = await this.loadKeychain();
    return kc?.discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    switch (scope) {
      case "all":
        this.db.deleteTokens(this.serverName);
        // Also clear keychain cache so we re-read
        this.keychainCache = undefined;
        break;
      case "tokens":
        this.db.deleteTokens(this.serverName);
        this.keychainCache = undefined;
        break;
      case "client":
        // Could clear client info but usually not needed
        break;
      case "verifier":
        // Verifier is ephemeral, no need to explicitly clear
        break;
      case "discovery":
        // No cached state to clear — discovery is fetched on demand
        break;
    }
  }

  // -- Internal --

  private async loadKeychain(): Promise<KeychainTokens | null> {
    if (this.keychainCache !== undefined) return this.keychainCache;
    const reader = this.opts.readKeychain ?? readKeychainTokens;
    this.keychainCache = await reader(this.serverUrl);
    return this.keychainCache;
  }
}
