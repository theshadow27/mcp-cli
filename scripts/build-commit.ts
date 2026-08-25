/**
 * Build-time source provenance (#3264).
 *
 * The `+epoch` stamp in BUILD_VERSION says *when* a binary was compiled, never
 * *what* it was compiled from — so a build from a stale checkout/worktree looks
 * newer than a fix that it does not actually contain. Resolving the HEAD commit
 * (plus a dirty-tree flag) at build time gives every binary an answer to
 * "does this contain commit X".
 */

export interface CommitExecResult {
  exitCode: number;
  stdout: string;
}

export type CommitExec = (cmd: string[]) => CommitExecResult;

/** Short SHA length — matches the protocol-hash prefix width used elsewhere. */
const SHA_LENGTH = 12;

function spawnGit(cmd: string[]): CommitExecResult {
  const [bin, ...args] = cmd;
  if (!bin) return { exitCode: 1, stdout: "" };
  const proc = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "ignore" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

/**
 * Resolve the source commit for the current build, or null when git can't
 * answer (tarball build, no git on PATH, not a repo) — in which case the build
 * simply omits the define and the binary reports no commit.
 *
 * Returns `<sha12>` for a clean tree, `<sha12>-dirty` for uncommitted changes,
 * and `<sha12>-unknown` when the dirty probe itself failed: an unverifiable
 * "clean" is exactly the false confidence this stamp exists to remove.
 */
export function resolveBuildCommit(exec: CommitExec = spawnGit): string | null {
  const head = exec(["git", "rev-parse", "HEAD"]);
  if (head.exitCode !== 0) return null;
  const sha = head.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const short = sha.slice(0, SHA_LENGTH);

  const status = exec(["git", "status", "--porcelain"]);
  if (status.exitCode !== 0) return `${short}-unknown`;
  return status.stdout.trim().length > 0 ? `${short}-dirty` : short;
}
