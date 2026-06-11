/**
 * `.mcx.lock` — install-time lockfile for the phase manifest.
 *
 * Written by `mcx phase install` (#1291). Consumed by drift detection
 * (#1292) and runtime phase dispatch. Committed to the repo — it is
 * authoritative over the manifest at run time.
 *
 * Format v1: JSON, keys sorted (deterministic), LF line endings.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const LOCKFILE_NAME = ".mcx.lock";
export const LOCKFILE_VERSION = 1;

export const LockedPhaseSchema = z
  .object({
    /** Phase name from manifest. */
    name: z.string(),
    /** Path relative to the repo root, forward slashes. */
    resolvedPath: z.string(),
    /** sha256 of the transitive local-import closure (hex); see hashImportClosureSync. */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** sha256 of the extracted output-schema JSON, or empty string if none. */
    schemaHash: z.string().regex(/^([a-f0-9]{64}|)$/),
  })
  .strict();
export type LockedPhase = z.infer<typeof LockedPhaseSchema>;

export const LockedAutomationSchema = z
  .object({
    name: z.string(),
    resolvedPath: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    events: z.array(z.string()),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LockedAutomation = z.infer<typeof LockedAutomationSchema>;

export const LockfileSchema = z
  .object({
    version: z.literal(LOCKFILE_VERSION),
    /** sha256 of the raw manifest file contents (hex). */
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Phases, sorted alphabetically by name. */
    phases: z.array(LockedPhaseSchema),
    /** Automation modules, sorted alphabetically by name. Optional for backward compat. */
    automations: z.array(LockedAutomationSchema).optional(),
  })
  .strict();
export type Lockfile = z.infer<typeof LockfileSchema>;

/** Compute the sha256 hex hash of a utf-8 string. */
export function sha256Hex(input: string | Uint8Array | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input as Parameters<Bun.CryptoHasher["update"]>[0]);
  return hasher.digest("hex");
}

/** Compute the sha256 of a file's contents. */
export function hashFileSync(path: string): string {
  return sha256Hex(readFileSync(path));
}

// Extension probe order for resolving a relative import to a file. Empty string
// first so an already-suffixed specifier (`./x.ts`, `./data.json`) wins as-is.
const CLOSURE_RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const CLOSURE_INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

function closureLoaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  switch (extname(path)) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    default:
      return "ts";
  }
}

/**
 * Resolve a single import specifier to an on-disk file, or null when it is a
 * bare/package specifier (npm, "mcp-cli", "@mcp-cli/core") — those are
 * externalized by the bundler and must NOT be followed into the closure.
 */
function resolveLocalImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".") && !isAbsolute(spec)) return null;
  const base = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
  for (const ext of CLOSURE_RESOLVE_EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const idx of CLOSURE_INDEX_FILES) {
    const candidate = resolve(base, idx);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Hash the transitive *local-import* closure of a phase/automation entry file.
 *
 * `bundleAlias` externalizes "mcp-cli" and "@mcp-cli/core", so only relative
 * imports (siblings like `review-fn.ts`) actually land in the effective
 * bundle. This walks that same set and returns a sha256 over the sorted map of
 * {repo-relative path → file sha256}. Editing any sibling therefore changes
 * the hash — closing the gap where a hash over the entry file alone missed
 * transitive edits (#2656).
 *
 * Synchronous (uses Bun.Transpiler.scanImports) so the drift guard stays sync.
 * Throws if the entry file is unreadable — callers map ENOENT to a
 * "file missing" drift, matching the prior `hashFileSync` behavior. Resolved
 * imports are existence-checked before queueing, so a deleted sibling is simply
 * excluded rather than throwing.
 */
export function hashImportClosureSync(entryPath: string, repoRoot: string): string {
  const contentByPath = new Map<string, string>();
  const entryAbs = resolve(entryPath);
  const stack = [entryAbs];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (contentByPath.has(file)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch (err) {
      // The entry file must exist — callers map its ENOENT to a "file missing"
      // drift. A *sibling* that vanished between resolve-time and now is simply
      // excluded, matching the resolve-time existence check.
      if (file === entryAbs) throw err;
      continue;
    }
    contentByPath.set(file, sha256Hex(buf));
    let imports: { path: string }[];
    try {
      imports = new Bun.Transpiler({ loader: closureLoaderFor(file) }).scanImports(buf.toString("utf-8"));
    } catch {
      continue; // unparseable file — its own content hash is still captured
    }
    for (const imp of imports) {
      const resolved = resolveLocalImport(imp.path, file);
      if (resolved && !contentByPath.has(resolved)) stack.push(resolved);
    }
  }
  const rel: Record<string, string> = {};
  for (const [abs, hash] of contentByPath) {
    rel[relative(repoRoot, abs).split("\\").join("/")] = hash;
  }
  return sha256Hex(canonicalJson(rel));
}

/** Deterministic JSON.stringify with sorted object keys (recursive). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) sorted[k] = o[k];
      return sorted;
    }
    return v;
  });
}

/** Serialize a lockfile to its on-disk string form (trailing newline). */
export function serializeLockfile(lock: Lockfile): string {
  const sorted: Lockfile = {
    ...lock,
    phases: [...lock.phases].sort((a, b) => a.name.localeCompare(b.name)),
    ...(lock.automations && {
      automations: [...lock.automations].sort((a, b) => a.name.localeCompare(b.name)),
    }),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Parse a lockfile string; throws on structural issues. */
export function parseLockfile(text: string): Lockfile {
  const raw = JSON.parse(text) as unknown;
  return LockfileSchema.parse(raw);
}
