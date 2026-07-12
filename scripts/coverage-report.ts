/**
 * Pure helpers for check-coverage.ts reporting + defense-in-depth (#2815).
 *
 * check-coverage.ts is a top-level side-effect script (it runs the coverage
 * pass on import), so the testable logic lives here where a spec can import it
 * without triggering a real test run.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

import { RAN_FILES_RE } from "./bun-summary";

/** Re-exported from ./bun-summary — the single source of truth (#2883). */
export { RAN_FILES_RE };

/** Parse the discovered spec-file count from `bun test` stdout. null when absent. */
export function parseDiscoveredFileCount(output: string): number | null {
  const m = output.match(RAN_FILES_RE);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Count *.spec.ts / *.spec.tsx files discoverable under the given run paths.
 * Directory paths are scanned recursively; explicit spec-file paths count as 1.
 * Non-spec file paths and missing paths are ignored. This mirrors the set of
 * files `bun test <paths>` will discover so the floor compares files-to-files.
 */
export function countExpectedSpecFiles(paths: string[], rootDir: string): number {
  const glob = new Glob("**/*.spec.{ts,tsx}");
  const seen = new Set<string>();
  for (const p of paths) {
    const abs = resolve(rootDir, p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const rel of glob.scanSync({ cwd: abs })) seen.add(resolve(abs, rel));
    } else if (p.endsWith(".spec.ts") || p.endsWith(".spec.tsx")) {
      seen.add(abs);
    }
  }
  return seen.size;
}

export interface SpecFloorResult {
  ok: boolean;
  discovered: number | null;
  expected: number;
  reason?: string;
}

/**
 * Spec-count sanity floor (#2815). The #1125 fast-path skips run-2 (daemon) and
 * re-includes files manually, so a silent drop in discovered specs — a glob
 * regression, bun-upgrade path-arg skew, or a spec that self-skips at import —
 * would recompute the per-file floor against fewer source files and still print
 * PASS. Fail closed when the run discovers fewer spec files than exist on disk.
 * Mirrors the #2719 phases discovery floor (files vs files — exact, and the
 * comparison is one-sided so extra discovered files never false-fail).
 */
export function checkSpecCountFloor(output: string, expected: number): SpecFloorResult {
  const discovered = parseDiscoveredFileCount(output);
  if (discovered === null) {
    return {
      ok: false,
      discovered,
      expected,
      reason:
        'could not parse the "Ran N tests across M files" summary from coverage output — failing closed (bun output format changed?) (#2815)',
    };
  }
  if (discovered < expected) {
    return {
      ok: false,
      discovered,
      expected,
      reason: `coverage run discovered ${discovered} spec file(s), expected >= ${expected} — a glob regression, bun path-arg skew, or a self-skipping spec silently shrank the coverage surface (#2815)`,
    };
  }
  return { ok: true, discovered, expected };
}

/** Itemize active per-file exclusions (path — reason) for transparent output (#2815). */
export function formatExclusionList(exclusions: Record<string, string>): string[] {
  return Object.entries(exclusions).map(([path, reason]) => `  ${path} — ${reason}`);
}

/**
 * Hard-error output for a degraded coverage run (#2759). When the spec-count
 * floor trips, the per-file and global coverage numbers were computed from a
 * partial file set — a worker was silently SIGTERM'd under host oversubscription
 * (#2690), or a glob/path regression shrank the surface. The low-coverage files
 * such a run flags (e.g. reporter.ts, opencode-client.ts) are an artifact of the
 * missing files, not a real regression, so callers must suppress the per-file
 * failure listing and re-run rather than chase unrelated files.
 */
export function formatDegradedRunError(result: SpecFloorResult): string[] {
  return [
    `\nFAIL: ${result.reason}`,
    `\nSuspected worker crash — spec file count mismatch (${result.discovered ?? "?"} discovered < ${result.expected} expected).`,
    "Per-file and global coverage results are unreliable and have been suppressed.",
    "Re-run `bun run am-i-done` (#2759).",
  ];
}
