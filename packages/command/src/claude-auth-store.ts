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
 * Safety invariants (each pinned by a test that fails without its guard):
 *   (a) `.credentials.json` is never overwritten unless the *outgoing* blob already
 *       exists somewhere on disk — written back to its origin profile, already stored
 *       in some profile, or copied into a backup directory. Attribution is evidence-
 *       based (see `attributeLiveCredentials`); when ownership cannot be proven we
 *       back up rather than guess.
 *   (b) An `api-key` profile never contains `credentials` or `identity`. API key
 *       VALUES are never stored — only the NAME of the env var expected to carry one.
 *   (c) Token values are never returned by any summary/list/format function.
 *   (d) The profile directory is 0700, every file (ours and any we create) 0600.
 *   (e) Every write is atomic (temp file + fsync + `rename`), so a crash can never
 *       leave a truncated `.credentials.json` behind.
 *   (f) A switch is all-or-nothing: the `~/.claude.json` lock is taken *before* the
 *       credentials are replaced, a `pending` marker records an in-flight switch, and
 *       a failure part-way rolls the credential file back.
 *
 * macOS is not supported yet: credentials live in the Keychain there, not in a
 * file (see `assertPlatformSupported`).
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  QUOTA_FETCH_ALL_BUDGET_MS,
  QUOTA_RATE_LIMIT_BACKOFF_MS,
  QUOTA_RATE_LIMIT_MAX_ATTEMPTS,
  QUOTA_RATE_LIMIT_MAX_BACKOFF_MS,
  QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS,
  type QuotaStatus,
  type StoredQuota,
  fetchQuotaUsage,
  flockUnlock,
  isQuotaRateLimitError,
  options,
  quotaRetryAfterMs,
  toStoredQuota,
  tryFlockExclusive,
} from "@mcp-cli/core";

export type { StoredQuota };

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
  /** oauth profiles: last usage snapshot (advisory — not live). */
  quota?: StoredQuota;
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
  /** `claudeAiOauth.rateLimitTier` (e.g. `default_claude_max_20x`), or null. */
  rateLimitTier: string | null;
  /** Access-token expiry as ISO, or null when unknown. */
  expiresAt: string | null;
  expired: boolean | null;
  /**
   * True when the stored blob carries a `refreshToken`. An expired *access* token is
   * not a dead profile: Claude Code mints a new one from the refresh token the next
   * time it starts, so such a profile is still a legal hop target (#3423).
   */
  hasRefreshToken: boolean;
  /** api-key profiles: the env var name the profile expects. */
  apiKeyEnvVar: string | null;
  allowRemoteControl: boolean | null;
  hasCredentials: boolean;
  updatedAt: string;
  /** Last quota snapshot, or null when none has been captured. */
  quota: StoredQuota | null;
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
  const configDir = trimmedEnv(env.CLAUDE_CONFIG_DIR);
  const secureDir = trimmedEnv(env.CLAUDE_SECURESTORAGE_CONFIG_DIR);

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

/** Env value with surrounding whitespace removed, or undefined when unset/blank. */
function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Stable, machine-readable failure codes so the CLI maps errors without message sniffing. */
export const AUTH_ERROR_CODES = [
  "unsupported-platform",
  "invalid-name",
  "not-found",
  "no-credentials",
  "config-locked",
  "config-unreadable",
  "io",
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Raised for every expected failure so the CLI can map it to an exit code. */
export class AuthProfileError extends Error {
  constructor(
    message: string,
    readonly code: AuthErrorCode,
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
const OPERATION_LOCK_FILE = ".operation.lock";
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
  io(`create ${paths.profilesDir}`, () => {
    mkdirSync(paths.profilesDir, { recursive: true, mode: DIR_MODE });
    // mkdir's mode argument is masked by umask; force the bits for a pre-existing dir too.
    chmodSync(paths.profilesDir, DIR_MODE);
  });
}

// ── Low-level IO ──

/**
 * Run a filesystem operation, converting errno failures (ENOENT, EACCES, …) into an
 * `AuthProfileError` so the CLI prints one clean line instead of a stack trace (#2821).
 */
function io<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AuthProfileError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (!code) throw err;
    throw new AuthProfileError(`Could not ${what}: ${code}`, "io", { cause: err });
  }
}

/**
 * Write `content` to `path` via temp file + fsync + rename — a crash can never leave a
 * truncated target. A symlinked target is replaced through its realpath so the link is
 * not silently swapped for a regular file, and the temp file is removed on any failure.
 */
export function writeFileAtomic(path: string, content: string, mode: number = FILE_MODE): void {
  const target = resolveLinkTarget(path);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  io(`write ${target}`, () => {
    try {
      const fd = openSync(tmp, "w", mode);
      try {
        writeSync(fd, content);
        fsyncSync(fd); // durability: the bytes are on disk before the rename publishes them
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, mode); // umask-proof
      renameSync(tmp, target);
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw err;
    }
  });
}

/** Follow a symlink to the file it points at, so atomic replace keeps the link intact. */
function resolveLinkTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch {
    // Path does not exist yet — write it directly. (Not an error: first write.)
  }
  return path;
}

function readTextFile(path: string, what: string): string {
  return io(`read ${what} at ${path}`, () => readFileSync(path, "utf-8"));
}

function parseJsonObject(raw: string, path: string, what: string): Record<string, unknown> {
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

function readJsonObject(path: string, what: string): Record<string, unknown> {
  return parseJsonObject(readTextFile(path, what), path, what);
}

/** SHA-256 of a credential blob's exact bytes — provenance evidence, never a secret itself. */
export function fingerprintCredentials(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
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
 * Claude Code rewrites `~/.claude.json` in place while it runs, so the lock plus the
 * mtime re-check in `patchIdentityLocked` is our concurrency defence. The lock is
 * kernel-managed and released on process death. A file we had to create for the lock
 * is removed again if it is still empty when the operation fails, so a failed switch
 * leaves no stray zero-byte config behind.
 */
export function withExclusiveLock<T>(path: string, fn: () => T, deadlineMs = LOCK_DEADLINE_MS): T {
  const createdByUs = !existsSync(path);
  // "a+" creates the file if absent and never truncates an existing one; 0600 at
  // creation time so a fresh ~/.claude.json is never born group/world readable.
  const fd = io(`open ${path}`, () => openSync(path, "a+", FILE_MODE));
  const deadline = Date.now() + deadlineMs;
  let held = false;
  let ok = false;
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
    const result = fn();
    ok = true;
    return result;
  } finally {
    if (held) flockUnlock(fd);
    closeSync(fd);
    if (!ok && createdByUs && existsSync(path) && statSync(path).size === 0) unlinkSync(path);
  }
}

/**
 * Serialize a whole `save`/`load` against other mcx processes. Without it two
 * concurrent `auth load` runs interleave their read-modify-write and produce the same
 * torn state a mid-flight crash would.
 */
export function withOperationLock<T>(paths: AuthPaths, fn: () => T, deadlineMs = LOCK_DEADLINE_MS): T {
  ensureProfilesDir(paths);
  const lockPath = join(paths.profilesDir, OPERATION_LOCK_FILE);
  const fd = io(`open ${lockPath}`, () => openSync(lockPath, "a+", FILE_MODE));
  const deadline = Date.now() + deadlineMs;
  let held = false;
  try {
    while (!held) {
      held = tryFlockExclusive(fd);
      if (held) break;
      if (Date.now() >= deadline) {
        throw new AuthProfileError("another mcx claude auth command is running — retry in a moment", "config-locked");
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
  return io(`list ${paths.profilesDir}`, () => readdirSync(paths.profilesDir))
    .filter((f) => f.endsWith(".json") && f !== ACTIVE_FILE)
    .map((f) => f.slice(0, -".json".length))
    .filter((name) => PROFILE_NAME_RE.test(name))
    .sort();
}

export function readProfile(paths: AuthPaths, name: string): ClaudeAuthProfile | null {
  const path = profilePath(paths, name);
  if (!existsSync(path)) return null;
  const raw = readJsonObject(path, `Profile "${name}"`);
  return { ...(raw as unknown as ClaudeAuthProfile), name };
}

/**
 * Write a profile record.
 *
 * Chokepoint for invariant (b): an api-key profile is stripped of any credential or
 * identity material on the way to disk, so no future code path can smuggle tokens into
 * one by constructing the object carelessly.
 */
export function writeProfile(paths: AuthPaths, profile: ClaudeAuthProfile): ClaudeAuthProfile {
  const record: ClaudeAuthProfile = { ...profile };
  if (record.kind === "api-key") {
    record.credentials = undefined;
    record.identity = undefined;
    record.quota = undefined;
  }
  ensureProfilesDir(paths);
  // JSON.stringify drops undefined-valued keys, so the stripped fields never hit disk.
  writeFileAtomic(profilePath(paths, record.name), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Which profile the live credential file holds, where that file was, and the
 * fingerprint of the exact blob mcx last wrote there.
 */
export interface ActivePointer {
  name: string;
  /** Credential path the pointer was written for. Null for pointers predating the field. */
  credentialsPath: string | null;
  /** SHA-256 of the credential blob mcx wrote. Null for pointers predating the field. */
  credentialsFingerprint: string | null;
  /** Set while a switch is in flight — its presence means a previous run was interrupted. */
  pending: string | null;
}

export function readActivePointer(paths: AuthPaths): ActivePointer | null {
  const path = join(paths.profilesDir, ACTIVE_FILE);
  if (!existsSync(path)) return null;
  const raw = readJsonObject(path, "Active-profile pointer");
  const name = raw.profile;
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) return null;
  return {
    name,
    credentialsPath: typeof raw.credentialsPath === "string" ? raw.credentialsPath : null,
    credentialsFingerprint: typeof raw.credentialsFingerprint === "string" ? raw.credentialsFingerprint : null,
    pending: typeof raw.pending === "string" ? raw.pending : null,
  };
}

export function readActiveProfileName(paths: AuthPaths): string | null {
  return readActivePointer(paths)?.name ?? null;
}

/** Outcome of a quota stamp, including any bucket carried over from the stored snapshot. */
export interface StampQuotaResult {
  stamped: boolean;
  /** Buckets the incoming snapshot omitted, whose previous (older) value was preserved. */
  keptBuckets: string[];
}

/**
 * Merge an incoming snapshot over the stored one.
 *
 * A degraded-but-successful 200 (the usage API omitting a bucket) must not destroy
 * a good number: keep the stored bucket and report it. `capturedAt` then falls back
 * to the *older* of the two stamps, because a snapshot is only as fresh as its
 * oldest constituent — the picker reads that field to decide whether to trust it.
 */
function mergeStoredQuota(
  incoming: StoredQuota,
  stored: StoredQuota | undefined,
): { quota: StoredQuota; keptBuckets: string[] } {
  if (!stored) return { quota: incoming, keptBuckets: [] };
  const merged: StoredQuota = { ...incoming };
  const keptBuckets: string[] = [];
  const keep = <K extends "fiveHour" | "sevenDay" | "sevenDaySonnet" | "sevenDayOpus" | "extraUsage">(key: K): void => {
    if (incoming[key] != null || stored[key] == null) return;
    merged[key] = stored[key];
    keptBuckets.push(key);
  };
  keep("fiveHour");
  keep("sevenDay");
  keep("sevenDaySonnet");
  keep("sevenDayOpus");
  keep("extraUsage");
  if (keptBuckets.length > 0) {
    const older = Date.parse(stored.capturedAt);
    const fresh = Date.parse(merged.capturedAt);
    if (!Number.isNaN(older) && (Number.isNaN(fresh) || older < fresh)) merged.capturedAt = stored.capturedAt;
  }
  return { quota: merged, keptBuckets };
}

/**
 * Write `quota` onto a named oauth profile.
 *
 * Not stamped when the profile is missing or api-key. Does not create the store.
 */
export function stampProfileQuota(paths: AuthPaths, name: string, quota: StoredQuota): StampQuotaResult {
  const profile = readProfile(paths, name);
  if (!profile || profile.kind === "api-key") return { stamped: false, keptBuckets: [] };
  const merged = mergeStoredQuota(quota, profile.quota);
  writeProfile(paths, { ...profile, quota: merged.quota });
  return { stamped: true, keptBuckets: merged.keptBuckets };
}

/**
 * Write `quota` onto the profile that provably owns the credentials the numbers were
 * measured with.
 *
 * The pointer alone is not evidence: it says what mcx *last wrote*, so after a
 * `claude /login` behind mcx's back it names one account while the live token is
 * another's, and stamping on it records a stranger's numbers under the wrong name.
 * Attribution is the same evidence-based check `loadProfile` uses (invariant (a)).
 * Nothing is stamped when ownership is unproven. Caller holds the operation lock.
 */
export function stampActiveProfileQuota(paths: AuthPaths, quota: StoredQuota, live: LiveState): StampQuotaResult {
  const owner = attributeLiveCredentials(paths, live, readActivePointer(paths)).owner;
  if (!owner) return { stamped: false, keptBuckets: [] };
  return stampProfileQuota(paths, owner.name, quota);
}

/** Name of the profile that provably owns the live credential blob, or null. */
export function attributedLiveProfile(paths: AuthPaths, live: LiveState): string | null {
  return attributeLiveCredentials(paths, live, readActivePointer(paths)).owner?.name ?? null;
}

/**
 * Copy the live credential blob back onto the profile that provably owns it.
 *
 * Claude Code refreshes the access token in `.credentials.json` in place. Without
 * this the stored copy ages out after one token lifetime (~8h), `summarizeProfile`
 * reports the profile as expired, and both `isEligible` and `mustLeave` reject it —
 * a closed loop in which `load --auto` answers "wait" forever while every account
 * still has quota (#3423). Returns the profile written, or null when ownership is
 * unproven or the stored copy is already current. Caller holds the operation lock.
 */
export function refreshProfileCredentialsFromLive(paths: AuthPaths, live: LiveState, now: Date): string | null {
  const owner = attributeLiveCredentials(paths, live, readActivePointer(paths)).owner;
  if (!owner || !live.credentials) return null;
  if (jsonEquals(live.credentials, owner.credentials) && jsonEquals(live.identity, owner.identity)) return null;
  writeProfile(paths, {
    ...owner,
    credentials: live.credentials,
    identity: live.identity,
    updatedAt: now.toISOString(),
  });
  return owner.name;
}

interface PointerWrite {
  name: string;
  credentialsFingerprint: string | null;
  pending?: string;
}

function writeActivePointer(paths: AuthPaths, pointer: PointerWrite, now: Date): void {
  ensureProfilesDir(paths);
  const record = {
    profile: pointer.name,
    since: now.toISOString(),
    credentialsPath: paths.credentialsPath,
    credentialsFingerprint: pointer.credentialsFingerprint,
    ...(pointer.pending ? { pending: pointer.pending } : {}),
  };
  writeFileAtomic(join(paths.profilesDir, ACTIVE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

// ── Live state ──

export interface LiveState {
  credentials: Record<string, unknown> | null;
  /** Exact bytes of the credential file, for fingerprinting and rollback. */
  credentialsRaw: string | null;
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
  let credentials: Record<string, unknown> | null = null;
  let credentialsRaw: string | null = null;
  if (existsSync(paths.credentialsPath)) {
    credentialsRaw = readTextFile(paths.credentialsPath, "Claude credentials");
    credentials = parseJsonObject(credentialsRaw, paths.credentialsPath, "Claude credentials");
  }

  const identity: StoredIdentity = {};
  if (existsSync(paths.claudeConfigPath)) {
    const config = readJsonObject(paths.claudeConfigPath, "~/.claude.json");
    if (typeof config.userID === "string") identity.userID = config.userID;
    const account = config.oauthAccount;
    if (typeof account === "object" && account !== null && !Array.isArray(account)) {
      identity.oauthAccount = account as Record<string, unknown>;
    }
  }

  return { credentials, credentialsRaw, identity, policy: readPolicySnapshot(paths, now) };
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
 * Patch `userID` / `oauthAccount` in `~/.claude.json`. Caller must already hold the
 * exclusive lock on `path` (see `withExclusiveLock`).
 *
 * The file's mtime+size are re-checked immediately before the rename: if Claude Code
 * rewrote the file underneath us we re-read and retry rather than clobber its changes.
 * A file that did not exist before is created 0600; an existing file keeps its mode.
 */
function patchIdentityLocked(path: string, identity: StoredIdentity, existedBefore: boolean, attempts = 3): void {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = existsSync(path) ? statSync(path) : null;
    const config = before && before.size > 0 ? readJsonObject(path, "~/.claude.json") : {};

    const next = applyIdentity(config, identity);

    const after = existsSync(path) ? statSync(path) : null;
    const changedUnderUs =
      (before === null) !== (after === null) ||
      (before !== null && after !== null && (before.mtimeMs !== after.mtimeMs || before.size !== after.size));
    if (changedUnderUs) continue; // another writer won the race — re-read and retry

    // `withExclusiveLock` may have created the file (as an empty 0600 stub) purely to
    // hold the lock — that must not be mistaken for a pre-existing file whose mode we
    // are meant to preserve.
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, existedBefore ? modeOf(path, FILE_MODE) : FILE_MODE);
    return;
  }
  throw new AuthProfileError(
    `${path} kept changing while writing identity keys (is Claude Code running?) — retry in a moment`,
    "config-locked",
  );
}

/** Locking wrapper around `patchIdentityLocked`, for callers outside a switch. */
export function patchClaudeConfigIdentity(path: string, identity: StoredIdentity, attempts = 3): void {
  const existedBefore = existsSync(path);
  withExclusiveLock(path, () => patchIdentityLocked(path, identity, existedBefore, attempts));
}

// ── Backups ──

/** Copy the live identity files into `dir`. Missing files are skipped. */
function backupLiveFiles(paths: AuthPaths, dir: string): string {
  return io(`write backup ${dir}`, () => {
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
  });
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
  let dir = join(paths.profilesDir, BACKUPS_DIR, `orphan-${stamp}`);
  // Two orphan backups inside the same millisecond (or with an injected clock) must not
  // overwrite each other — the whole point is that nothing is lost.
  for (let suffix = 2; existsSync(dir); suffix++) {
    dir = join(paths.profilesDir, BACKUPS_DIR, `orphan-${stamp}-${suffix}`);
  }
  return backupLiveFiles(paths, dir);
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
  /** How long to wait for the operation/config locks (ms). Injected by tests. */
  lockDeadlineMs?: number;
  /**
   * Capture the OAuth credentials even when an API key is present in `env`.
   * Needed because a shell with `ANTHROPIC_API_KEY` exported would otherwise
   * never be able to snapshot the logged-in claude.ai identity.
   */
  forceOauth?: boolean;
  /**
   * Pre-fetched quota snapshot. Fetch happens *before* the operation lock so a
   * 5s network timeout does not serialize other auth commands. Injected by the
   * CLI (and tests); the store itself stays synchronous.
   */
  quota?: StoredQuota;
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

  return withOperationLock(
    paths,
    () => {
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
      if (kind === "oauth") {
        if (opts.quota) profile.quota = opts.quota;
        else if (existing?.quota) profile.quota = existing.quota;
      }

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
        if (!live.credentials || !live.credentialsRaw) {
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

      const stored = writeProfile(paths, profile);

      // An oauth save establishes provenance for the live credentials: the pointer
      // records both the profile and the fingerprint of the blob it describes, so the
      // next `load` can prove (not assume) whose tokens are live.
      let becameActive = false;
      if (kind === "oauth" && live.credentialsRaw) {
        writeActivePointer(paths, { name, credentialsFingerprint: fingerprintCredentials(live.credentialsRaw) }, now);
        becameActive = true;
      }

      return { profile: stored, replaced: existing !== null, becameActive, warnings };
    },
    opts.lockDeadlineMs,
  );
}

// ── load ──

export interface LoadOptions {
  paths: AuthPaths;
  name: string;
  env: Record<string, string | undefined>;
  now: Date;
  platform: string;
  /** How long to wait for the operation/config locks (ms). Injected by tests. */
  lockDeadlineMs?: number;
  /**
   * Fault-injection seam. `onAfterCredentialsWrite` runs inside the switch, right after
   * `.credentials.json` has been replaced and before the identity patch — the only
   * window where a rollback is needed. Tests use it to prove the rollback works; nothing
   * in production sets it.
   */
  hooks?: { onAfterCredentialsWrite?: () => void };
  /**
   * Pre-fetched quota snapshot for the *outgoing* identity. Fetched before the
   * exclusive `~/.claude.json` lock; attached on write-back even when credentials
   * did not change, so every profile you have switched away from has a snapshot.
   */
  outgoingQuota?: StoredQuota;
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
  /** How the outgoing credentials were preserved — the evidence for invariant (a). */
  outgoingPreservedAs: "write-back" | "already-stored" | "backup" | "nothing-to-preserve";
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

function accountUuid(identity: StoredIdentity | undefined): string | null {
  const value = identity?.oauthAccount?.accountUuid;
  return typeof value === "string" ? value : null;
}

type AttributionReason =
  | "no-live-credentials"
  | "no-pointer"
  | "other-config-dir"
  | "interrupted-switch"
  | "pointer-profile-missing"
  | "api-key-pointer"
  | "fingerprint-match"
  | "stored-copy-match"
  | "refreshed-same-account"
  | "unrecognized-credentials";

interface Attribution {
  /** Profile that provably owns the live credentials, or null when ownership is unproven. */
  owner: ClaudeAuthProfile | null;
  reason: AttributionReason;
}

/**
 * Decide who owns the credentials currently on disk — on evidence, never on the
 * pointer alone. The pointer says what mcx *last wrote*; anything else on disk got
 * there some other way, and guessing is how a live refresh token gets overwritten.
 *
 * Ownership is proven when either:
 *   - the live blob is byte-identical to what the pointer recorded (or to the copy the
 *     profile already stores), or
 *   - the blob changed but `~/.claude.json` still names the same account as the
 *     profile — the signature of Claude refreshing the token in place.
 *
 * A pointer left in `pending` state (an interrupted switch) is never trusted: in that
 * state the live blob and the recorded identity can belong to different profiles.
 */
function attributeLiveCredentials(paths: AuthPaths, live: LiveState, pointer: ActivePointer | null): Attribution {
  if (!live.credentials || !live.credentialsRaw) return { owner: null, reason: "no-live-credentials" };
  if (!pointer) return { owner: null, reason: "no-pointer" };
  if (pointer.credentialsPath !== null && pointer.credentialsPath !== paths.credentialsPath) {
    return { owner: null, reason: "other-config-dir" };
  }
  if (pointer.pending) return { owner: null, reason: "interrupted-switch" };

  const origin = readProfileSafely(paths, pointer.name);
  if (!origin) return { owner: null, reason: "pointer-profile-missing" };
  // api-key profiles hold no tokens by design, so they can never own a live blob —
  // the outgoing credentials belong to somebody else and must be preserved elsewhere.
  if (origin.kind !== "oauth") return { owner: null, reason: "api-key-pointer" };

  const liveFingerprint = fingerprintCredentials(live.credentialsRaw);
  if (pointer.credentialsFingerprint && pointer.credentialsFingerprint === liveFingerprint) {
    return { owner: origin, reason: "fingerprint-match" };
  }
  if (jsonEquals(live.credentials, origin.credentials)) return { owner: origin, reason: "stored-copy-match" };

  const liveAccount = accountUuid(live.identity);
  if (liveAccount !== null && liveAccount === accountUuid(origin.identity)) {
    return { owner: origin, reason: "refreshed-same-account" };
  }
  return { owner: null, reason: "unrecognized-credentials" };
}

/** Read a profile, returning null (instead of throwing) when the file is unreadable. */
function readProfileSafely(paths: AuthPaths, name: string): ClaudeAuthProfile | null {
  try {
    return readProfile(paths, name);
  } catch {
    // A corrupt or unreadable profile must not brick a switch — treat as unknown.
    return null;
  }
}

/** True when any profile already stores exactly this credential blob. */
function anyProfileStores(paths: AuthPaths, credentials: Record<string, unknown>): string | null {
  for (const name of listProfileNames(paths)) {
    const profile = readProfileSafely(paths, name);
    if (profile?.credentials && jsonEquals(profile.credentials, credentials)) return name;
  }
  return null;
}

export function loadProfile(opts: LoadOptions): LoadResult {
  const { paths, name, env, now, platform } = opts;
  assertPlatformSupported(platform);
  validateProfileName(name);

  return withOperationLock(paths, () => loadProfileLocked(opts), opts.lockDeadlineMs);
}

function loadProfileLocked(opts: LoadOptions): LoadResult {
  const { paths, name, env, now } = opts;

  const target = readProfile(paths, name);
  if (!target) {
    throw new AuthProfileError(
      `No such auth profile: "${name}". Run "mcx claude auth ls" to see saved ones.`,
      "not-found",
    );
  }

  const warnings: string[] = [];
  const pointer = readActivePointer(paths);
  const live = readLiveState(paths, now);
  const attribution = attributeLiveCredentials(paths, live, pointer);
  const previousActive = attribution.owner?.name ?? null;

  // (6) Back up anything we did not create, once, before the first overwrite.
  const backupDir = backupOriginals(paths);

  // ── Invariant (a): the outgoing blob must exist on disk before we replace it ──
  let wroteBack: string | null = null;
  let wroteBackChanged = false;
  let orphanBackupDir: string | null = null;
  let outgoingPreservedAs: LoadResult["outgoingPreservedAs"] = "nothing-to-preserve";

  if (live.credentials) {
    if (attribution.owner) {
      const origin = attribution.owner;
      const changed = !jsonEquals(live.credentials, origin.credentials) || !jsonEquals(live.identity, origin.identity);
      const quotaToStore = opts.outgoingQuota ?? origin.quota;
      const quotaChanged = opts.outgoingQuota !== undefined && !jsonEquals(opts.outgoingQuota, origin.quota);
      if (changed || quotaChanged) {
        writeProfile(paths, {
          ...origin,
          credentials: live.credentials,
          identity: live.identity,
          updatedAt: changed ? now.toISOString() : origin.updatedAt,
          ...(quotaToStore ? { quota: quotaToStore } : {}),
        });
      }
      wroteBack = origin.name;
      wroteBackChanged = changed;
      outgoingPreservedAs = "write-back";
      if (origin.name === name) {
        // Re-loading the active profile: keep the refreshed blob rather than reverting
        // to the older stored copy.
        target.credentials = live.credentials;
        target.identity = live.identity;
        if (quotaToStore) target.quota = quotaToStore;
      }
    } else {
      const storedIn = anyProfileStores(paths, live.credentials);
      if (storedIn) {
        outgoingPreservedAs = "already-stored";
      } else {
        orphanBackupDir = backupOrphan(paths, now);
        outgoingPreservedAs = "backup";
      }
      warnings.push(describeUnattributed(paths, attribution.reason, pointer, orphanBackupDir, storedIn));
    }
  }

  // ── Apply the target profile ──
  //
  // (f) The ~/.claude.json lock is taken FIRST: a `config-locked` failure then happens
  // before anything is mutated, instead of leaving new credentials next to the old
  // identity. Inside the lock a `pending` marker records the in-flight switch, and any
  // failure rolls the credential file back to the bytes we found.
  const identityToWrite =
    target.identity && (target.identity.userID !== undefined || target.identity.oauthAccount !== undefined)
      ? target.identity
      : null;
  const configExistedBefore = existsSync(paths.claudeConfigPath);

  let credentialsWritten = false;
  let identityWritten = false;
  let policyInvalidated = false;

  withExclusiveLock(
    paths.claudeConfigPath,
    () => {
      writeActivePointer(
        paths,
        {
          name: pointer?.name ?? name,
          credentialsFingerprint: pointer?.credentialsFingerprint ?? null,
          pending: name,
        },
        now,
      );

      try {
        if (target.credentials) {
          io(`create ${dirname(paths.credentialsPath)}`, () =>
            mkdirSync(dirname(paths.credentialsPath), { recursive: true, mode: DIR_MODE }),
          );
          writeFileAtomic(paths.credentialsPath, credentialsText(target.credentials));
          credentialsWritten = true;
          opts.hooks?.onAfterCredentialsWrite?.();
        }

        if (identityToWrite) {
          patchIdentityLocked(paths.claudeConfigPath, identityToWrite, configExistedBefore);
          identityWritten = true;
        }
      } catch (err) {
        rollbackCredentials(paths, live.credentialsRaw, credentialsWritten);
        restorePointer(paths, pointer, now);
        throw err;
      }

      // (8) The org policy is cached per identity — drop it so Claude refetches.
      if (existsSync(paths.policyLimitsPath)) {
        io(`remove ${paths.policyLimitsPath}`, () => unlinkSync(paths.policyLimitsPath));
        policyInvalidated = true;
      }

      writeActivePointer(
        paths,
        {
          name,
          credentialsFingerprint: target.credentials
            ? fingerprintCredentials(credentialsText(target.credentials))
            : null,
        },
        now,
      );
    },
    opts.lockDeadlineMs,
  );

  if (!target.credentials) {
    if (target.kind === "api-key") {
      warnings.push(
        `profile "${name}" is an api-key profile: export ${target.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV} before running claude`,
      );
      if (target.apiKeyEnvVar && !env[target.apiKeyEnvVar]) {
        warnings.push(`${target.apiKeyEnvVar} is not set in this environment`);
      }
    } else {
      warnings.push(`profile "${name}" has no stored credentials — ${paths.credentialsPath} was left untouched`);
    }
  }

  return {
    name,
    kind: target.kind,
    previousActive,
    wroteBack,
    wroteBackChanged,
    backupDir,
    orphanBackupDir,
    outgoingPreservedAs,
    credentialsWritten,
    identityWritten,
    policyInvalidated,
    apiKeyEnvVar: target.apiKeyEnvVar ?? null,
    warnings,
  };
}

/** Serialized form of a credential blob — one definition so fingerprints always match. */
function credentialsText(credentials: Record<string, unknown>): string {
  return `${JSON.stringify(credentials, null, 2)}\n`;
}

/** Put the credential file back exactly as we found it after a failed switch. */
function rollbackCredentials(paths: AuthPaths, previousRaw: string | null, credentialsWritten: boolean): void {
  if (!credentialsWritten) return;
  try {
    if (previousRaw === null) {
      if (existsSync(paths.credentialsPath)) unlinkSync(paths.credentialsPath);
    } else {
      writeFileAtomic(paths.credentialsPath, previousRaw);
    }
  } catch (err) {
    // Rollback itself failed: the outgoing blob is still preserved (invariant (a)), so
    // surface the original failure while making the recovery path visible.
    console.error(
      `[claude auth] could not roll back ${paths.credentialsPath} — restore it from the backup directory: ${String(err)}`,
    );
  }
}

/** Restore the pointer to its pre-switch state (clearing the pending marker). */
function restorePointer(paths: AuthPaths, pointer: ActivePointer | null, now: Date): void {
  try {
    if (!pointer) {
      const path = join(paths.profilesDir, ACTIVE_FILE);
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    writeActivePointer(paths, { name: pointer.name, credentialsFingerprint: pointer.credentialsFingerprint }, now);
  } catch (err) {
    console.error(`[claude auth] could not restore the active-profile pointer: ${String(err)}`);
  }
}

/** One clear sentence per reason the live credentials could not be attributed. */
function describeUnattributed(
  paths: AuthPaths,
  reason: AttributionReason,
  pointer: ActivePointer | null,
  orphanBackupDir: string | null,
  storedIn: string | null,
): string {
  const preserved = orphanBackupDir
    ? `backed up to ${orphanBackupDir}`
    : `already stored in profile "${storedIn}" — nothing to preserve`;
  switch (reason) {
    case "no-pointer":
      return `no profile owned the credentials at ${paths.credentialsPath} — they were ${preserved}. Run "mcx claude auth save <name>" first to keep them as a profile.`;
    case "other-config-dir":
      return `the active profile "${pointer?.name}" was recorded for ${pointer?.credentialsPath} — the credentials in this config dir were ${preserved}`;
    case "interrupted-switch":
      return `a previous switch to "${pointer?.pending}" was interrupted, so the owner of the live credentials is unknown — they were ${preserved}`;
    case "pointer-profile-missing":
      return `the active profile "${pointer?.name}" no longer exists — the live credentials were ${preserved}`;
    case "api-key-pointer":
      return `the active profile "${pointer?.name}" is an api-key profile and stores no tokens, so it cannot own the live credentials — they were ${preserved}`;
    default:
      return `the credentials at ${paths.credentialsPath} do not match any profile (refreshed by another account, or written outside mcx) — they were ${preserved}`;
  }
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

export type QuotaFetcher = (token: { accessToken: string }) => Promise<QuotaStatus>;

/** Pull the live OAuth access token out of a credentials blob. Never logs it. */
export function accessTokenFromCredentials(credentials: Record<string, unknown> | null | undefined): string | null {
  const root = credentials?.claudeAiOauth;
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const token = (root as Record<string, unknown>).accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Access-token expiry vs `now`. Null when the blob has no numeric `expiresAt`. */
export function isOauthTokenExpired(
  credentials: Record<string, unknown> | null | undefined,
  now: Date,
): boolean | null {
  const root = credentials?.claudeAiOauth;
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const expiresAt = (root as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "number") return null;
  return expiresAt <= now.getTime();
}

export interface UnexpiredQuotaFetch {
  name: string;
  quota: StoredQuota;
}

export interface UnexpiredQuotaWarning {
  name: string;
  message: string;
}

export type SleepFn = (ms: number) => Promise<void>;

export interface FetchUnexpiredQuotaOpts {
  /** Live credential state, used to overlay the profile that provably owns it. */
  live?: LiveState | null;
  /** Injected by tests so 429 backoff does not wait on the clock. */
  sleep?: SleepFn;
  maxAttempts?: number;
  /** Total wall-clock budget for the whole sweep, sleeps included. */
  budgetMs?: number;
  /** Injected by tests alongside `sleep` so the budget is exercised without real time. */
  clock?: () => number;
}

/**
 * Hit the usage API for every oauth profile whose stored access token is not
 * expired. Fetches run **one at a time** — the usage endpoint 429s a parallel
 * burst immediately. On 429, wait Retry-After (or exponential backoff) and
 * retry that profile; if retries exhaust, move on with retries disabled rather
 * than keep hammering. Does not switch identities and does not stamp.
 *
 * `live` credentials overlay the profile that provably owns them when the live
 * token is still valid, so a Claude-refreshed CURRENT is measured even if the
 * stored copy has gone stale/expired.
 *
 * A 429 no longer aborts the fleet: the throttled profile is recorded and the rest
 * of the sweep continues with a single attempt each. `budgetMs` bounds the whole
 * walk, sleeps included, so an intermittently-throttled fleet cannot accumulate
 * minutes of backoff (#3426).
 */
export async function fetchUnexpiredProfileQuotas(
  paths: AuthPaths,
  now: Date,
  fetchQuota: QuotaFetcher,
  opts: FetchUnexpiredQuotaOpts = {},
): Promise<{
  fetched: UnexpiredQuotaFetch[];
  warnings: UnexpiredQuotaWarning[];
  skippedExpired: string[];
  skippedRateLimited: string[];
  /** Profiles left unattempted because the sweep ran out of wall-clock budget. */
  skippedBudget: string[];
  /** Profile whose stored credentials the live blob overlaid, when ownership was proven. */
  overlaidProfile: string | null;
}> {
  const targets: { name: string; credentials: Record<string, unknown> }[] = [];
  const skippedExpired: string[] = [];
  const live = opts.live;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxAttempts = opts.maxAttempts ?? QUOTA_RATE_LIMIT_MAX_ATTEMPTS;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? QUOTA_FETCH_ALL_BUDGET_MS);

  for (const name of listProfileNames(paths)) {
    let profile: ClaudeAuthProfile | null;
    try {
      profile = readProfile(paths, name);
    } catch {
      continue;
    }
    if (!profile || profile.kind !== "oauth" || !profile.credentials) continue;
    if (!accessTokenFromCredentials(profile.credentials)) continue;
    if (isOauthTokenExpired(profile.credentials, now) === true) {
      skippedExpired.push(name);
      continue;
    }
    targets.push({ name, credentials: profile.credentials });
  }

  // The overlay goes on the profile that *provably* owns the live blob, never on
  // whatever the pointer happens to name: after a `claude /login` behind mcx's back
  // the pointer names one account and the live token is another's, and overlaying on
  // the name alone both replaces the real target (so its own token is never queried)
  // and files a stranger's numbers under it (#3424).
  const owner = live ? (attributeLiveCredentials(paths, live, readActivePointer(paths)).owner?.name ?? null) : null;
  let overlaidProfile: string | null = null;
  if (
    owner &&
    live?.credentials &&
    accessTokenFromCredentials(live.credentials) &&
    isOauthTokenExpired(live.credentials, now) !== true
  ) {
    const overlay = { name: owner, credentials: live.credentials };
    const idx = targets.findIndex((t) => t.name === owner);
    if (idx >= 0) targets[idx] = overlay;
    else targets.push(overlay);
    const skipIdx = skippedExpired.indexOf(owner);
    if (skipIdx >= 0) skippedExpired.splice(skipIdx, 1);
    overlaidProfile = owner;
  }

  const fetched: UnexpiredQuotaFetch[] = [];
  const warnings: UnexpiredQuotaWarning[] = [];
  const skippedRateLimited: string[] = [];
  const skippedBudget: string[] = [];
  // A throttled profile no longer aborts the fleet — with a stable (sorted) walk order
  // that starved every profile after the first one permanently. It degrades the rest of
  // the sweep to a single attempt each instead: everyone still gets a turn, but a hot
  // endpoint is not retried N times over.
  let throttled = false;

  for (const target of targets) {
    if (clock() >= deadline) {
      skippedBudget.push(target.name);
      continue;
    }
    const row = await snapshotQuotaFromCredentialsRetrying(target.credentials, now, fetchQuota, {
      sleep,
      maxAttempts: throttled ? 1 : maxAttempts,
      deadline,
      clock,
    });
    if (row.quota) fetched.push({ name: target.name, quota: row.quota });
    if (row.warning) warnings.push({ name: target.name, message: row.warning });
    if (row.rateLimited) {
      skippedRateLimited.push(target.name);
      throttled = true;
    }
  }
  return { fetched, warnings, skippedExpired, skippedRateLimited, skippedBudget, overlaidProfile };
}

/**
 * Best-effort usage snapshot. Network happens here, outside any lock. A failure
 * returns a warning and no quota — callers keep the previous snapshot.
 */
export async function snapshotQuotaFromCredentials(
  credentials: Record<string, unknown> | null | undefined,
  now: Date,
  fetchQuota: QuotaFetcher = fetchQuotaUsage,
): Promise<{ quota?: StoredQuota; warning?: string }> {
  const accessToken = accessTokenFromCredentials(credentials);
  if (!accessToken) return {};
  try {
    const status = await fetchQuota({ accessToken });
    return { quota: toStoredQuota(status, now.toISOString()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warning: `could not snapshot quota: ${msg}` };
  }
}

/**
 * Like snapshotQuotaFromCredentials, but retries 429s with Retry-After /
 * exponential backoff instead of treating them as a hard miss. Non-429
 * failures still return a warning on the first try. `sleep` is injected so
 * tests do not wait on the clock.
 */
export async function snapshotQuotaFromCredentialsRetrying(
  credentials: Record<string, unknown> | null | undefined,
  now: Date,
  fetchQuota: QuotaFetcher,
  opts: { sleep?: SleepFn; maxAttempts?: number; deadline?: number; clock?: () => number } = {},
): Promise<{ quota?: StoredQuota; warning?: string; rateLimited?: boolean }> {
  const accessToken = accessTokenFromCredentials(credentials);
  if (!accessToken) return {};
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxAttempts = opts.maxAttempts ?? QUOTA_RATE_LIMIT_MAX_ATTEMPTS;
  const clock = opts.clock ?? Date.now;
  let backoff = QUOTA_RATE_LIMIT_BACKOFF_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const status = await fetchQuota({ accessToken });
      return { quota: toStoredQuota(status, now.toISOString()) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isQuotaRateLimitError(err) || attempt === maxAttempts) {
        return isQuotaRateLimitError(err)
          ? { warning: `rate-limited: ${msg}`, rateLimited: true }
          : { warning: `could not snapshot quota: ${msg}` };
      }
      // The cap belongs here, at the sleep, not only inside parseRetryAfterHeader:
      // any other producer of a QuotaRateLimitError would otherwise be able to make
      // this loop sleep for hours.
      const wait = Math.min(quotaRetryAfterMs(err) ?? backoff, QUOTA_RATE_LIMIT_MAX_RETRY_AFTER_MS);
      if (opts.deadline !== undefined && clock() + wait >= opts.deadline) {
        return { warning: `rate-limited: ${msg}`, rateLimited: true };
      }
      await sleep(wait);
      backoff = Math.min(backoff * 2, QUOTA_RATE_LIMIT_MAX_BACKOFF_MS);
    }
  }
  return { warning: "rate-limited", rateLimited: true };
}

/**
 * Non-secret projection of a profile. Never reads or returns token material —
 * only expiry, account, policy, and quota-snapshot metadata.
 */
export function summarizeProfile(profile: ClaudeAuthProfile, activeName: string | null, now: Date): ProfileSummary {
  const root = credentialsRoot(profile);
  const expiresAtMs = typeof root?.expiresAt === "number" ? root.expiresAt : null;
  const subscription = typeof root?.subscriptionType === "string" ? root.subscriptionType : null;
  const rateLimitTier = typeof root?.rateLimitTier === "string" ? root.rateLimitTier : null;
  const refreshToken = typeof root?.refreshToken === "string" ? root.refreshToken : "";

  return {
    name: profile.name,
    kind: profile.kind,
    active: profile.name === activeName,
    account: oauthField(profile, "emailAddress") ?? oauthField(profile, "accountUuid"),
    organization: oauthField(profile, "organizationName"),
    subscriptionType: subscription,
    rateLimitTier,
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    expired: expiresAtMs === null ? null : expiresAtMs <= now.getTime(),
    hasRefreshToken: refreshToken.length > 0,
    apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
    allowRemoteControl: profile.policy?.allowRemoteControl ?? null,
    hasCredentials: profile.credentials !== undefined,
    updatedAt: profile.updatedAt,
    quota: profile.quota ?? null,
  };
}

export interface ProfileListing {
  profiles: ProfileSummary[];
  /** Profiles that could not be read. One bad file must never hide the healthy ones. */
  problems: { name: string; message: string }[];
}

export function listProfiles(paths: AuthPaths, now: Date): ProfileListing {
  const active = readActiveProfileName(paths);
  const profiles: ProfileSummary[] = [];
  const problems: { name: string; message: string }[] = [];
  for (const name of listProfileNames(paths)) {
    try {
      const profile = readProfile(paths, name);
      if (!profile) continue;
      profiles.push(summarizeProfile(profile, active, now));
    } catch (err) {
      problems.push({ name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { profiles, problems };
}
