/**
 * Spawn profiles — named env-var bundles attached to agent spawns (#935).
 *
 * A *profile* is one file: `~/.mcp-cli/profiles/<name>.env`, dotenv-shaped
 * (`KEY=VALUE`, `#` comments, an optional `export ` prefix so an existing
 * `source`-able shell file imports verbatim). Its motivating use is routing
 * spawned workers at AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK`,
 * `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_DEFAULT_*_MODEL`) while the
 * interactive session stays on the subscription.
 *
 * ── Secrets never leave the daemon ──
 * Profile files hold credentials. Only the profile NAME travels: the CLI puts
 * a name in the RPC args, the daemon reads the file at spawn time and hands the
 * values straight to the child process env. Consequences, each pinned by a test:
 *   - no value is ever written to SQLite (nothing here touches the state DB),
 *   - no value appears in a log line, an event payload, or stderr,
 *   - a parse error names the file and line NUMBER, never the line's content —
 *     a wrapped secret must not be echoed back by the thing that rejected it,
 *   - display helpers return key NAMES only (`describeSpawnProfile`), never values.
 *
 * ── Precedence is a function, not prose ──
 * `resolveSpawnProfile` is the single source of truth for
 *   `--profile` flag  >  repo `.mcx.yaml`  >  `defaultProfile` config  >  none.
 * Call sites supply the layers; they do not re-implement the ordering. A
 * precedence order described in a doc is one a future caller reorders by
 * accident.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { options } from "./constants";
import { MANIFEST_MAX_BYTES, findManifest, parseManifestText } from "./manifest";

// ── Names and paths ──

/** Profile name grammar. These become filenames — keep them boring. */
export const SPAWN_PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** File extension for profile files. */
export const SPAWN_PROFILE_EXT = ".env";

/** Max profile file size. Guards against FIFOs, /dev/zero, runaway files. */
export const SPAWN_PROFILE_MAX_BYTES = 256 * 1024;

/** Thrown for any profile problem. Message never contains a profile VALUE. */
export class SpawnProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnProfileError";
  }
}

/** Throw unless `name` is a legal profile name. */
export function validateSpawnProfileName(name: string): void {
  if (!SPAWN_PROFILE_NAME_RE.test(name)) {
    throw new SpawnProfileError(
      `invalid profile name "${name}": must match ${SPAWN_PROFILE_NAME_RE} (letters, digits, hyphens, underscores; ≤64 chars)`,
    );
  }
}

/** Absolute path of a profile file. Validates the name (no traversal). */
export function spawnProfilePath(name: string, dir: string = options.PROFILES_DIR): string {
  validateSpawnProfileName(name);
  return join(dir, `${name}${SPAWN_PROFILE_EXT}`);
}

// ── Precedence ──

/** Which layer supplied the resolved profile. `"none"` = no layer set one. */
export type SpawnProfileSource = "flag" | "manifest" | "config" | "none";

/**
 * The layers, highest-precedence first. For each:
 *   `undefined` — layer is absent, fall through to the next one
 *   `null` / `""` — layer explicitly opts out (e.g. `--no-profile`), stopping
 *                   the search: a lower layer must not resurrect a profile the
 *                   caller just turned off
 *   a name       — that profile wins
 */
export interface SpawnProfileSources {
  /** `--profile <name>`, or `null` for `--no-profile`. */
  flag?: string | null;
  /** `profile:` from the repo's `.mcx.yaml`. */
  manifest?: string | null;
  /** `defaultProfile` from `~/.mcp-cli/config.json`. */
  config?: string | null;
}

export interface ResolvedSpawnProfile {
  /** Profile name to apply, or null for "inherit the bare daemon env". */
  name: string | null;
  /** Layer the answer came from — for diagnostics ("why is this on Bedrock?"). */
  source: SpawnProfileSource;
}

/**
 * Resolve which profile a spawn uses.
 *
 * Pure and total: no filesystem, no throw, no name validation (an unknown or
 * malformed name is the loader's problem, and failing there gives a better
 * message than failing here). This is the ONLY place the precedence order
 * exists — see the module header.
 */
export function resolveSpawnProfile(sources: SpawnProfileSources): ResolvedSpawnProfile {
  const layers: Array<[Exclude<SpawnProfileSource, "none">, string | null | undefined]> = [
    ["flag", sources.flag],
    ["manifest", sources.manifest],
    ["config", sources.config],
  ];
  for (const [source, value] of layers) {
    if (value === undefined) continue;
    const name = value === null ? "" : value.trim();
    return { name: name === "" ? null : name, source };
  }
  return { name: null, source: "none" };
}

// ── .env parsing ──

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env vars a profile may not set: the daemon derives each one per-spawn, and a
 * profile silently overriding them would move a session outside its containment
 * boundary (GIT_*), break its trace, or make the child refuse to start.
 */
export const RESERVED_SPAWN_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "PWD",
  "TRACEPARENT",
]);

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === "'" && last === "'") return raw.slice(1, -1);
    if (first === '"' && last === '"') {
      return raw.slice(1, -1).replace(/\\([nrt"\\])/g, (_m, c: string) => {
        if (c === "n") return "\n";
        if (c === "r") return "\r";
        if (c === "t") return "\t";
        return c;
      });
    }
  }
  return raw;
}

/**
 * Parse dotenv-shaped text into an env map.
 *
 * `label` is used in error messages and should be a file path — errors quote the
 * label and the 1-based line number, never the line's content (it may be a
 * secret). Later duplicate keys win, matching dotenv.
 */
export function parseSpawnProfileEnv(text: string, label: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      throw new SpawnProfileError(`${label}:${i + 1}: expected KEY=VALUE`);
    }
    const key = body.slice(0, eq).trimEnd();
    if (!ENV_KEY_RE.test(key)) {
      // The bad "key" may be the tail of a wrapped secret — describe the rule,
      // never echo the text that failed it.
      throw new SpawnProfileError(`${label}:${i + 1}: invalid variable name (must match ${ENV_KEY_RE})`);
    }
    if (RESERVED_SPAWN_ENV_KEYS.has(key)) {
      throw new SpawnProfileError(
        `${label}:${i + 1}: "${key}" is set per-spawn by the daemon and cannot come from a profile`,
      );
    }
    env[key] = unquote(body.slice(eq + 1).trim());
  }
  return env;
}

// ── Loading ──

export interface LoadedSpawnProfile {
  name: string;
  path: string;
  /** The env vars to apply. Never log, persist, or serialize this. */
  env: Record<string, string>;
  /** True when the file is group- or world-readable (a secret store should be 0600). */
  insecureMode: boolean;
}

/**
 * Read and parse a profile. Throws `SpawnProfileError` when it is missing,
 * oversized, or malformed — a spawn that asked for a profile must fail loudly
 * rather than silently run against whatever env the daemon happens to hold,
 * which is exactly the fragility #935 exists to remove.
 */
export function loadSpawnProfile(name: string, dir: string = options.PROFILES_DIR): LoadedSpawnProfile {
  const path = spawnProfilePath(name, dir);
  let size: number;
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new SpawnProfileError(`profile "${name}" is not a regular file (${path})`);
    size = st.size;
    mode = st.mode;
  } catch (err) {
    if (err instanceof SpawnProfileError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SpawnProfileError(`profile "${name}" not found (expected ${path})`);
    }
    throw new SpawnProfileError(`profile "${name}" is unreadable (${path}): ${code ?? "unknown error"}`);
  }
  if (size > SPAWN_PROFILE_MAX_BYTES) {
    throw new SpawnProfileError(`profile "${name}" is too large (${size} bytes > ${SPAWN_PROFILE_MAX_BYTES})`);
  }
  const text = readFileSync(path, "utf-8");
  return { name, path, env: parseSpawnProfileEnv(text, path), insecureMode: (mode & 0o077) !== 0 };
}

/** Names of every profile in `dir`, sorted. Returns `[]` when the dir is absent. */
export function listSpawnProfiles(dir: string = options.PROFILES_DIR): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No profiles directory yet — an empty list is the honest answer.
    return [];
  }
  return entries
    .filter((f) => f.endsWith(SPAWN_PROFILE_EXT))
    .map((f) => f.slice(0, -SPAWN_PROFILE_EXT.length))
    .filter((n) => SPAWN_PROFILE_NAME_RE.test(n))
    .sort();
}

/** Redacted view of a profile: key NAMES only, never values. Safe to print. */
export interface SpawnProfileSummary {
  name: string;
  path: string;
  keys: string[];
  insecureMode: boolean;
}

/** Summarize a loaded profile for display. Drops every value by construction. */
export function describeSpawnProfile(profile: LoadedSpawnProfile): SpawnProfileSummary {
  return {
    name: profile.name,
    path: profile.path,
    keys: Object.keys(profile.env).sort(),
    insecureMode: profile.insecureMode,
  };
}

// ── Repo manifest layer ──

/** How far up the tree to look for a `.mcx.yaml` before giving up. */
const MANIFEST_SEARCH_MAX_DEPTH = 16;

/**
 * Read `profile:` from the nearest `.mcx.yaml` at or above `startDir`.
 *
 * Deliberately does not validate the whole manifest: a repo whose phase graph
 * is mid-edit must still be able to spawn. Returns `undefined` for "no manifest
 * / no profile key / unreadable", which `resolveSpawnProfile` treats as "layer
 * absent" and falls through.
 */
export function findManifestProfile(startDir: string | undefined): string | null | undefined {
  if (!startDir) return undefined;
  let dir = startDir;
  for (let depth = 0; depth < MANIFEST_SEARCH_MAX_DEPTH; depth++) {
    let path: string | null = null;
    try {
      path = findManifest(dir);
    } catch {
      // Unreadable directory (EACCES, ESTALE) — treat as "no manifest here".
      path = null;
    }
    if (path !== null) return readManifestProfileKey(path);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readManifestProfileKey(path: string): string | null | undefined {
  try {
    if (lstatSync(path).size > MANIFEST_MAX_BYTES) return undefined;
    const raw = parseManifestText(readFileSync(path, "utf-8"), path);
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = (raw as Record<string, unknown>).profile;
    if (value === null) return null;
    return typeof value === "string" ? value : undefined;
  } catch {
    // Malformed or unreadable manifest — the manifest layer simply does not
    // contribute. Full validation errors surface via `mcx phase`, not here.
    return undefined;
  }
}
