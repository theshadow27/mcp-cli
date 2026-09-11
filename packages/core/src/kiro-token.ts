/**
 * Read Kiro CLI's SSO/OIDC access token from its local credential store.
 *
 * `kiro-cli acp` (KAS) launches with `--auth=acp-callback`, delegating token
 * acquisition to the ACP *host* — it asks the client to answer
 * `_kiro/auth/getAccessToken`. Unlike Copilot/Gemini/Grok (which authenticate
 * out-of-band), Kiro has no token file the KAS `FileAuthProvider` can read at a
 * default path, so mcx must supply the access token itself.
 *
 * kiro-cli persists its token under the key `kirocli:odic:token`:
 *   - macOS: the login Keychain (service = the key), read via `/usr/bin/security`.
 *     kiro-cli also mirrors it into the on-disk store below.
 *   - Linux / fallback: the `auth_kv` table of `data.sqlite3` in kiro-cli's app
 *     data dir (`$XDG_DATA_HOME/kiro-cli` or `~/.local/share/kiro-cli`; on macOS
 *     `~/Library/Application Support/kiro-cli`).
 *
 * The stored value is JSON: `{ access_token, expires_at (ISO-8601), refresh_token,
 * region, ... }`. We return the access token only when it is still valid; a
 * caller with an expired token should fall through to Kiro's own auth error
 * rather than send a dead credential. Refreshing the token is kiro-cli's job
 * (it owns the refresh token) — mcx only reads the short-lived access token,
 * mirroring how `keychain.ts` treats Claude Code credentials.
 *
 * This reader is intentionally best-effort and never throws: any failure
 * (not logged in, missing store, malformed JSON, wrong platform) yields `null`,
 * and the ACP layer surfaces an actionable "sign in with kiro-cli" message.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnCaptureSync } from "./subprocess";

/** Keychain service name / on-disk key kiro-cli stores its OIDC token under. */
export const KIRO_TOKEN_KEY = "kirocli:odic:token";

/** Buffer before hard expiry — a token this close to expiring is treated as unusable. */
const EXPIRY_BUFFER_MS = 60_000;

/** Shape of the token document kiro-cli persists (snake_case, matches kiro-cli). */
interface KiroStoredToken {
  access_token?: string;
  expires_at?: string;
  region?: string;
}

/** A usable Kiro access token resolved from the local credential store. */
export interface KiroToken {
  accessToken: string;
  /** Epoch ms of hard expiry, when known. */
  expiresAt?: number;
  /** ISO-8601 expiry string as stored, passed straight to KAS. */
  expiresAtIso?: string;
  region?: string;
  /**
   * CodeWhisperer profile ARN (`arn:aws:codewhisperer:<region>:<acct>:profile/<id>`).
   * KAS derives the service region from segment 4 of this ARN; without it the model
   * registry call resolves the wrong region and fails with ModelRegistryUnavailableError.
   */
  profileArn?: string;
}

/** Resolve kiro-cli's app data directory across platforms (XDG-aware). */
export function kiroDataDir(env: NodeJS.ProcessEnv = process.env): string {
  // Explicit override (tests; non-standard installs) wins on every platform.
  const override = env.MCX_KIRO_DATA_DIR?.trim();
  if (override) return override;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "kiro-cli");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "kiro-cli");
}

/** Path to kiro-cli's on-disk credential/state SQLite database. */
export function kiroDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(kiroDataDir(env), "data.sqlite3");
}

/** Parse a stored token document and return it only if the access token is still valid. */
function parseValidToken(raw: string): KiroToken | null {
  let doc: KiroStoredToken;
  try {
    doc = JSON.parse(raw) as KiroStoredToken;
  } catch {
    return null;
  }
  const accessToken = doc.access_token?.trim();
  if (!accessToken) return null;

  let expiresAt: number | undefined;
  if (doc.expires_at) {
    const parsed = Date.parse(doc.expires_at);
    if (!Number.isNaN(parsed)) {
      expiresAt = parsed;
      if (parsed <= Date.now() + EXPIRY_BUFFER_MS) return null; // expired / about to
    }
  }

  return { accessToken, expiresAt, expiresAtIso: doc.expires_at, region: doc.region };
}

/** Read the raw token JSON from the macOS Keychain, or null off-darwin / on miss. */
function readFromKeychain(): string | null {
  if (platform() !== "darwin") return null;
  const result = spawnCaptureSync("/usr/bin/security", ["find-generic-password", "-s", KIRO_TOKEN_KEY, "-w"]);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

/** Read the raw token JSON from kiro-cli's on-disk `auth_kv` store, or null on miss. */
function readTokenFromDisk(env: NodeJS.ProcessEnv = process.env): string | null {
  return readKvFromDisk("auth_kv", KIRO_TOKEN_KEY, env);
}

/**
 * Read the CodeWhisperer profile ARN kiro-cli caches in its `state` table under
 * `api.codewhisperer.profile` (`{ arn, profile_name }`). KAS needs this to resolve
 * the correct service region; it lives only on disk, not in the Keychain token.
 */
function readProfileArnFromDisk(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = readKvFromDisk("state", "api.codewhisperer.profile", env);
  if (!raw) return undefined;
  try {
    const doc = JSON.parse(raw) as { arn?: string };
    return doc.arn?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Read a single `value` for `key` from a `(key, value)` table in kiro-cli's SQLite store. */
function readKvFromDisk(table: "auth_kv" | "state", key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dbPath = kiroDbPath(env);
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    // readonly so we never lock or mutate kiro-cli's live store.
    db = new Database(dbPath, { readonly: true });
    // `state.value` is a BLOB; SQLite hands it back as a string when it holds UTF-8 JSON.
    const row = db.query<{ value: string }, [string]>(`SELECT value FROM ${table} WHERE key = ?`).get(key);
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Resolve a currently-valid Kiro access token from the local credential store.
 * Tries the macOS Keychain first (a no-op off-darwin), then the on-disk store
 * kiro-cli also writes (the Linux source, and a macOS mirror). The profile ARN
 * always comes from the on-disk `state` table. Returns `null` when no usable
 * token exists — callers should treat that as "not signed in".
 */
/** Injectable readers for testing without touching the real Keychain / user store. */
export interface KiroTokenSources {
  /** Raw token JSON from the macOS Keychain (null off-darwin or on miss). */
  keychain?: () => string | null;
  /** Raw token JSON from the on-disk `auth_kv` store. */
  disk?: (env: NodeJS.ProcessEnv) => string | null;
  /** CodeWhisperer profile ARN from the on-disk `state` table. */
  profileArn?: (env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * Resolve a currently-valid Kiro access token from the local credential store.
 * Tries the macOS Keychain first (a no-op off-darwin), then the on-disk store
 * kiro-cli also writes (the Linux source, and a macOS mirror). The profile ARN
 * always comes from the on-disk `state` table. Returns `null` when no usable
 * token exists — callers should treat that as "not signed in".
 *
 * `sources` is injectable for tests; production uses the real readers.
 */
export function resolveKiroToken(
  env: NodeJS.ProcessEnv = process.env,
  sources: KiroTokenSources = {},
): KiroToken | null {
  // Escape hatch: skip the local credential store entirely (tests; force API-key-only).
  if (env.MCX_KIRO_DISABLE_TOKEN_LOOKUP === "1") return null;
  const keychain = sources.keychain ?? readFromKeychain;
  const disk = sources.disk ?? readTokenFromDisk;
  const profileArn = sources.profileArn ?? readProfileArnFromDisk;

  const raw = keychain() ?? disk(env);
  if (!raw) return null;
  const token = parseValidToken(raw);
  if (!token) return null;
  token.profileArn = profileArn(env);
  return token;
}
