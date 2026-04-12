/**
 * Project-level orchestration manifest: `.mcx.{yaml,yml,json}`.
 *
 * Parses and validates the declarative phase graph described in epic #1286.
 * This module is parse-only — no execution, no source loading. See #1287.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Recognized manifest filenames, in load-preference order. */
export const MANIFEST_FILENAMES = [".mcx.yaml", ".mcx.yml", ".mcx.json"] as const;
export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number];

/** A single phase definition. */
export const PhaseDefSchema = z
  .object({
    /** URI/path to the phase source. Stored as-is; parsing deferred to #1296. */
    source: z.string().min(1, "phase.source must be a non-empty string"),
    /** Names of phases reachable from this phase. Defaults to []. */
    next: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PhaseDef = z.infer<typeof PhaseDefSchema>;

/** Worktree setup subsection. Future home of .mcx-worktree.json contents. */
export const ManifestWorktreeSchema = z
  .object({
    setup: z.array(z.string()).optional(),
  })
  .strict();

export type ManifestWorktree = z.infer<typeof ManifestWorktreeSchema>;

/**
 * Shared state schema declaration. Values are type strings like
 * "number", "string", or "string?" (trailing `?` marks optional).
 *
 * Execution-time Zod conversion is deferred; see epic #1286.
 */
export const ManifestStateSchema = z.record(z.string(), z.string());
export type ManifestState = z.infer<typeof ManifestStateSchema>;

/** Top-level manifest shape. */
export const ManifestSchema = z
  .object({
    runsOn: z.string().min(1).default("main"),
    worktree: ManifestWorktreeSchema.optional(),
    state: ManifestStateSchema.optional(),
    initial: z.string().min(1),
    phases: z.record(z.string().min(1), PhaseDefSchema),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

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
 * Returns absolute path or null.
 */
export function findManifest(dir: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse manifest content by filename extension.
 * .yaml/.yml → Bun.YAML.parse; .json → JSON.parse.
 */
export function parseManifestText(text: string, filename: string): unknown {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(text);
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return Bun.YAML.parse(text);
  }
  throw new Error(`unsupported manifest extension: ${filename}`);
}

/**
 * Validate structure then cross-reference phase names. Throws ManifestError
 * with actionable messages on the first problem encountered.
 */
export function validateManifest(raw: unknown, path: string): Manifest {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.length > 0 ? first.path.join(".") : "(root)";
    throw new ManifestError(`${where}: ${first.message}`, path);
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

  return manifest;
}

/**
 * Load and validate a manifest from `dir`. Returns null if no manifest file
 * exists. Throws ManifestError on parse or validation failure.
 */
export function loadManifest(dir: string): { path: string; manifest: Manifest } | null {
  const path = findManifest(dir);
  if (path === null) return null;

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
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
