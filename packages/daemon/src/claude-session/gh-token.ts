/**
 * Two-tier GitHub credential scoping for spawned Claude sessions (#1510).
 *
 * The daemon spawns children with `{ ...process.env, ...overrides }`, so every
 * worker inherits whatever `GH_TOKEN` / `GITHUB_TOKEN` the orchestrator's shell
 * happened to carry — typically an admin-scoped credential that can delete
 * rulesets, force-push `main`, or `gh pr merge --admin`. Containment (#1441)
 * bounds a worker's filesystem blast radius; this bounds its GitHub API reach.
 *
 * The policy is a pure function rather than a convention around an env
 * assignment: an invariant an orchestrator could rationalize past is a
 * function, not prose. `resolveSpawnGhToken` owns the whole allow/deny table
 * and returns only env overrides plus a secret-free `reason` — no token
 * material ever appears in its logs, events, or errors.
 *
 * Token material is read from `~/.mcp-cli/tokens.json` (preferred, must be
 * mode 0600) with `MCX_GH_TOKEN_WORKER` / `MCX_GH_TOKEN_ORCHESTRATOR` as a
 * fallback. It is never written to SQLite, the daemon log ring, stderr, an
 * error message, or an event payload.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { options } from "@mcp-cli/core";

/** Env vars a child process reads GitHub credentials from. */
export const GH_CREDENTIAL_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * Env vars mcx itself reads token material from. Never forwarded to a child:
 * the orchestrator's admin token would otherwise reach a worker under a
 * different name than the one we scoped.
 */
export const GH_TOKEN_SOURCE_ENV_KEYS = ["MCX_GH_TOKEN_WORKER", "MCX_GH_TOKEN_ORCHESTRATOR"] as const;

/** Longest token string accepted. GitHub PATs are ~40-255 chars; anything past this is not a token. */
const MAX_TOKEN_CHARS = 512;

/** The configured credential pair. A missing key means "not configured". */
export interface GhTokenSource {
  /** Write-scoped token handed to worker sessions. */
  worker?: string;
  /** Admin-scoped token. Orchestrator-only — never injected into a worker. */
  orchestrator?: string;
}

/** Which side of the trust boundary a spawn sits on. */
export type GhTokenRole = "worker" | "orchestrator";

/**
 * - `scoped` — the worker token was injected, replacing anything inherited.
 * - `denied` — an admin token is configured but no worker token, so the
 *   inherited credential is stripped rather than handed to a worker.
 * - `orchestrator` — the admin token was injected for a trusted spawn.
 * - `inherited` — nothing configured; the child inherits ambient credentials
 *   (legacy single-token behaviour).
 */
export type GhTokenMode = "scoped" | "denied" | "orchestrator" | "inherited";

export interface GhTokenDecision {
  /** Env overrides to merge into the spawn env. An `undefined` value unsets an inherited var. */
  env: Record<string, string | undefined>;
  mode: GhTokenMode;
  /** Secret-free explanation of the mode. Safe to log, emit, and put in errors. */
  reason: string;
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
 * A tokens file every process on the box can read defeats the point of
 * scoping, so a loose one is ignored rather than trusted.
 */
export function isPrivateFileMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Parse `tokens.json` text. Malformed or non-object content yields no tokens. */
export function parseGhTokensFile(text: string | null | undefined): GhTokenSource {
  if (typeof text !== "string" || text.trim() === "") return {};
  try {
    return normalizeGhTokens(JSON.parse(text));
  } catch {
    return {};
  }
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
 * Which side of the boundary a session sits on.
 *
 * A worktree spawn is a contained worker by construction — it is the shape the
 * orchestrator uses for delegated implementation work. Anything else runs in
 * the orchestrator's own checkout and keeps the trusted tier.
 */
export function ghTokenRole(config: { worktree?: string | null }): GhTokenRole {
  return config.worktree ? "worker" : "orchestrator";
}

/**
 * The whole allow/deny table for spawn-time GitHub credentials.
 *
 * | role         | worker token | admin token | outcome                          |
 * |--------------|--------------|-------------|----------------------------------|
 * | worker       | set          | any         | `scoped` — worker token injected |
 * | worker       | unset        | set         | `denied` — credentials stripped  |
 * | worker       | unset        | unset       | `inherited` + single-token warn  |
 * | orchestrator | any          | set         | `orchestrator` — admin injected  |
 * | orchestrator | any          | unset       | `inherited`                      |
 *
 * The admin token has no path to a `worker` decision. That is the security
 * property, and it is enforced here rather than at the call site.
 */
export function resolveSpawnGhToken(role: GhTokenRole, tokens: GhTokenSource): GhTokenDecision {
  if (role === "orchestrator") {
    if (tokens.orchestrator !== undefined) {
      return {
        env: credentialEnv(tokens.orchestrator),
        mode: "orchestrator",
        reason: "orchestrator spawn — admin token injected",
        warnSingleToken: false,
      };
    }
    return {
      env: {},
      mode: "inherited",
      reason: "orchestrator spawn — no admin token configured, inheriting ambient credentials",
      warnSingleToken: false,
    };
  }

  if (tokens.worker !== undefined) {
    return {
      env: { ...credentialEnv(tokens.worker), ...scrubbedSourceEnv() },
      mode: "scoped",
      reason: "worker spawn — write-scoped token injected",
      warnSingleToken: false,
    };
  }

  if (tokens.orchestrator !== undefined) {
    // An admin token is configured, so the operator has drawn the line — a
    // worker gets nothing rather than the credential it must not hold.
    return {
      env: { ...credentialEnv(undefined), ...scrubbedSourceEnv() },
      mode: "denied",
      reason: "worker spawn — no worker token configured; inherited credentials stripped (admin token is not shared)",
      warnSingleToken: false,
    };
  }

  // Nothing configured: preserve legacy behaviour exactly (no overrides at
  // all) and let the caller warn once that workers run with the
  // orchestrator's privileges.
  return {
    env: {},
    mode: "inherited",
    reason: "single-token mode — worker inherits orchestrator credentials",
    warnSingleToken: true,
  };
}

/** Path of the credential pair file. Resolved at call time so tests can retarget MCP_CLI_DIR. */
export function ghTokensPath(): string {
  return join(options.MCP_CLI_DIR, "tokens.json");
}

/**
 * Load the configured credential pair from disk + env.
 *
 * Impure edge of this module: everything it feeds is pure and unit-tested.
 * Any read failure (missing file, bad permissions, unparseable) degrades to
 * the env source — never throws into a spawn path.
 */
export function loadGhTokens(env: Record<string, string | undefined> = process.env): GhTokenSource {
  return mergeGhTokens(readGhTokensFile(ghTokensPath()), ghTokensFromEnv(env));
}

function readGhTokensFile(path: string): GhTokenSource {
  try {
    if (!isPrivateFileMode(statSync(path).mode)) return {};
    return parseGhTokensFile(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Both credential vars set to one value — or unset, when the value is `undefined`. */
function credentialEnv(token: string | undefined): Record<string, string | undefined> {
  return Object.fromEntries(GH_CREDENTIAL_ENV_KEYS.map((key) => [key, token]));
}

/** Source vars stripped from the child env so token material cannot ride along under another name. */
function scrubbedSourceEnv(): Record<string, string | undefined> {
  return Object.fromEntries(GH_TOKEN_SOURCE_ENV_KEYS.map((key) => [key, undefined]));
}
