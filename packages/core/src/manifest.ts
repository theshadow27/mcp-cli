// dotw-todo no-import-cycles: barrel-induced intra-package cycle via core/index.ts — fix in #2486
/**
 * Project-level orchestration manifest: `.mcx.{yaml,yml,json}`.
 *
 * Parses and validates the declarative phase graph described in epic #1286.
 * This module is parse-only — no execution, no source loading. See #1287.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AutomationConfigSchema } from "./automation";

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

/**
 * Extended type pattern that also accepts `enum[val1,val2,...]` with optional `?`.
 * Used in the object-form state field declaration (#2019).
 */
export const EXTENDED_TYPE_RE = /^(string|number|boolean|enum\[[a-z0-9_]+(?:,[a-z0-9_]+)*\])\??$/;

/**
 * Object form for state field declarations (#2019). Fields with `track: true`
 * are exposed as `mcx track --<key>` CLI flags.
 */
export const StateFieldObjectSchema = z
  .object({
    type: z
      .string()
      .regex(
        EXTENDED_TYPE_RE,
        'type must be "string", "number", "boolean", or "enum[val1,val2,...]" (lowercase only), optionally suffixed with "?"',
      ),
    track: z.boolean().optional(),
    repeatable: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .refine(
    (f) => {
      if (f.default === undefined) return true;
      const optional = f.type.endsWith("?");
      const raw = optional ? f.type.slice(0, -1) : f.type;
      if (raw.startsWith("enum[")) {
        const values = raw.slice(5, -1).split(",");
        return values.includes(String(f.default));
      }
      if (raw === "number") return typeof f.default === "number" || !Number.isNaN(Number(f.default));
      if (raw === "boolean")
        return f.default === true || f.default === false || f.default === "true" || f.default === "false";
      return true;
    },
    { message: "default value does not match declared type" },
  )
  .refine(
    (f) => {
      if (!f.repeatable) return true;
      const raw = f.type.endsWith("?") ? f.type.slice(0, -1) : f.type;
      return raw === "string";
    },
    { message: "repeatable is only valid for string fields (values are stored as comma-joined strings)" },
  );

export type StateFieldObject = z.infer<typeof StateFieldObjectSchema>;

/** A state field is either a bare type string or an object with metadata. */
export type StateFieldValue = string | StateFieldObject;

/** Parsed trackable field metadata for CLI consumption. */
export interface TrackableField {
  key: string;
  baseType: "string" | "number" | "boolean" | "enum";
  optional: boolean;
  enumValues: string[] | null;
  repeatable: boolean;
  required: boolean;
  defaultValue: string | number | boolean | undefined;
}

/** Extract enum values from a type string like `enum[low,medium,high]`. */
export function parseEnumValues(typeStr: string): string[] | null {
  const m = typeStr.match(/^enum\[([^\]]+)\]\??$/);
  return m ? m[1].split(",") : null;
}

/** Parse a state field (string or object form) into base type info. */
function parseBaseType(field: StateFieldValue): { baseType: string; optional: boolean; typeStr: string } {
  const typeStr = typeof field === "string" ? field : field.type;
  const optional = typeStr.endsWith("?");
  const raw = optional ? typeStr.slice(0, -1) : typeStr;
  const baseType = raw.startsWith("enum[") ? "enum" : raw;
  return { baseType, optional, typeStr };
}

/** Extract all fields with `track: true` from a manifest state section. */
export function getTrackableFields(state: ManifestState | undefined): TrackableField[] {
  if (!state) return [];
  const fields: TrackableField[] = [];
  for (const [key, field] of Object.entries(state)) {
    if (typeof field !== "object" || !field.track) continue;
    const { baseType, optional, typeStr } = parseBaseType(field);
    fields.push({
      key,
      baseType: baseType as TrackableField["baseType"],
      optional,
      enumValues: parseEnumValues(typeStr),
      repeatable: field.repeatable ?? false,
      required: field.required ?? false,
      defaultValue: field.default,
    });
  }
  return fields;
}

/**
 * Validate a CLI-provided value against a trackable field's type.
 * Returns null on success, or an error message string.
 */
export function validateTrackValue(field: TrackableField, value: string): string | null {
  switch (field.baseType) {
    case "enum":
      if (!field.enumValues?.includes(value)) {
        return `invalid value "${value}" for ${field.key}; expected one of: ${field.enumValues?.join(", ")}`;
      }
      return null;
    case "number":
      if (value.trim() === "" || Number.isNaN(Number(value))) {
        return `invalid value "${value}" for ${field.key}; expected a number`;
      }
      return null;
    case "boolean":
      if (value !== "true" && value !== "false") {
        return `invalid value "${value}" for ${field.key}; expected "true" or "false"`;
      }
      return null;
    case "string":
      return null;
    default:
      return `unknown type "${field.baseType}" for ${field.key}`;
  }
}

/** Coerce a validated CLI string value to the appropriate JS type. */
export function coerceTrackValue(field: TrackableField, value: string): string | number | boolean {
  switch (field.baseType) {
    case "number":
      return Number(value);
    case "boolean":
      return value === "true";
    default:
      return value;
  }
}

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
 * Shared state schema declaration. Keys are identifiers; values are either
 * bare type strings (string?, number, boolean?) or object declarations with
 * extended metadata ({type, track, repeatable, default, required}).
 */
export const ManifestStateSchema = z.record(
  identifier("state key"),
  z.union([
    z.string().regex(STATE_TYPE_RE, 'state value must be "string", "number", "boolean", optionally suffixed with "?"'),
    StateFieldObjectSchema,
  ]),
);
export type ManifestState = z.infer<typeof ManifestStateSchema>;

/**
 * Top-level manifest shape.
 *
 * `version` accepts any integer ≥ 1. If `version > MANIFEST_SCHEMA_VERSION`,
 * `validateManifest` throws `ManifestVersionError` with an actionable message
 * instead of a generic Zod error.
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

/**
 * Manifest schema version this binary was compiled against. A manifest with
 * `version > MANIFEST_SCHEMA_VERSION` requires a newer binary.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export const ManifestSchema = z
  .object({
    version: z.number().int().min(1).default(MANIFEST_SCHEMA_VERSION),
    runsOn: z.string().min(1).optional(),
    worktree: ManifestWorktreeSchema.optional(),
    state: ManifestStateSchema.optional(),
    initial: identifier("initial"),
    phases: z.record(identifier("phase name"), PhaseDefSchema),
    automation: AutomationConfigSchema.optional(),
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

/** Thrown when the manifest declares a schema version the running binary doesn't support. */
export class ManifestVersionError extends ManifestError {
  constructor(
    public readonly manifestVersion: number,
    public readonly supportedVersion: number,
    path: string,
  ) {
    super(
      `manifest schema version ${manifestVersion} requires a newer mcx binary (this binary supports up to version ${supportedVersion}). To update: bun run build && mcx shutdown && mcx status`,
      path,
    );
    this.name = "ManifestVersionError";
  }
}

/**
 * Find the first matching manifest in `dir`, in preference order.
 * Returns absolute path or null.
 * Throws on non-absence errors (EACCES, EPERM, ESTALE, etc.).
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

  if (manifest.version > MANIFEST_SCHEMA_VERSION) {
    throw new ManifestVersionError(manifest.version, MANIFEST_SCHEMA_VERSION, path);
  }

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

  const RESERVED_TRACK_NAMES = new Set(["branch", "automation", "help", "phase", "json"]);
  if (manifest.state) {
    for (const [key, field] of Object.entries(manifest.state)) {
      if (typeof field === "object" && field.track) {
        if (key.includes("-")) {
          throw new ManifestError(
            `trackable state key "${key}" contains hyphens; use underscores instead (CLI flags normalize --${key} to "${key.replace(/-/g, "_")}", making this field unreachable)`,
            path,
          );
        }
        if (RESERVED_TRACK_NAMES.has(key)) {
          throw new ManifestError(
            `trackable state key "${key}" conflicts with built-in CLI flag --${key}; choose a different name`,
            path,
          );
        }
      }
    }
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
 * Load and validate a manifest from an absolute file path, bypassing
 * `findManifest`. Returns null if the file doesn't exist (including the
 * lstat ENOENT race: file disappears between discovery and stat).
 * Throws ManifestError on size, parse, or validation failure.
 */
export function loadManifestFromPath(path: string): { path: string; manifest: Manifest } | null {
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

/**
 * Load and validate a manifest from `dir`. Returns null if no manifest file
 * exists. Throws ManifestError on parse, size, or validation failure.
 */
export function loadManifest(dir: string): { path: string; manifest: Manifest } | null {
  const path = findManifest(dir);
  if (path === null) return null;
  return loadManifestFromPath(path);
}
