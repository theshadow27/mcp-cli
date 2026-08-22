/**
 * @rule staging-path-enoent-tolerant
 * @expect 3
 * @path packages/core/src/transition-store.ts
 *
 * The exact shape shipped in PR #2964 round 3: the `link`/`readFileSync` sites
 * were guarded and the `unlink` that follows each successful link, plus the
 * `rename` quarantine fallback, were not. Three violations expected — one per
 * unguarded call. This is the real defect, reduced.
 */

import { linkSync, renameSync, unlinkSync } from "node:fs";

const IMPORTING_SUFFIX = ".importing.";

declare function errnoCode(err: unknown): string | undefined;
declare function migratedPath(logPath: string): string;

export function parkStagingFile(staging: string, logPath: string): string | null {
  for (;;) {
    const dest = migratedPath(logPath);
    try {
      linkSync(staging, dest);
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOENT") return null;
      if (code === "EEXIST") continue;
      throw err;
    }
    // Unguarded: a peer that parked the same claim already dropped this name.
    unlinkSync(staging);
    return dest;
  }
}

export function quarantineStagingFile(staging: string, logPath: string): string | null {
  const dest = `${logPath}.unimportable.1`;
  try {
    linkSync(staging, dest);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT") return null;
    if (code === "EPERM") {
      // Unguarded: same race, one syscall later.
      renameSync(staging, dest);
      return dest;
    }
    throw err;
  }
  // Unguarded, and worse here — it replaces the import error that sent us
  // into the quarantine with a spurious filesystem one.
  unlinkSync(staging);
  return dest;
}

export const suffix = IMPORTING_SUFFIX;
