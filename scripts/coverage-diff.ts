import { type SpawnSyncReturns, spawnSync } from "node:child_process";

export type GitRunner = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;

const defaultGit: GitRunner = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

/**
 * Coverage paths from Bun's table use relative paths (e.g. "packages/core/src/config.ts")
 * while git diff returns repo-root-relative paths. They usually match exactly, but
 * we also handle suffix matches for resilience.
 */
export function coveragePathInDiff(coveragePath: string, changed: Set<string> | null): boolean {
  if (!changed) return true;
  for (const f of changed) {
    if (f === coveragePath || f.endsWith(`/${coveragePath}`) || coveragePath.endsWith(`/${f}`)) return true;
  }
  return false;
}

/**
 * Resolve files changed in the current branch vs main.
 * Returns null when on main or when git state can't be determined (full enforcement).
 * Returns a Set of relative paths when diff-scoping is possible.
 */
export function resolveChangedSourceFiles(git: GitRunner = defaultGit): Set<string> | null {
  const branch = git("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0) return null;
  const branchName = branch.stdout.trim();
  if (branchName === "main" || branchName === "master" || branchName === "HEAD") return null;

  for (const ref of ["origin/main", "main"]) {
    const mb = git("git", ["merge-base", ref, "HEAD"]);
    if (mb.status !== 0 || !mb.stdout.trim()) continue;

    const base = mb.stdout.trim();
    const committed = git("git", ["diff", "--name-only", base, "HEAD"]);
    if (committed.status !== 0) continue;

    const uncommitted = git("git", ["diff", "--name-only", "HEAD"]);

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
