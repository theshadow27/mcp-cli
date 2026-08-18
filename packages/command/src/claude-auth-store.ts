/**
 * Claude auth-profile store — scriptable identity switching for Claude Code (#3006).
 *
 * Claude Code keeps its identity in three places (Linux):
 *   - `~/.claude/.credentials.json`  — the live OAuth tokens (mode 0600, plain JSON)
 *   - `~/.claude.json`               — a large shared config that also carries
 *                                      `userID` / `oauthAccount`
 *   - `~/.claude/policy-limits.json` — a cache of the org policy for the current identity
 *
 * A *profile* is a single JSON file under `~/.mcp-cli/auth-profiles/<name>.json`
 * holding a verbatim copy of the credentials plus the two identity keys. One file
 * per profile means a profile swap is a single `rename()` — there is no window in
 * which credentials have been updated but identity has not.
 *
 * Security invariants (enforced by tests):
 *   - API key **values** are never stored. An `api-key` profile records only the
 *     NAME of the env var that is expected to carry the key.
 *   - Token values are never returned by any summary/list/format function.
 *   - The profile directory is 0700, every file 0600.
 *   - Every write is atomic (temp file + `rename`), so a crash can never leave a
 *     truncated `.credentials.json` behind.
 *
 * macOS is not supported yet: credentials live in the Keychain there, not in a
 * file (see `assertPlatformSupported`).
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { flockUnlock, options, tryFlockExclusive } from "@mcp-cli/core";

// ── Types ──

export const PROFILE_KINDS = ["oauth", "api-key"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** Current on-disk profile schema version. */
export const PROFILE_VERSION = 1;

/** Identity keys lifted out of `~/.claude.json`. Never contains tokens. */
export interface StoredIdentity {
  userID?: string;
  oauthAccount?: Record<string, unknown>;
}

/** Org-policy snapshot taken at save time (advisory — the policy is refetched by Claude). */
export interface StoredPolicy {
  /** `restrictions.allow_remote_control.allowed`, or null when unknown. */
  allowRemoteControl: boolean | null;
  /** When the snapshot was taken (ISO). */
  capturedAt: string;
}

export interface ClaudeAuthProfile {
  version: number;
  name: string;
  kind: ProfileKind;
  createdAt: string;
  updatedAt: string;
  /** api-key profiles only: the NAME of the env var expected to hold the key. Never the value. */
  apiKeyEnvVar?: string;
  /** oauth profiles only: verbatim `~/.claude/.credentials.json` contents. */
  credentials?: Record<string, unknown>;
  /** oauth profiles only: `userID` / `oauthAccount` from `~/.claude.json`. */
  identity?: StoredIdentity;
  policy?: StoredPolicy;
}

/** Non-secret projection of a profile, safe to print. */
export interface ProfileSummary {
  name: string;
  kind: ProfileKind;
  active: boolean;
  /** Email address, falling back to the account UUID, or null. */
  account: string | null;
  organization: string | null;
  subscriptionType: string | null;
  /** Access-token expiry as ISO, or null when unknown. */
  expiresAt: string | null;
  expired: boolean | null;
  /** api-key profiles: the env var name the profile expects. */
  apiKeyEnvVar: string | null;
  allowRemoteControl: boolean | null;
  hasCredentials: boolean;
  updatedAt: string;
}

/** Filesystem locations the store reads and writes. Injected so tests never touch a real `~/.claude`. */
export interface AuthPaths {
  profilesDir: string;
  credentialsPath: string;
  claudeConfigPath: string;
  policyLimitsPath: string;
}

/**
 * Resolve where Claude Code keeps its identity, honouring `CLAUDE_CONFIG_DIR`.
 *
 * Verified against the claude 2.1.235 bundle and by running the binary:
 *   - credentials: `(CLAUDE_SECURESTORAGE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR ?? ~/.claude)/.credentials.json`
 *   - policy cache: `(CLAUDE_CONFIG_DIR ?? ~/.claude)/policy-limits.json`
 *   - global config: `(CLAUDE_CONFIG_DIR ?? ~)/.claude.json` — note the *different* base:
 *     with a redirected config dir the file sits directly inside it, but by default it
 *     sits beside `~/.claude`, not in it.
 *   - if `<configDir>/.config.json` exists it supersedes `.claude.json` (the binary
 *     prefers it), so we patch that file instead of creating a second source of truth.
 *
 * With `CLAUDE_CONFIG_DIR` unset the paths come from `options`, which tests override.
 */
export function defaultAuthPaths(env: Record<string, string | undefined> = process.env): AuthPaths {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() ? env.CLAUDE_CONFIG_DIR : undefined;
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR : undefined;

  const credentialsRoot = secureDir ?? configDir;
  const credentialsPath = credentialsRoot
    ? join(credentialsRoot, ".credentials.json")
    : options.CLAUDE_CREDENTIALS_PATH;
  const policyLimitsPath = configDir ? join(configDir, "policy-limits.json") : options.CLAUDE_POLICY_LIMITS_PATH;

  const globalConfigDefault = configDir ? join(configDir, ".claude.json") : options.CLAUDE_CONFIG_PATH;
  const dotConfig = configDir
    ? join(configDir, ".config.json")
    : join(dirname(options.CLAUDE_CREDENTIALS_PATH), ".config.json");
  const claudeConfigPath = existsSync(dotConfig) ? dotConfig : globalConfigDefault;

  return {
    profilesDir: options.AUTH_PROFILES_DIR,
    credentialsPath,
    claudeConfigPath,
    policyLimitsPath,
  };
}

/** Raised for every expected failure so the CLI can map it to an exit code without message sniffing. */
export class AuthProfileError extends Error {
  constructor(
    message: string,
    /** Stable, machine-readable failure code. */
    readonly code:
      | "unsupported-platform"
      | "invalid-name"
      | "not-found"
      | "no-credentials"
      | "config-locked"
      | "config-unreadable",
    errorOptions?: ErrorOptions,
  ) {
    super(message, errorOptions);
    this.name = "AuthProfileError";
  }
}

// ── Paths and naming ──

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ACTIVE_FILE = "active.json";
const BACKUPS_DIR = "backups";
const ORIGINAL_BACKUP = "original";

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new AuthProfileError(
      `Invalid profile name "${name}": use letters, digits, hyphens or underscores (max 64 chars)`,
      "invalid-name",
    );
  }
}

export function profilePath(paths: AuthPaths, name: string): string {
  validateProfileName(name);
  return join(paths.profilesDir, `${name}.json`);
}

export function ensureProfilesDir(paths: AuthPaths): void {
  mkdirSync(paths.profilesDir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode argument is masked by umask; force the bits for a pre-existing dir too.
  chmodSync(paths.profilesDir, DIR_MODE);
}

// ── Low-level IO ──

/** Write `content` to `path` via temp file + rename. A crash can never leave a truncated target. */
export function writeFileAtomic(path: string, content: string, mode: number = FILE_MODE): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode); // umask-proof
  renameSync(tmp, path);
}

function readJsonObject(path: string, what: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AuthProfileError(`${what} at ${path} is not valid JSON — refusing to touch it`, "config-unreadable", {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthProfileError(`${what} at ${path} is not a JSON object — refusing to touch it`, "config-unreadable");
  }
  return parsed as Record<string, unknown>;
}

/** File mode bits (permission bits only), or `fallback` when the file is absent. */
function modeOf(path: string, fallback: number): number {
  if (!existsSync(path)) return fallback;
  return statSync(path).mode & 0o777;
}

const LOCK_DEADLINE_MS = 2_000;
const LOCK_RETRY_MS = 25;

/**
 * Run `fn` while holding an exclusive advisory lock on `path`.
 *
 * Claude Code rewrites `~/.claude.json` in place while it runs, so the lock plus
 * the mtime re-check in `patchClaudeConfigIdentity` is our concurrency defence.
 * The lock is kernel-managed and released on process death.
 */
export function withExclusiveLock<T>(path: string, fn: () => T, deadlineMs = LOCK_DEADLINE_MS): T {
  // "a+" creates the file if absent and never truncates an existing one.
  const fd = openSync(path, "a+");
  const deadline = Date.now() + deadlineMs;
  let held = false;
  try {
    while (!held) {
      held = tryFlockExclusive(fd);
      if (held) break;
      if (Date.now() >= deadline) {
        throw new AuthProfileError(
          `${path} is locked by another process (is Claude Code running?) — retry in a moment`,
          "config-locked",
        );
      }
      Bun.sleepSync(LOCK_RETRY_MS);
    }
    return fn();
  } finally {
    if (held) flockUnlock(fd);
    closeSync(fd);
  }
}

// ── Profile records ──

export function listProfileNames(paths: AuthPaths): string[] {
  if (!existsSync(paths.profilesDir)) return [];
  return readdirSync(paths.profilesDir)
    .filter((f) => f.endsWith(".json") && f !== ACTIVE_FILE)
    .map((f) => f.slice(0, -".json".length))
    .filter((name) => PROFILE_NAME_RE.test(name))
    .sort();
}

export function readProfile(paths: AuthPaths, name: string): ClaudeAuthProfile | null {
  const path = profilePath(paths, name);
  if (!existsSync(path)) return null;
  const raw = readJsonObject(path, `Profile "${name}"`);
  return raw as unknown as ClaudeAuthProfile;
}

export function writeProfile(paths: AuthPaths, profile: ClaudeAuthProfile): void {
  ensureProfilesDir(paths);
  writeFileAtomic(profilePath(paths, profile.name), `${JSON.stringify(profile, null, 2)}\n`);
}

/** Which profile the live credential file currently holds, and where that file was. */
export interface ActivePointer {
  name: string;
  /** Credential path the pointer was written for. Null for pointers written before this field existed. */
  credentialsPath: string | null;
}

export function readActivePointer(paths: AuthPaths): ActivePointer | null {
  const path = join(paths.profilesDir, ACTIVE_FILE);
  if (!existsSync(path)) return null;
  const raw = readJsonObject(path, "Active-profile pointer");
  const name = raw.profile;
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) return null;
  return { name, credentialsPath: typeof raw.credentialsPath === "string" ? raw.credentialsPath : null };
}

export function readActiveProfileName(paths: AuthPaths): string | null {
  return readActivePointer(paths)?.name ?? null;
}

export function writeActiveProfileName(paths: AuthPaths, name: string, now: Date): void {
  ensureProfilesDir(paths);
  writeFileAtomic(
    join(paths.profilesDir, ACTIVE_FILE),
    `${JSON.stringify({ profile: name, since: now.toISOString(), credentialsPath: paths.credentialsPath }, null, 2)}\n`,
  );
}

// ── Live state ──

export interface LiveState {
  credentials: Record<string, unknown> | null;
  identity: StoredIdentity;
  policy: StoredPolicy | null;
}

function readPolicySnapshot(paths: AuthPaths, now: Date): StoredPolicy | null {
  if (!existsSync(paths.policyLimitsPath)) return null;
  const raw = readJsonObject(paths.policyLimitsPath, "policy-limits.json");
  const restrictions = raw.restrictions;
  let allowed: boolean | null = null;
  if (typeof restrictions === "object" && restrictions !== null) {
    const entry = (restrictions as Record<string, unknown>).allow_remote_control;
    if (typeof entry === "object" && entry !== null) {
      const value = (entry as Record<string, unknown>).allowed;
      if (typeof value === "boolean") allowed = value;
    }
  }
  return { allowRemoteControl: allowed, capturedAt: now.toISOString() };
}

/** Read the currently-active identity off disk. Never mutates anything. */
export function readLiveState(paths: AuthPaths, now: Date): LiveState {
  const credentials = existsSync(paths.credentialsPath)
    ? readJsonObject(paths.credentialsPath, "Claude credentials")
    : null;

  const identity: StoredIdentity = {};
  if (existsSync(paths.claudeConfigPath)) {
    const config = readJsonObject(paths.claudeConfigPath, "~/.claude.json");
    if (typeof config.userID === "string") identity.userID = config.userID;
    const account = config.oauthAccount;
    if (typeof account === "object" && account !== null && !Array.isArray(account)) {
      identity.oauthAccount = account as Record<string, unknown>;
    }
  }

  return { credentials, identity, policy: readPolicySnapshot(paths, now) };
}

/**
 * Return a copy of `config` with only the identity keys replaced (or dropped when the
 * profile has none). Key order is preserved so the rewritten `~/.claude.json` stays as
 * close to the original as possible.
 */
function applyIdentity(config: Record<string, unknown>, identity: StoredIdentity): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "userID") {
      if (identity.userID !== undefined) next.userID = identity.userID;
      continue;
    }
    if (key === "oauthAccount") {
      if (identity.oauthAccount !== undefined) next.oauthAccount = identity.oauthAccount;
      continue;
    }
    next[key] = value;
  }
  if (identity.userID !== undefined && !("userID" in config)) next.userID = identity.userID;
  if (identity.oauthAccount !== undefined && !("oauthAccount" in config)) next.oauthAccount = identity.oauthAccount;
  return next;
}

/**
 * Patch only `userID` / `oauthAccount` in `~/.claude.json`, preserving every other
 * key and the file's existing permissions.
 *
 * Concurrency: the read-modify-write runs under an exclusive advisory lock, and the
 * file's mtime+size are re-checked immediately before the rename. If Claude Code
 * rewrote the file underneath us we retry rather than clobber its changes.
 */
export function patchClaudeConfigIdentity(path: string, identity: StoredIdentity, attempts = 3): void {
  withExclusiveLock(path, () => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const before = existsSync(path) ? statSync(path) : null;
      const config = before && before.size > 0 ? readJsonObject(path, "~/.claude.json") : {};

      const next = applyIdentity(config, identity);

      const after = existsSync(path) ? statSync(path) : null;
      const changedUnderUs =
        (before === null) !== (after === null) ||
        (before !== null && after !== null && (before.mtimeMs !== after.mtimeMs || before.size !== after.size));
      if (changedUnderUs) continue; // another writer won the race — re-read and retry

      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, modeOf(path, FILE_MODE));
      return;
    }
    throw new AuthProfileError(
      `${path} kept changing while writing identity keys (is Claude Code running?) — retry in a moment`,
      "config-locked",
    );
  });
}

// ── Backups ──

/** Copy the live identity files into `dir`. Missing files are skipped. */
function backupLiveFiles(paths: AuthPaths, dir: string): string {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  for (const [src, name] of [
    [paths.credentialsPath, "credentials.json"],
    [paths.claudeConfigPath, "claude.json"],
    [paths.policyLimitsPath, "policy-limits.json"],
  ] as const) {
    if (!existsSync(src)) continue;
    const dest = join(dir, name);
    copyFileSync(src, dest);
    chmodSync(dest, FILE_MODE);
  }
  return dir;
}

/**
 * Snapshot the live files before the first overwrite of anything we did not create.
 * The `original` backup is written once and never replaced.
 */
export function backupOriginals(paths: AuthPaths): string | null {
  const dir = join(paths.profilesDir, BACKUPS_DIR, ORIGINAL_BACKUP);
  if (existsSync(dir)) return null;
  ensureProfilesDir(paths);
  return backupLiveFiles(paths, dir);
}

/** Snapshot live credentials that belong to no known profile, so a switch can never lose them. */
export function backupOrphan(paths: AuthPaths, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  ensureProfilesDir(paths);
  return backupLiveFiles(paths, join(paths.profilesDir, BACKUPS_DIR, `orphan-${stamp}`));
}

// ── Platform support ──

/** Throws unless the current platform stores Claude credentials in a file we can swap. */
export function assertPlatformSupported(platform: string): void {
  if (platform === "linux") return;
  const detail =
    platform === "darwin"
      ? "Claude Code stores its credentials in the macOS Keychain, not in ~/.claude/.credentials.json"
      : `unsupported platform "${platform}"`;
  throw new AuthProfileError(
    `mcx claude auth is Linux-only for now: ${detail}. Nothing was read or written.`,
    "unsupported-platform",
  );
}

// ── save ──

export interface SaveOptions {
  paths: AuthPaths;
  name: string;
  env: Record<string, string | undefined>;
  now: Date;
  platform: string;
  /** Force an api-key profile bound to this env var name (implies kind "api-key"). */
  apiKeyEnvVar?: string;
  /**
   * Capture the OAuth credentials even when an API key is present in `env`.
   * Needed because a shell with `ANTHROPIC_API_KEY` exported would otherwise
   * never be able to snapshot the logged-in claude.ai identity.
   */
  forceOauth?: boolean;
}

export interface SaveResult {
  profile: ClaudeAuthProfile;
  replaced: boolean;
  /** True when the active pointer now names this profile. */
  becameActive: boolean;
  warnings: string[];
}

const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

export function saveProfile(opts: SaveOptions): SaveResult {
  const { paths, name, env, now, platform } = opts;
  assertPlatformSupported(platform);
  validateProfileName(name);

  const warnings: string[] = [];
  const existing = readProfile(paths, name);
  const apiKeyEnvVar = opts.forceOauth
    ? undefined
    : (opts.apiKeyEnvVar ?? (env[DEFAULT_API_KEY_ENV] ? DEFAULT_API_KEY_ENV : undefined));
  const kind: ProfileKind = apiKeyEnvVar ? "api-key" : "oauth";
  const live = readLiveState(paths, now);

  const profile: ClaudeAuthProfile = {
    version: PROFILE_VERSION,
    name,
    kind,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (live.policy) profile.policy = live.policy;

  if (kind === "api-key") {
    // Record the env var NAME only — never the key value, and never someone
    // else's OAuth tokens that merely happen to be on disk right now.
    profile.apiKeyEnvVar = apiKeyEnvVar;
    if (!env[apiKeyEnvVar as string]) {
      warnings.push(`${apiKeyEnvVar} is not set in this environment — the profile records the variable name only`);
    }
    if (live.credentials) {
      warnings.push(
        `live OAuth credentials in ${paths.credentialsPath} were NOT captured (api-key profiles store no tokens)`,
      );
    }
  } else {
    if (!live.credentials) {
      throw new AuthProfileError(
        `No Claude credentials found at ${paths.credentialsPath} — log in with claude first, or set ${DEFAULT_API_KEY_ENV} to save an api-key profile`,
        "no-credentials",
      );
    }
    profile.credentials = live.credentials;
    profile.identity = live.identity;
    if (live.identity.userID === undefined && live.identity.oauthAccount === undefined) {
      warnings.push(`no userID/oauthAccount found in ${paths.claudeConfigPath} — only credentials were captured`);
    }
  }

  writeProfile(paths, profile);

  // An oauth save establishes provenance for the live credentials: the next
  // `load` knows where to write a refreshed token back to.
  let becameActive = false;
  if (kind === "oauth") {
    writeActiveProfileName(paths, name, now);
    becameActive = true;
  }

  return { profile, replaced: existing !== null, becameActive, warnings };
}

// ── load ──

export interface LoadOptions {
  paths: AuthPaths;
  name: string;
  env: Record<string, string | undefined>;
  now: Date;
  platform: string;
}

export interface LoadResult {
  name: string;
  kind: ProfileKind;
  previousActive: string | null;
  /** Profile that received the live credentials before the switch, if any. */
  wroteBack: string | null;
  wroteBackChanged: boolean;
  backupDir: string | null;
  orphanBackupDir: string | null;
  credentialsWritten: boolean;
  identityWritten: boolean;
  policyInvalidated: boolean;
  apiKeyEnvVar: string | null;
  warnings: string[];
}

/** Deep value equality for plain JSON values (used to detect a refreshed token). */
function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function loadProfile(opts: LoadOptions): LoadResult {
  const { paths, name, env, now, platform } = opts;
  assertPlatformSupported(platform);

  const target = readProfile(paths, name);
  if (!target) {
    throw new AuthProfileError(
      `No such auth profile: "${name}". Run "mcx claude auth ls" to see saved ones.`,
      "not-found",
    );
  }

  const warnings: string[] = [];
  // The pointer records which credential file it described. A different
  // CLAUDE_CONFIG_DIR means those live credentials are not the ones the pointer
  // names, so we must not write them back into that profile.
  const pointer = readActivePointer(paths);
  const pointerApplies =
    pointer !== null && (pointer.credentialsPath ?? paths.credentialsPath) === paths.credentialsPath;
  if (pointer && !pointerApplies) {
    warnings.push(
      `active profile "${pointer.name}" was recorded for ${pointer.credentialsPath} — nothing was written back for this config dir`,
    );
  }
  const previousActive = pointerApplies && pointer ? pointer.name : null;
  const live = readLiveState(paths, now);

  // (6) Back up anything we did not create, once, before the first overwrite.
  const backupDir = backupOriginals(paths);

  // (4) Write-back: Claude rewrites .credentials.json in place on refresh, so the
  // live tokens must land back in their origin profile before we replace them.
  let wroteBack: string | null = null;
  let wroteBackChanged = false;
  let orphanBackupDir: string | null = null;

  if (previousActive === name) {
    // Re-loading the active profile: refresh the stored copy, then continue
    // (cheap idempotent path — also repairs a profile whose token has rotated).
    if (live.credentials && !jsonEquals(live.credentials, target.credentials)) {
      const refreshed: ClaudeAuthProfile = {
        ...target,
        credentials: live.credentials,
        identity: live.identity,
        updatedAt: now.toISOString(),
      };
      writeProfile(paths, refreshed);
      target.credentials = refreshed.credentials;
      target.identity = refreshed.identity;
      wroteBack = name;
      wroteBackChanged = true;
    }
  } else if (previousActive) {
    const origin = readProfile(paths, previousActive);
    if (!origin) {
      warnings.push(
        `active profile "${previousActive}" no longer exists — the live credentials were backed up instead of written back`,
      );
      if (live.credentials) orphanBackupDir = backupOrphan(paths, now);
    } else if (origin.kind === "api-key") {
      // api-key profiles intentionally hold no tokens; nothing to write back.
      wroteBack = null;
    } else if (live.credentials) {
      const changed = !jsonEquals(live.credentials, origin.credentials) || !jsonEquals(live.identity, origin.identity);
      if (changed) {
        writeProfile(paths, {
          ...origin,
          credentials: live.credentials,
          identity: live.identity,
          updatedAt: now.toISOString(),
        });
      }
      wroteBack = previousActive;
      wroteBackChanged = changed;
    }
  } else if (live.credentials) {
    // First ever use, or the pointer was lost: do not guess an owner — keep a copy.
    if (backupDir === null) orphanBackupDir = backupOrphan(paths, now);
    warnings.push(
      `no active profile was recorded — the live credentials were backed up to ${orphanBackupDir ?? backupDir}. Run "mcx claude auth save <name>" first to keep them as a profile.`,
    );
  }

  // Apply the target profile.
  let credentialsWritten = false;
  if (target.credentials) {
    writeFileAtomic(paths.credentialsPath, `${JSON.stringify(target.credentials, null, 2)}\n`);
    credentialsWritten = true;
  } else if (target.kind === "api-key") {
    warnings.push(
      `profile "${name}" is an api-key profile: export ${target.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV} before running claude`,
    );
    if (target.apiKeyEnvVar && !env[target.apiKeyEnvVar]) {
      warnings.push(`${target.apiKeyEnvVar} is not set in this environment`);
    }
  } else {
    warnings.push(`profile "${name}" has no stored credentials — ${paths.credentialsPath} was left untouched`);
  }

  let identityWritten = false;
  if (target.identity && (target.identity.userID !== undefined || target.identity.oauthAccount !== undefined)) {
    patchClaudeConfigIdentity(paths.claudeConfigPath, target.identity);
    identityWritten = true;
  }

  // (8) The org policy is cached per identity — drop it so Claude refetches.
  let policyInvalidated = false;
  if (existsSync(paths.policyLimitsPath)) {
    unlinkSync(paths.policyLimitsPath);
    policyInvalidated = true;
  }

  writeActiveProfileName(paths, name, now);

  return {
    name,
    kind: target.kind,
    previousActive,
    wroteBack,
    wroteBackChanged,
    backupDir,
    orphanBackupDir,
    credentialsWritten,
    identityWritten,
    policyInvalidated,
    apiKeyEnvVar: target.apiKeyEnvVar ?? null,
    warnings,
  };
}

// ── ls ──

function oauthField(profile: ClaudeAuthProfile, key: string): string | null {
  const value = profile.identity?.oauthAccount?.[key];
  return typeof value === "string" ? value : null;
}

function credentialsRoot(profile: ClaudeAuthProfile): Record<string, unknown> | null {
  const root = profile.credentials?.claudeAiOauth;
  if (typeof root === "object" && root !== null && !Array.isArray(root)) return root as Record<string, unknown>;
  return null;
}

/**
 * Non-secret projection of a profile. Never reads or returns token material —
 * only expiry, account, and policy metadata.
 */
export function summarizeProfile(profile: ClaudeAuthProfile, activeName: string | null, now: Date): ProfileSummary {
  const root = credentialsRoot(profile);
  const expiresAtMs = typeof root?.expiresAt === "number" ? root.expiresAt : null;
  const subscription = typeof root?.subscriptionType === "string" ? root.subscriptionType : null;

  return {
    name: profile.name,
    kind: profile.kind,
    active: profile.name === activeName,
    account: oauthField(profile, "emailAddress") ?? oauthField(profile, "accountUuid"),
    organization: oauthField(profile, "organizationName"),
    subscriptionType: subscription,
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    expired: expiresAtMs === null ? null : expiresAtMs <= now.getTime(),
    apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
    allowRemoteControl: profile.policy?.allowRemoteControl ?? null,
    hasCredentials: profile.credentials !== undefined,
    updatedAt: profile.updatedAt,
  };
}

export function listProfiles(paths: AuthPaths, now: Date): ProfileSummary[] {
  const active = readActiveProfileName(paths);
  const summaries: ProfileSummary[] = [];
  for (const name of listProfileNames(paths)) {
    const profile = readProfile(paths, name);
    if (!profile) continue;
    summaries.push(summarizeProfile({ ...profile, name }, active, now));
  }
  return summaries;
}
