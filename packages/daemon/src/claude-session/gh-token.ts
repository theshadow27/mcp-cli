/**
 * GitHub credential scoping for spawned Claude sessions (#1510).
 *
 * The daemon spawns children with `{ ...process.env, ...overrides }`, so every
 * worker inherits whatever GitHub credential the daemon's environment carried —
 * and, more importantly, whatever `gh` and `git` can *reach* from that
 * environment. Containment (#1441) bounds a worker's filesystem blast radius;
 * this bounds its GitHub API reach.
 *
 * ## Every spawned session is a worker
 *
 * There is no `orchestrator` tier here, and that is deliberate. The orchestrator
 * is the process *calling* `spawnClaude`; it is never the process being spawned,
 * so the daemon can never learn from a spawn request that the child deserves
 * admin. An earlier revision keyed the tier on `config.worktree` — an optional
 * caller-supplied label whose omission *promoted* the child (`mcx claude resume`
 * never sets it). A security boundary keyed to a flag a caller can forget is not
 * a boundary; the only safe default is the least privilege one, so the admin
 * token has no code path into any child env at all.
 *
 * The `orchestrator` key in the tokens file is therefore a *declaration*, not an
 * injection source: its presence tells the daemon "an admin credential exists on
 * this box, never hand it down", which flips an otherwise-unconfigured worker
 * from `inherited` to `denied`.
 *
 * ## Unsetting `GH_TOKEN` does not remove a credential
 *
 * `gh` falls back to `~/.config/gh/hosts.yml`, and `git push` over HTTPS reaches
 * the same credential through `credential.helper` in `~/.gitconfig`. Clearing
 * `GH_TOKEN` alone therefore *restores* the ambient admin credential while
 * reporting that it removed one. Both `scoped` and `denied` pin `GH_CONFIG_DIR`
 * at an isolated directory and reset the git credential-helper list, so the
 * injected token (or the absence of one) is the whole of the child's reach
 * rather than merely winning a precedence race.
 *
 * ## Fail closed
 *
 * A tokens file that is present but unreadable, loosely permissioned, or
 * malformed resolves to `denied` with a loud, secret-free problem string — never
 * to "inherit the ambient admin credential". Only "no file configured at all"
 * falls through to legacy inherited behaviour.
 *
 * Token material reaches exactly one place: the child process env. It is never
 * written to SQLite, the daemon log ring, stderr, an error message, or an event
 * payload.
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { options } from "@mcp-cli/core";

/** Env vars a child process reads GitHub credentials from. */
export const GH_CREDENTIAL_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Env vars mcx itself reads token material from. Never forwarded to a child. */
export const GH_TOKEN_SOURCE_ENV_KEYS = ["MCX_GH_TOKEN_WORKER", "MCX_GH_TOKEN_ORCHESTRATOR"] as const;

/**
 * Env vars telling the child what its own GitHub reach is, and why.
 *
 * A real `denied` costs the child `gh pr create` and `git push`, so a worker
 * that discovers this as a bare 401 has no way to tell "my credential is scoped
 * on purpose" from "the network is broken" — it retries, or worse, works around
 * it. Both values are secret-free by construction: the mode and the same
 * `reason` string the daemon logs.
 */
export const GH_CREDENTIAL_NOTICE_ENV_KEYS = ["MCX_GH_CREDENTIALS", "MCX_GH_CREDENTIALS_REASON"] as const;

/**
 * Longest token string accepted. Generous enough for a GitHub App JWT; a value
 * past it is a paste accident, not a credential. Over-long values are now
 * rejected *loudly* (see `readGhTokensFile`), so the cap cannot silently
 * downgrade a spawn.
 */
const MAX_TOKEN_CHARS = 4096;

/** The `git credential` helper that resolves `GH_TOKEN` for HTTPS remotes. */
const GH_CREDENTIAL_HELPER = "!gh auth git-credential";

/** The configured credential pair. A missing key means "not configured". */
export interface GhTokenSource {
  /** Write-scoped token handed to spawned sessions. */
  worker?: string;
  /**
   * Admin-scoped token. Declared so the daemon knows an admin credential exists
   * and must never be handed down — it is never injected into any child.
   */
  orchestrator?: string;
}

/**
 * - `scoped` — the worker token was injected and the ambient fallback closed.
 * - `denied` — no worker token is usable, so the child spawns with no GitHub
 *   credential reachable at all (not merely with `GH_TOKEN` unset).
 * - `inherited` — nothing configured; the child inherits ambient credentials
 *   (legacy single-token behaviour, byte-identical to pre-#1510 spawns).
 */
export type GhTokenMode = "scoped" | "denied" | "inherited";

/** Resolved credential configuration. `problem` set ⇒ every spawn fails closed. */
export interface GhTokenConfig {
  tokens: GhTokenSource;
  /**
   * Secret-free description of a degraded read. Present only when a tokens file
   * exists but could not be trusted — distinct from "no file configured", which
   * leaves this unset.
   */
  problem?: string;
}

/** Everything the policy needs about the spawn it is deciding for. */
export interface SpawnCredentialContext {
  /** The environment the child would otherwise inherit (normally `process.env`). */
  sourceEnv: Record<string, string | undefined>;
  /**
   * Directory `GH_CONFIG_DIR` is pinned to. It must not contain a `hosts.yml`.
   * A path that does not exist is fine and is the normal case — `gh` reports
   * "not logged in" rather than falling back to `~/.config/gh`.
   */
  isolatedGhConfigDir: string;
}

export interface GhTokenDecision {
  /** Env overrides to merge into the spawn env. An `undefined` value unsets an inherited var. */
  env: Record<string, string | undefined>;
  mode: GhTokenMode;
  /** Secret-free explanation of the mode. Safe to log, emit, and put in errors. */
  reason: string;
  /** Set when the mode was forced by a degraded config read. Warrants an error-level log every spawn. */
  problem?: string;
  /** True when the caller should emit the one-time single-token warning. */
  warnSingleToken: boolean;
}

/**
 * Accept a token string, or reject it as unusable.
 *
 * Rejects blanks, control characters, and embedded whitespace — a value that
 * cannot round-trip through an env var is a config mistake, and silently
 * passing it on produces a confusing 401 inside the worker instead of a clear
 * decision here.
 */
export function normalizeGhToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_TOKEN_CHARS) return undefined;
  if (/[\s\p{Cc}]/u.test(trimmed)) return undefined;
  return trimmed;
}

/** Normalize an untrusted `{ worker, orchestrator }` shape into a `GhTokenSource`. */
export function normalizeGhTokens(raw: unknown): GhTokenSource {
  if (raw === null || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const worker = normalizeGhToken(record.worker);
  const orchestrator = normalizeGhToken(record.orchestrator);
  return {
    ...(worker !== undefined ? { worker } : {}),
    ...(orchestrator !== undefined ? { orchestrator } : {}),
  };
}

/**
 * True when a file mode grants no group/other access (0600, 0400, ...).
 *
 * A tokens file every process on the box can read defeats the point of scoping.
 */
export function isPrivateFileMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Render the permission bits of a stat mode as `0644`, for an operator-facing error. */
export function formatFileMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

/** Read the credential pair out of an env snapshot. */
export function ghTokensFromEnv(env: Record<string, string | undefined>): GhTokenSource {
  return normalizeGhTokens({
    worker: env.MCX_GH_TOKEN_WORKER,
    orchestrator: env.MCX_GH_TOKEN_ORCHESTRATOR,
  });
}

/** Merge the two sources, per key. The tokens file wins over the ambient env. */
export function mergeGhTokens(fileTokens: GhTokenSource, envTokens: GhTokenSource): GhTokenSource {
  const worker = fileTokens.worker ?? envTokens.worker;
  const orchestrator = fileTokens.orchestrator ?? envTokens.orchestrator;
  return {
    ...(worker !== undefined ? { worker } : {}),
    ...(orchestrator !== undefined ? { orchestrator } : {}),
  };
}

/**
 * True for any inherited env var that could carry GitHub credential material or
 * redirect where `gh`/`git` look for it.
 *
 * This is matched as a *namespace* and cleared wholesale, so the policy's own
 * assignments are the only members of it a scoped or denied child sees. A
 * two-name denylist is under-inclusive by construction — `GH_ENTERPRISE_TOKEN`,
 * `GITHUB_PERSONAL_ACCESS_TOKEN`, `GIT_ASKPASS` and a `GIT_CONFIG_*` injection
 * all reach a credential without being named.
 */
export function isCredentialNamespaceKey(key: string): boolean {
  if (/^(?:GH|GITHUB)_/.test(key)) return true;
  if (/^GIT_CONFIG_/.test(key)) return true;
  return key === "GIT_ASKPASS" || key === "SSH_ASKPASS" || key === "GIT_TERMINAL_PROMPT";
}

/**
 * Overrides that clear the whole credential namespace out of the inherited env.
 *
 * Returns an explicit `undefined` per key rather than an omission, because the
 * child is spawned with `{ ...process.env, ...overrides }` — only a present key
 * with an `undefined` value unsets an inherited variable.
 */
export function scrubCredentialNamespace(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = {};
  for (const key of Object.keys(sourceEnv)) {
    if (isCredentialNamespaceKey(key)) scrubbed[key] = undefined;
  }
  // Always clear the source vars, even when the daemon's own env lacks them —
  // an intermediate layer must not be able to reintroduce them.
  for (const key of GH_TOKEN_SOURCE_ENV_KEYS) scrubbed[key] = undefined;
  for (const key of GH_CREDENTIAL_ENV_KEYS) scrubbed[key] = undefined;
  return scrubbed;
}

/**
 * Close the two ambient fallbacks that survive an unset `GH_TOKEN`.
 *
 * 1. `GH_CONFIG_DIR` moves `gh` off `~/.config/gh/hosts.yml`. Verified: `gh`
 *    reports "not logged into any GitHub hosts" for a missing or unwritable
 *    directory — it does not fall back.
 * 2. `GIT_CONFIG_COUNT`/`KEY`/`VALUE` reset the git credential-helper list with
 *    the precedence of `git -c`, clearing both the generic `credential.helper`
 *    and the URL-scoped `credential.https://github.com.helper` that
 *    `gh auth setup-git` writes. This is surgical where `GIT_CONFIG_GLOBAL=/dev/null`
 *    is not: identity and signing config in `~/.gitconfig` survive, so a scoped
 *    worker can still commit.
 *
 * `pinGhHelper` re-adds `gh auth git-credential` as the *only* helper, so a
 * scoped worker's `git push` resolves through the injected token — and through
 * nothing else, including a `store` or keychain helper holding an admin
 * credential. Denied spawns leave the list empty and `git push` fails cleanly.
 */
function credentialIsolationEnv(
  isolatedGhConfigDir: string,
  opts: { pinGhHelper: boolean },
): Record<string, string | undefined> {
  const entries: Array<[string, string]> = [
    ["credential.https://github.com.helper", ""],
    ["credential.helper", ""],
  ];
  if (opts.pinGhHelper) entries.push(["credential.helper", GH_CREDENTIAL_HELPER]);

  const env: Record<string, string | undefined> = {
    GH_CONFIG_DIR: isolatedGhConfigDir,
    // Fail fast instead of hanging on a prompt the child has no terminal for.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * The whole allow/deny table for spawn-time GitHub credentials.
 *
 * | config                        | outcome                                          |
 * |-------------------------------|--------------------------------------------------|
 * | degraded read (`problem` set) | `denied` — fail closed, loud                     |
 * | worker token set              | `scoped` — worker token injected, fallback closed |
 * | only an admin token declared  | `denied` — no credential reachable               |
 * | nothing configured            | `inherited` + single-token warning               |
 *
 * The admin token has no path to any decision's `env`. That is the security
 * property, and it is enforced here rather than at the call site.
 */
export function resolveSpawnGhToken(config: GhTokenConfig, ctx: SpawnCredentialContext): GhTokenDecision {
  /** Compose one non-inherited decision: scrub, isolate, inject, then explain. */
  const decide = (
    mode: Exclude<GhTokenMode, "inherited">,
    reason: string,
    opts: { token?: string; problem?: string },
  ): GhTokenDecision => ({
    env: {
      ...scrubCredentialNamespace(ctx.sourceEnv),
      ...credentialIsolationEnv(ctx.isolatedGhConfigDir, { pinGhHelper: opts.token !== undefined }),
      ...credentialEnv(opts.token),
      ...noticeEnv(mode, reason),
    },
    mode,
    reason,
    ...(opts.problem !== undefined ? { problem: opts.problem } : {}),
    warnSingleToken: false,
  });

  if (config.problem !== undefined) {
    return decide(
      "denied",
      `GitHub credential config could not be trusted, spawning with no GitHub access — ${config.problem}`,
      { problem: config.problem },
    );
  }

  if (config.tokens.worker !== undefined) {
    return decide("scoped", "write-scoped worker token injected; ambient gh/git credential fallback closed", {
      token: config.tokens.worker,
    });
  }

  if (config.tokens.orchestrator !== undefined) {
    // An admin token is declared, so the operator has drawn the line — a child
    // gets nothing rather than the credential it must not hold.
    return decide(
      "denied",
      "no worker token configured and the admin token is never shared with a child — spawned with no GitHub access",
      {},
    );
  }

  // Nothing configured: preserve legacy behaviour exactly (no overrides at all)
  // and let the caller warn that children run with the daemon's privileges.
  return {
    env: {},
    mode: "inherited",
    reason: "single-token mode — spawned session inherits the daemon's GitHub credentials",
    warnSingleToken: true,
  };
}

/** Path of the credential pair file. */
export function ghTokensPath(): string {
  return join(options.MCP_CLI_DIR, "tokens.json");
}

/**
 * Directory `GH_CONFIG_DIR` is pinned to for scoped and denied spawns.
 *
 * Deliberately not pre-created: `gh` treats a missing config directory as "not
 * logged in", which is exactly the desired state, and creates it itself only if
 * it needs to cache something. Nothing here ever writes credentials to it.
 */
export function isolatedGhConfigDir(): string {
  return join(options.MCP_CLI_DIR, "gh-isolated");
}

/** Outcome of reading the tokens file. `absent` is the only non-error miss. */
export type GhTokensFileRead =
  | { status: "absent" }
  | { status: "ok"; tokens: GhTokenSource }
  | { status: "error"; problem: string };

/**
 * Read and validate `tokens.json`.
 *
 * Every failure mode other than "no such file" is an *error*, not an empty
 * result: a 0644 file, a truncated read racing a non-atomic write, a stray
 * space in a token. Each of those used to degrade to ambient credentials while
 * telling the operator nothing. `problem` names the path (and the octal mode
 * where relevant) and never the token value.
 *
 * The mode is checked with `fstat` on the open descriptor rather than `stat` on
 * the path, so the bytes validated and the bytes read are the same inode.
 */
export function readGhTokensFile(path: string): GhTokensFileRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    return { status: "error", problem: `${path} could not be opened (${code ?? "unknown error"})` };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: "error", problem: `${path} is not a regular file` };
    if (!isPrivateFileMode(stat.mode)) {
      return {
        status: "error",
        problem: `${path} is mode ${formatFileMode(stat.mode)}; it must deny group and other access (chmod 600) — a credential the whole box can read is not scoped`,
      };
    }
    return parseGhTokensFile(readFileSync(fd, "utf-8"), path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { status: "error", problem: `${path} could not be read (${code ?? "unknown error"})` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse validated `tokens.json` text.
 *
 * An empty or truncated file is an error rather than "no tokens" — the doc's
 * own setup recipe is a non-atomic redirect, so a spawn can read a half-written
 * file, and that must not silently restore ambient credentials.
 */
export function parseGhTokensFile(text: string, path: string): GhTokensFileRead {
  if (text.trim() === "") {
    return { status: "error", problem: `${path} is empty (a truncated or partially written file)` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "error", problem: `${path} is not valid JSON (a truncated or partially written file?)` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "error", problem: `${path} must contain a JSON object with "worker" and/or "orchestrator" keys` };
  }

  const record = parsed as Record<string, unknown>;
  const tokens: GhTokenSource = {};
  for (const key of ["worker", "orchestrator"] as const) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    const token = normalizeGhToken(raw);
    if (token === undefined) {
      return {
        status: "error",
        problem: `${path} key "${key}" is not a usable token — it is blank, contains whitespace or control characters, or exceeds ${MAX_TOKEN_CHARS} characters`,
      };
    }
    tokens[key] = token;
  }

  if (tokens.worker === undefined && tokens.orchestrator === undefined) {
    return { status: "error", problem: `${path} declares neither a "worker" nor an "orchestrator" token` };
  }
  return { status: "ok", tokens };
}

/**
 * Load the configured credential pair from disk + env.
 *
 * Impure edge of this module: everything it feeds is pure and unit-tested. A
 * degraded file read is surfaced as `problem` and resolves to `denied` — the
 * env fallback deliberately does *not* rescue it, since the ambient env is
 * exactly the admin credential the file was written to stop handing down.
 */
export function loadGhTokens(
  env: Record<string, string | undefined> = process.env,
  path: string = ghTokensPath(),
): GhTokenConfig {
  const read = readGhTokensFile(path);
  if (read.status === "error") return { tokens: {}, problem: read.problem };
  const fileTokens = read.status === "ok" ? read.tokens : {};
  return { tokens: mergeGhTokens(fileTokens, ghTokensFromEnv(env)) };
}

/** Both credential vars set to one value — or unset, when the value is `undefined`. */
function credentialEnv(token: string | undefined): Record<string, string | undefined> {
  return Object.fromEntries(GH_CREDENTIAL_ENV_KEYS.map((key) => [key, token]));
}

/** Tell the child what reach it has and why, so a scoped 403 is legible rather than mysterious. */
function noticeEnv(mode: GhTokenMode, reason: string): Record<string, string | undefined> {
  const [modeKey, reasonKey] = GH_CREDENTIAL_NOTICE_ENV_KEYS;
  return { [modeKey]: mode, [reasonKey]: reason };
}
