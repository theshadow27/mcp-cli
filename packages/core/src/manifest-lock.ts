/**
 * `.mcx.lock` — install-time lockfile for the phase manifest.
 *
 * Written by `mcx phase install` (#1291). Consumed by drift detection
 * (#1292) and runtime phase dispatch. Committed to the repo — it is
 * authoritative over the manifest at run time.
 *
 * Format v1: JSON, keys sorted (deterministic), LF line endings.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const LOCKFILE_NAME = ".mcx.lock";
export const LOCKFILE_VERSION = 1;

export const LockedPhaseSchema = z
  .object({
    /** Phase name from manifest. */
    name: z.string(),
    /** Path relative to the repo root, forward slashes. */
    resolvedPath: z.string(),
    /** sha256 of the source file contents (hex). */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** sha256 of the extracted output-schema JSON, or empty string if none. */
    schemaHash: z.string().regex(/^([a-f0-9]{64}|)$/),
  })
  .strict();
export type LockedPhase = z.infer<typeof LockedPhaseSchema>;

export const LockfileSchema = z
  .object({
    version: z.literal(LOCKFILE_VERSION),
    /** sha256 of the raw manifest file contents (hex). */
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Phases, sorted alphabetically by name. */
    phases: z.array(LockedPhaseSchema),
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
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Parse a lockfile string; throws on structural issues. */
export function parseLockfile(text: string): Lockfile {
  const raw = JSON.parse(text) as unknown;
  return LockfileSchema.parse(raw);
}
