/**
 * @rule staging-path-enoent-tolerant
 * @expect 0
 * @path packages/core/src/transition-store.ts
 *
 * The repaired shape. Every call naming a staging path sits inside a try whose
 * catch branches on ENOENT — either directly, or by delegating to a helper that
 * does. Also pins the two ways this rule must NOT fire: a guarded call reached
 * through a shared enclosing try, and an fs call on a path that is not a
 * staging path at all.
 */

import { linkSync, readFileSync, renameSync, unlinkSync } from "node:fs";

const IMPORTING_SUFFIX = ".importing.";

declare function errnoCode(err: unknown): string | undefined;
declare function migratedPath(logPath: string): string;

function unlinkQuietly(staging: string): void {
  try {
    unlinkSync(staging);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

export function importStagingFile(staging: string): Buffer | null {
  try {
    return readFileSync(staging);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

export function parkStagingFile(staging: string, logPath: string): string | null {
  const dest = migratedPath(logPath);
  try {
    linkSync(staging, dest);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
  unlinkQuietly(staging);
  return dest;
}

export function quarantineStagingFile(staging: string, logPath: string): string | null {
  const dest = `${logPath}.unimportable.1`;
  try {
    linkSync(staging, dest);
  } catch (err) {
    if (errnoCode(err) === "EPERM") {
      try {
        renameSync(staging, dest);
      } catch (renameErr) {
        if (errnoCode(renameErr) === "ENOENT") return null;
        throw renameErr;
      }
      return dest;
    }
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
  unlinkQuietly(staging);
  return dest;
}

/** A shared enclosing try is enough — the guard need not be innermost. */
export function reclaimAll(staging: string, logPath: string): void {
  try {
    linkSync(staging, `${logPath}.a`);
    unlinkSync(staging);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

/** Not a staging path, so not this rule's business even though it can ENOENT. */
export function readManifest(manifestPath: string): Buffer {
  return readFileSync(manifestPath);
}

export const suffix = IMPORTING_SUFFIX;
