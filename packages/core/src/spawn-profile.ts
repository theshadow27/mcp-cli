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
 *   `--profile` flag  >  `defaultProfile` config  >  none,
 * with the repo `.mcx.yaml` able to opt OUT (`profile: null`) but never to
 * select. Call sites supply the layers; they do not re-implement the ordering.
 * A precedence order described in a doc is one a future caller reorders by
 * accident.
 *
 * Deselect-only is enforced in two places, both at RUNTIME, because a type
 * cannot enforce anything a caller can cast past:
 *   - `readManifestProfileKey` ignores a named `profile:` and warns, and
 *   - `resolveSpawnProfile` throws if handed one anyway.
 * `SpawnProfileSources.manifest?: null` documents the contract; it does not
 * enforce it.
 *
 * ── Containment is an allowlist ──
 * A profile may only set `AWS_*` / `ANTHROPIC_*` / `CLAUDE_CODE_*`-shaped
 * variables (see `SPAWN_PROFILE_ALLOWED_PREFIXES`). `PATH`, `LD_PRELOAD`,
 * `NODE_OPTIONS` and `MCP_CLI_DIR` are code execution and daemon reattachment,
 * not configuration, and no enumeration of them stays complete.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { options } from "./constants";
import { type GitRootResult, findWorktreeRootResult } from "./git";
import { MANIFEST_MAX_BYTES, findManifest, parseManifestText } from "./manifest";

/**
 * Sink for "this layer did not contribute, and here is why" diagnostics.
 *
 * Every fall-open path in this module takes one. A profile layer that goes
 * absent decides which account pays for a session, so it may degrade — a repo
 * mid-edit must still be able to spawn — but it must never do so silently.
 * Messages name the FILE, never its contents.
 */
export type SpawnProfileWarn = (message: string) => void;

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
  /**
   * `profile:` from the repo's `.mcx.yaml` — DESELECT-ONLY. `null` means "this
   * repo runs no profile" and overrides the operator's `defaultProfile`;
   * `undefined` means the layer does not contribute. There is deliberately no
   * `string` case: a `.mcx.yaml` arrives by `git clone`, and per `docs/trust.md`
   * rules from an untrusted source are ignored, not merged. Letting repo content
   * *select* a profile would let a third-party checkout pick which credentials an
   * auto-approving agent spawns with. Opting out is safe in the other direction —
   * the worst a hostile repo achieves is a session on the bare daemon env.
   *
   * This annotation is DOCUMENTATION, not enforcement — types erase, and a cast
   * defeats it. The rule is enforced at runtime by `findManifestProfile` (which
   * ignores a named value and warns) and by `resolveSpawnProfile` (which throws
   * if one reaches it anyway).
   */
  manifest?: null;
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
 * No filesystem, no name validation (an unknown or malformed name is the
 * loader's problem, and failing there gives a better message than failing here).
 * This is the ONLY place the precedence order exists — see the module header.
 *
 * Throws in exactly one case: a caller handing the manifest layer a profile
 * NAME. That is a programming error, not bad input — `findManifestProfile` can
 * never produce it — and it is the runtime half of deselect-only enforcement.
 */
export function resolveSpawnProfile(sources: SpawnProfileSources): ResolvedSpawnProfile {
  // Deselect-only, enforced at RUNTIME. `manifest?: null` in the interface is a
  // hint, not a guarantee — TypeScript types erase, so `{manifest: "prod" as
  // unknown as null}` would otherwise resolve to `{name: "prod", source:
  // "manifest"}` and hand repo content the credential choice the operator ruling
  // took away from it. An invariant a caller can cast past is prose.
  if (typeof sources.manifest === "string") {
    throw new SpawnProfileError(
      "the manifest layer is deselect-only: a repo `.mcx.yaml` may pass null (opt out) or undefined, never a profile name — see findManifestProfile, which ignores named values and warns",
    );
  }
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
 *
 * This is a *specific-diagnostic* list, not the containment boundary — the
 * allowlist below already excludes every key here. It exists so the operator
 * who tries the plausible thing (`GIT_WORK_TREE=...`) gets told why rather than
 * "not allowed".
 */
export const RESERVED_SPAWN_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "PWD",
  "TRACEPARENT",
]);

/**
 * The containment boundary: a profile may only set variables matching one of
 * these prefixes or named in {@link SPAWN_PROFILE_ALLOWED_KEYS}.
 *
 * An allowlist, not a denylist, and deliberately so. A profile file is read by
 * the daemon and injected into an auto-approving agent's process env, and the
 * `.mcx.yaml` layer means repo *content* can select which profile that is. The
 * interesting attacks are not "override a variable the daemon sets" — they are
 * `LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, `GIT_SSH_COMMAND` (arbitrary code in
 * the child) and `MCP_CLI_DIR` (silently reattaches the child's `mcx` to a
 * different daemon, socket, state DB and alias store). A denylist has to
 * enumerate those correctly forever; this has to enumerate only what the
 * feature is for: pointing a session at a different inference endpoint.
 *
 * `ANTHROPIC_BASE_URL` *is* allowed — redirecting the endpoint is the whole
 * point — which is why {@link parseSpawnProfileEnv} also supports unsetting an
 * inherited credential (a bare `KEY` line) so a redirected child does not carry
 * the subscription token along with it.
 */
export const SPAWN_PROFILE_ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "AWS_",
  "BEDROCK_",
  "CLAUDE_CODE_",
  "VERTEX_",
];

/** Individually allowed keys that do not fit a prefix (Vertex/Bedrock tuning). */
export const SPAWN_PROFILE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "CLOUD_ML_REGION",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "DISABLE_PROMPT_CACHING",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "MAX_THINKING_TOKENS",
]);

/** Human-readable summary of the allowlist, for error messages. */
const ALLOWED_SUMMARY = `${SPAWN_PROFILE_ALLOWED_PREFIXES.map((p) => `${p}*`).join(", ")}, ${[...SPAWN_PROFILE_ALLOWED_KEYS].sort().join(", ")}`;

/** True when `key` is a variable a profile is permitted to set or unset. */
export function isAllowedSpawnProfileKey(key: string): boolean {
  if (SPAWN_PROFILE_ALLOWED_KEYS.has(key)) return true;
  return SPAWN_PROFILE_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Validate a parsed key. Throws without ever echoing `key` when it is not a known-safe name. */
function checkKey(key: string, label: string, lineNo: number): void {
  if (!ENV_KEY_RE.test(key)) {
    // The bad "key" may be the tail of a wrapped secret — describe the rule,
    // never echo the text that failed it.
    throw new SpawnProfileError(`${label}:${lineNo}: invalid variable name (must match ${ENV_KEY_RE})`);
  }
  if (RESERVED_SPAWN_ENV_KEYS.has(key)) {
    throw new SpawnProfileError(
      `${label}:${lineNo}: "${key}" is set per-spawn by the daemon and cannot come from a profile`,
    );
  }
  if (!isAllowedSpawnProfileKey(key)) {
    // Do NOT name the key: a continuation line of a wrapped secret reaches here
    // (base64 padding makes `dGhpc2lz…=` parse as `KEY=`), and this message is
    // surfaced to the operator and to the daemon log.
    throw new SpawnProfileError(
      `${label}:${lineNo}: variable is not permitted in a profile (allowed: ${ALLOWED_SUMMARY})`,
    );
  }
}

function unescapeDoubleQuoted(inner: string): string {
  return inner.replace(/\\([nrt"\\])/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    return c;
  });
}

/**
 * Parse the value half of a `KEY=VALUE` line.
 *
 * A quoted value MUST be closed on the same line. That single rule is what
 * stops a wrapped secret from being silently split: without it,
 * `KEY="MIIEvQIB…<newline>dGhpc2lz…=` truncates the value at the newline *and*
 * promotes the continuation into a key name. Multi-line values are not
 * supported, so the honest answer is to refuse the file, not to guess.
 */
function parseValue(raw: string, label: string, lineNo: number): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    // Unquoted: an unescaped `#` preceded by whitespace opens a comment, as in
    // bash and dotenv. `PASS=abc#123` keeps its hash; `AWS_REGION=x # prod`
    // does not silently become the value "x # prod".
    return raw.replace(/\s+#.*$/, "").trimEnd();
  }
  let end = -1;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (raw[i] === quote) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new SpawnProfileError(
      `${label}:${lineNo}: unterminated ${quote === '"' ? "double" : "single"}-quoted value (a value must be closed on one line; multi-line values are not supported)`,
    );
  }
  const rest = raw.slice(end + 1).trim();
  if (rest !== "" && !rest.startsWith("#")) {
    throw new SpawnProfileError(`${label}:${lineNo}: unexpected text after the closing quote`);
  }
  const inner = raw.slice(1, end);
  return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
}

/**
 * Parse dotenv-shaped text into an env map.
 *
 * `label` is used in error messages and should be a file path — errors quote the
 * label and the 1-based line number, never the line's content (it may be a
 * secret). Later duplicate keys win, matching dotenv.
 *
 * A bare `KEY` line (no `=`) maps to `undefined`, which means UNSET: the child
 * is spawned without the variable even when the daemon's own env holds it. That
 * is not cosmetic — a daemon started from a shell holding `ANTHROPIC_API_KEY`
 * would otherwise hand a Bedrock-profiled child both credential sets and let
 * the child's internal precedence pick the winner (#935).
 */
export function parseSpawnProfileEnv(text: string, label: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === 0) {
      throw new SpawnProfileError(`${label}:${i + 1}: expected KEY=VALUE`);
    }
    if (eq < 0) {
      // Bare `KEY` — unset directive.
      const bare = body.replace(/\s+#.*$/, "").trimEnd();
      checkKey(bare, label, i + 1);
      env[bare] = undefined;
      continue;
    }
    const key = body.slice(0, eq).trimEnd();
    checkKey(key, label, i + 1);
    env[key] = parseValue(body.slice(eq + 1).trim(), label, i + 1);
  }
  return env;
}

// ── Loading ──

export interface LoadedSpawnProfile {
  name: string;
  path: string;
  /**
   * The env vars to apply. A key mapped to `undefined` is an UNSET directive —
   * the child is spawned without it even if the daemon's env holds it.
   * Never log, persist, or serialize this.
   */
  env: Record<string, string | undefined>;
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
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SpawnProfileError(`profile "${name}" is unreadable (${path}): ${code ?? "unknown error"}`);
  }
  const env = parseSpawnProfileEnv(text, path);
  if (Object.keys(env).length === 0) {
    // A `touch`, a truncated write, or a half-finished edit must not produce a
    // spawn that *claims* to be profiled and runs bare — that is the silent
    // fallback #935 exists to remove, wearing a success message.
    throw new SpawnProfileError(`profile "${name}" defines no variables (${path})`);
  }
  return { name, path, env, insecureMode: (mode & 0o077) !== 0 };
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
    .filter((n) => {
      // Stat, don't just pattern-match: a *directory* named `prod.env` would
      // otherwise be listed as available and pass the CLI's pre-check, then die
      // in loadSpawnProfile — after the daemon has already torn down a session,
      // which is precisely what that pre-check exists to avoid.
      try {
        return statSync(join(dir, `${n}${SPAWN_PROFILE_EXT}`)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Redacted view of a profile: key NAMES only, never values. Safe to print. */
export interface SpawnProfileSummary {
  name: string;
  path: string;
  /** Every variable the profile touches, set and unset alike. */
  keys: string[];
  /** The subset of `keys` the profile UNSETS (a bare `KEY` line). */
  unsets: string[];
  insecureMode: boolean;
}

/** Summarize a loaded profile for display. Drops every value by construction. */
export function describeSpawnProfile(profile: LoadedSpawnProfile): SpawnProfileSummary {
  return {
    name: profile.name,
    path: profile.path,
    keys: Object.keys(profile.env).sort(),
    unsets: Object.keys(profile.env)
      .filter((k) => profile.env[k] === undefined)
      .sort(),
    insecureMode: profile.insecureMode,
  };
}

// ── Repo manifest layer ──

/**
 * Hard cap on the ascent. The real bound is the working-tree root below; this
 * only stops a pathological symlink loop or a detached-from-git `startDir`.
 */
const MANIFEST_SEARCH_MAX_DEPTH = 16;

/**
 * Read `profile:` from the nearest `.mcx.yaml` at or above `startDir`, bounded
 * by the working-tree root.
 *
 * Two properties, both learned the hard way:
 *
 *  1. **The search stops at the repo.** `findWorktreeRootResult` is the same bound
 *     `mcx phase` uses for `.mcx.lock` and phase sources, and it is per-checkout
 *     (a linked worktree owns its own `.mcx.yaml`). Without it the search runs
 *     to `/`, so a stray `~/.mcx.yaml` would answer for every spawn on the box
 *     and a clone under `~/github/` would inherit its parent's answer. Outside a
 *     repo, only `startDir` itself is consulted.
 *  2. **The result is deselect-only.** A `.mcx.yaml` arrives by `git clone`;
 *     `null` (opt out) is honoured, a named profile is IGNORED and warned about.
 *     See `SpawnProfileSources.manifest`.
 *
 * Deliberately does not validate the whole manifest: a repo whose phase graph is
 * mid-edit must still be able to spawn. Every path that declines to contribute
 * calls `onWarn` — the layer may degrade, but not in silence.
 *
 * `resolveRoot` is injectable so tests can pin the boundary without depending on
 * a live `git rev-parse` succeeding, which it does not under host saturation.
 */
export function findManifestProfile(
  startDir: string | undefined,
  onWarn?: SpawnProfileWarn,
  resolveRoot: (dir: string) => GitRootResult = findWorktreeRootResult,
): null | undefined {
  if (!startDir) return undefined;
  let stopAt: string | null = null;
  let dir = startDir;
  try {
    // Compare against the same shape git reports: `--show-toplevel` resolves
    // symlinks, so an unresolved `startDir` would never string-match the root
    // and the ascent would sail past it.
    dir = realpathSync(startDir);
    const root = resolveRoot(dir);
    if (root.kind === "root") {
      stopAt = root.path;
    } else if (root.kind !== "not-a-repo") {
      // Git timed out or could not be spawned (this happens for real on a
      // saturated box, where fork() fails in milliseconds). We cannot tell where
      // the checkout ends, so we do not ascend — but we say so. Dropping the
      // opt-out layer silently because a subprocess failed is the same silent
      // fall-open this module exists to remove.
      onWarn?.(
        `could not determine the repo root for ${dir} (git unavailable) — the \`.mcx.yaml\` profile opt-out layer is being skipped for this spawn`,
      );
    }
  } catch {
    stopAt = null;
  }
  for (let depth = 0; depth < MANIFEST_SEARCH_MAX_DEPTH; depth++) {
    let path: string | null = null;
    try {
      path = findManifest(dir);
    } catch {
      // Unreadable directory (EACCES, ESTALE) — treat as "no manifest here".
      path = null;
    }
    if (path !== null) return readManifestProfileKey(path, onWarn);
    // Never leave the checkout: past the root, a `.mcx.yaml` belongs to some
    // other repo (or to $HOME) and has no business answering for this spawn.
    if (stopAt === null || dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Echo a repo-supplied profile name only when it is a legal one; never dump arbitrary bytes into a log. */
function safeName(value: string): string {
  return SPAWN_PROFILE_NAME_RE.test(value) ? `"${value}"` : "(not a legal profile name)";
}

function readManifestProfileKey(path: string, onWarn?: SpawnProfileWarn): null | undefined {
  let raw: unknown;
  try {
    if (lstatSync(path).size > MANIFEST_MAX_BYTES) {
      onWarn?.(`${path}: too large to read for a \`profile:\` key — the manifest profile layer is being ignored`);
      return undefined;
    }
    raw = parseManifestText(readFileSync(path, "utf-8"), path);
  } catch (err) {
    // Malformed or unreadable manifest — the manifest layer does not contribute.
    // Full validation errors surface via `mcx phase`, not here; but a tab-indent
    // slip nowhere near `profile:` must not drop the key without a word.
    onWarn?.(
      `${path}: could not be read for a \`profile:\` key (${(err as Error).message}) — the manifest profile layer is being ignored`,
    );
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    onWarn?.(`${path}: is not a mapping — the manifest profile layer is being ignored`);
    return undefined;
  }
  const value = (raw as Record<string, unknown>).profile;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    // `profile: yes` is a boolean in YAML, `profile: [x]` an array. ManifestSchema
    // would reject both; this path never applies the schema, so say so out loud
    // rather than falling through to a different profile than the file names.
    onWarn?.(
      `${path}: \`profile:\` must be a string or null (got ${Array.isArray(value) ? "a list" : typeof value}) — ignoring it`,
    );
    return undefined;
  }
  if (value.trim() === "") {
    // ManifestSchema pins `z.string().min(1)`. Treating "" as an opt-out here
    // would give two validators two answers for the key that decides which
    // account pays.
    onWarn?.(`${path}: \`profile:\` is empty — use \`profile: null\` to run with no profile; ignoring it`);
    return undefined;
  }
  onWarn?.(
    `${path}: \`profile: ${safeName(value.trim())}\` is ignored — a repo file may only opt OUT (\`profile: null\`), never select credentials. Set it with \`mcx config set default-profile <name>\` or pass \`--profile\`.`,
  );
  return undefined;
}
