/**
 * Phase `runsOn` branch guard (epic #1286, issue #1294).
 *
 * Phase execution runs with full shell + MCP access. A compromised feature
 * branch could inject phase source that executes at orchestrator time before
 * review/merge. The guard refuses to run phases from any branch other than
 * the manifest's `runsOn` (default "main").
 */

import type { ExecFn } from "./git";
import { DEFAULT_RUNS_ON, type Manifest, resolveRunsOn } from "./manifest";

export { DEFAULT_RUNS_ON };

/** Thrown when the current branch does not match the manifest's runsOn. */
export class BranchGuardError extends Error {
  constructor(
    message: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(message);
    this.name = "BranchGuardError";
  }
}

/**
 * Resolve the current branch of the repo at `cwd`. Returns the branch name,
 * or a `{ kind: "detached" | "bare" | "not-a-repo" }` describing why no
 * branch is available.
 */
export type CurrentBranch =
  | { kind: "branch"; name: string }
  | { kind: "detached" }
  | { kind: "bare" }
  | { kind: "not-a-repo" };

export function currentBranch(cwd: string, exec: ExecFn): CurrentBranch {
  const inside = exec(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0) {
    const bare = exec(["git", "-C", cwd, "rev-parse", "--is-bare-repository"]);
    if (bare.exitCode === 0 && bare.stdout.trim() === "true") {
      return { kind: "bare" };
    }
    return { kind: "not-a-repo" };
  }

  const sym = exec(["git", "-C", cwd, "symbolic-ref", "--short", "HEAD"]);
  if (sym.exitCode !== 0) {
    return { kind: "detached" };
  }
  const name = sym.stdout.trim();
  if (name === "") return { kind: "detached" };
  return { kind: "branch", name };
}

function describe(cb: CurrentBranch): string {
  switch (cb.kind) {
    case "branch":
      return `"${cb.name}"`;
    case "detached":
      return "a detached HEAD";
    case "bare":
      return "a bare repository (no working branch)";
    case "not-a-repo":
      return "a directory that is not a git repository";
  }
}

/**
 * Verify the repo at `cwd` is on the manifest's `runsOn` branch.
 * Throws `BranchGuardError` with a user-facing refusal message on mismatch.
 *
 * If `allowBranches` (from `phase.allowBranchOverride` in ~/.mcp-cli/config.json)
 * contains the current branch name, the guard is bypassed and a one-line warning
 * is returned. The list must not include the `runsOn` branch — that validation is
 * the caller's responsibility (phase.ts validates before calling here).
 */
export function checkRunsOn(opts: {
  cwd: string;
  manifest: Pick<Manifest, "runsOn">;
  exec: ExecFn;
  allowBranches?: string[];
}): { warning: string | null } {
  const expected = resolveRunsOn(opts.manifest);
  const cb = currentBranch(opts.cwd, opts.exec);

  if (cb.kind === "branch" && cb.name === expected) {
    return { warning: null };
  }

  if (cb.kind === "branch" && opts.allowBranches?.includes(cb.name)) {
    return {
      warning: `WARNING: phases running from branch "${cb.name}", not "${expected}" — install-security boundary not enforced`,
    };
  }

  const actualDesc = describe(cb);
  const actualValue = cb.kind === "branch" ? cb.name : cb.kind;
  const message = `phases only run from branch "${expected}", current branch is ${actualDesc}.\nphases execute with full shell/mcp access; running arbitrary branch code would defeat the install security boundary.`;

  throw new BranchGuardError(message, expected, actualValue);
}
