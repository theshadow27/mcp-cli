/**
 * Project-level orchestration manifest: `.mcx.{yaml,yml,json}`.
 *
 * Parses and validates the declarative phase graph described in epic #1286.
 * This module is parse-only — no execution, no source loading. See #1287.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Recognized manifest filenames, in load-preference order. */
export const MANIFEST_FILENAMES = [".mcx.yaml", ".mcx.yml", ".mcx.json"] as const;
export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number];

/** Max manifest file size. Guards against FIFOs, /dev/zero, runaway files. */
export const MANIFEST_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Phase/state identifier grammar. Lowercase ASCII, digits, `_`, `-`, starting
 * with a letter. These names flow into filesystem paths, CLI dispatch keys,
 * and SQLite columns — keep them boring and portable.
 */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const identifier = (role: string) =>
  z.string().regex(IDENTIFIER_RE, `${role} must match ${IDENTIFIER_RE} (lowercase letter + [a-z0-9_-], ≤64 chars)`);

/**
 * State value type DSL. Currently: `string`, `number`, `boolean`, each
 * optionally suffixed with `?` to mark optional. Enforced here so downstream
 * sub-issues (#1290, #1291, #1293) share one grammar.
 */
export const STATE_TYPE_RE = /^(string|number|boolean)\??$/;

/** A single phase definition. */
export const PhaseDefSchema = z
  .object({
    /** URI/path to the phase source. Stored as-is; parsing deferred to #1296. */
    source: z.string().min(1, "phase.source must be a non-empty string"),
    /** Names of phases reachable from this phase. Defaults to []. */
    next: z.array(identifier("phase.next[]")).default([]),
  })
  .strict();

export type PhaseDef = z.infer<typeof PhaseDefSchema>;

/**
 * Worktree setup subsection. Mirrors `.mcx-worktree.json` `worktree:` contents.
 * See #1288 for the migration that populates this from the legacy JSON file.
 *
 * `setup`/`teardown`/`base` accept the legacy array-of-strings form (coerced to
 * the first element) for compatibility with any manifests written before #1288
 * changed the placeholder schema from `z.array(z.string())` to `z.string()`.
 */
const coerceToString = (field: string) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? (v[0] ?? "") : v),
    z.string({ error: `${field} must be a string` }).optional(),
  );

export const ManifestWorktreeSchema = z
  .object({
    setup: coerceToString("setup"),
    teardown: coerceToString("teardown"),
    base: coerceToString("base"),
    branchPrefix: z.boolean().optional(),
  })
  .strict();

export type ManifestWorktree = z.infer<typeof ManifestWorktreeSchema>;

/**
 * Shared state schema declaration. Keys are identifiers; values are type
 * strings from STATE_TYPE_RE. Execution-time Zod conversion is deferred; see
 * epic #1286.
 */
export const ManifestStateSchema = z.record(
  identifier("state key"),
  z.string().regex(STATE_TYPE_RE, 'state value must be "string", "number", "boolean", optionally suffixed with "?"'),
);
export type ManifestState = z.infer<typeof ManifestStateSchema>;

/**
 * Top-level manifest shape.
 *
 * `version` is a literal discriminator so a newer manifest against an older
 * `mcx` binary fails with a clear error instead of a generic "unknown key".
 *
 * The phase graph may contain cycles (e.g. review → repair → review); cycles
 * are intentional and part of the design. Only unreachable phases are
 * rejected.
 */
/**
 * Default branch for `runsOn` when a manifest omits it. Canonical constant
 * for all consumers — do not write `manifest.runsOn ?? "main"` inline.
 * See #1318.
 */
export const DEFAULT_RUNS_ON = "main";

export const ManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    runsOn: z.string().min(1).optional(),
    worktree: ManifestWorktreeSchema.optional(),
    state: ManifestStateSchema.optional(),
    initial: identifier("initial"),
    phases: z.record(identifier("phase name"), PhaseDefSchema),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

/** Resolve a manifest's `runsOn` to a concrete branch name, applying the default. */
export function resolveRunsOn(manifest: Pick<Manifest, "runsOn">): string {
  return manifest.runsOn ?? DEFAULT_RUNS_ON;
}

/** Error thrown when a manifest fails structural or semantic validation. */
export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * Find the first matching manifest in `dir`, in preference order.
 * Returns absolute path or null. Does not stat — callers handle ENOENT.
 */
export function findManifest(dir: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile()) return p;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
  }
  return null;
}

/**
 * Parse manifest content by filename extension.
 * .yaml/.yml → Bun.YAML.parse; .json → JSON.parse.
 */
export function parseManifestText(text: string, fileOrPath: string): unknown {
  const lower = fileOrPath.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(text);
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return Bun.YAML.parse(text);
  }
  throw new Error(`unsupported manifest extension: ${fileOrPath}`);
}

/**
 * Validate structure then cross-reference phase names. Throws ManifestError
 * with *all* structural problems reported, then cross-reference checks run
 * sequentially.
 */
export function validateManifest(raw: unknown, path: string): Manifest {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("manifest file is empty or not a YAML/JSON object", path);
  }

  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const where = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  ${where}: ${i.message}`;
    });
    throw new ManifestError(`manifest validation failed:\n${lines.join("\n")}`, path);
  }
  const manifest = result.data;

  const declared = new Set(Object.keys(manifest.phases));
  if (declared.size === 0) {
    throw new ManifestError("phases: must declare at least one phase", path);
  }

  if (!declared.has(manifest.initial)) {
    throw new ManifestError(
      `initial: "${manifest.initial}" is not a declared phase (declared: ${[...declared].join(", ")})`,
      path,
    );
  }

  for (const [name, phase] of Object.entries(manifest.phases)) {
    for (const target of phase.next) {
      if (!declared.has(target)) {
        throw new ManifestError(`unknown phase "${target}" referenced in next: of "${name}"`, path);
      }
    }
  }

  const reachable = new Set<string>();
  const queue: string[] = [manifest.initial];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const phase = manifest.phases[cur];
    if (phase) queue.push(...phase.next);
  }
  const unreachable = [...declared].filter((n) => !reachable.has(n));
  if (unreachable.length > 0) {
    throw new ManifestError(
      `unreachable phase${unreachable.length > 1 ? "s" : ""} from initial "${manifest.initial}": ${unreachable.join(", ")}`,
      path,
    );
  }

  return manifest;
}

/**
 * Detect all cycles in the phase graph using DFS back-edge detection.
 * Returns each cycle as a closed path array: `[a, b, ..., a]` where the
 * last element repeats the first. A manifest with no cycles returns `[]`.
 *
 * Cycles are intentional in many sprint manifests (e.g. review → repair →
 * review). This function lets callers inspect or report them without
 * treating them as errors.
 */
export function detectCycles(manifest: Manifest): string[][] {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]): void {
    visited.add(node);
    onStack.add(node);
    stack.push(node);

    for (const next of manifest.phases[node]?.next ?? []) {
      if (!visited.has(next)) {
        dfs(next, stack);
      } else if (onStack.has(next)) {
        const cycleStart = stack.indexOf(next);
        cycles.push([...stack.slice(cycleStart), next]);
      }
    }

    stack.pop();
    onStack.delete(node);
  }

  for (const phase of Object.keys(manifest.phases)) {
    if (!visited.has(phase)) {
      dfs(phase, []);
    }
  }

  return cycles;
}

/**
 * Returns true if the given phase is part of at least one cycle (i.e., it
 * can reach itself, whether directly via a self-loop or through other phases).
 */
export function isPhaseInCycle(manifest: Manifest, phase: string): boolean {
  const neighbors = manifest.phases[phase]?.next ?? [];
  const queue = [...neighbors];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    if (node === phase) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of manifest.phases[node]?.next ?? []) {
      queue.push(next);
    }
  }
  return false;
}

/**
 * Load and validate a manifest from `dir`. Returns null if no manifest file
 * exists. Throws ManifestError on parse, size, or validation failure.
 */
export function loadManifest(dir: string): { path: string; manifest: Manifest } | null {
  const path = findManifest(dir);
  if (path === null) return null;

  try {
    const st = lstatSync(path);
    if (!st.isFile()) {
      throw new ManifestError("not a regular file (symlink, FIFO, or special)", path);
    }
    if (st.size > MANIFEST_MAX_BYTES) {
      throw new ManifestError(`manifest is too large (${st.size} bytes, max ${MANIFEST_MAX_BYTES})`, path);
    }
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new ManifestError(`failed to stat: ${err instanceof Error ? err.message : String(err)}`, path);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return null;
    throw new ManifestError(`failed to read: ${err instanceof Error ? err.message : String(err)}`, path);
  }

  let raw: unknown;
  try {
    raw = parseManifestText(text, path);
  } catch (err) {
    throw new ManifestError(`parse error: ${err instanceof Error ? err.message : String(err)}`, path);
  }

  const manifest = validateManifest(raw, path);
  return { path, manifest };
}
