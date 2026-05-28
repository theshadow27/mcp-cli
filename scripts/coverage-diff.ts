import { spawnSync } from "node:child_process";

/**
 * Coverage paths from Bun's table use relative paths (e.g. "packages/core/src/config.ts")
 * while git diff returns repo-root-relative paths. They usually match exactly, but
 * we also handle suffix matches for resilience.
 */
export function coveragePathInDiff(coveragePath: string, changed: Set<string> | null): boolean {
  if (!changed) return true;
  for (const f of changed) {
    if (f === coveragePath || f.endsWith(`/${coveragePath}`) || coveragePath.endsWith(f)) return true;
  }
  return false;
}

/**
 * Resolve files changed in the current branch vs main.
 * Returns null when on main or when git state can't be determined (full enforcement).
 * Returns a Set of relative paths when diff-scoping is possible.
 */
export function resolveChangedSourceFiles(): Set<string> | null {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  if (branch.status !== 0) return null;
  const branchName = branch.stdout.trim();
  if (branchName === "main" || branchName === "master") return null;

  for (const ref of ["origin/main", "main"]) {
    const mb = spawnSync("git", ["merge-base", ref, "HEAD"], { encoding: "utf8" });
    if (mb.status !== 0 || !mb.stdout.trim()) continue;

    const base = mb.stdout.trim();
    const committed = spawnSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" });
    if (committed.status !== 0) continue;

    const uncommitted = spawnSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" });

    const files = new Set(
      [committed.stdout, uncommitted.status === 0 ? uncommitted.stdout : ""]
        .join("\n")
        .trim()
        .split("\n")
        .filter((f) => f.length > 0),
    );
    return files;
  }
  return null;
}
