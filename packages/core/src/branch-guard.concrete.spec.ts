/**
 * Concrete (non-fake) companion to branch-guard.spec.ts.
 *
 * branch-guard.spec.ts exercises `checkRunsOn` / `currentBranch` entirely
 * through a hand-written `mockExec` — that proves the guard is *wired up*
 * to some `ExecFn`, not that it is *reachable* from a real git repository.
 * A mutation-testing run against the fake-based spec only proves the fake
 * is wired to the guard.
 *
 * This file drives the same guard against an actual `git` subprocess in a
 * throwaway temp repo (no mocks at all), so the guard-reachability harness
 * (scripts/guards/) has a genuine concrete spec to mutation-test against.
 * See #3212 and scripts/guards/README.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BranchGuardError, checkRunsOn, currentBranch } from "./branch-guard";
import type { ExecFn } from "./git";
import { spawnCaptureSync } from "./subprocess";

/** Strip GIT_* env vars that git hooks inject — prevents them from redirecting `git init`/`rev-parse`
 * at whatever repo invoked this test suite via a hook. Same guard as git.spec.ts's cleanGitEnv(). */
function cleanGitEnv(): Record<string, string | undefined> {
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_COMMON_DIR: _c,
    GIT_INDEX_FILE: _i,
    GIT_OBJECT_DIRECTORY: _o,
    ...rest
  } = process.env;
  return rest;
}

/** Real ExecFn — same shape as production's `spawnExec` (packages/command/src/commands/phase.ts). No mocks. */
const exec: ExecFn = (cmd) => {
  const [bin = "", ...rest] = cmd;
  const r = spawnCaptureSync(bin, rest, { env: cleanGitEnv() });
  return { stdout: r.stdout, exitCode: r.exitCode ?? 1 };
};

function initRepo(dir: string): void {
  spawnCaptureSync("git", ["-C", dir, "init", "-q"], { env: cleanGitEnv() });
}

function checkoutBranch(dir: string, branch: string): void {
  // Works pre-commit: HEAD is an unborn symbolic ref right after `init`, and
  // `checkout -b` renames it without requiring a commit to exist.
  spawnCaptureSync("git", ["-C", dir, "checkout", "-q", "-b", branch], { env: cleanGitEnv() });
}

describe("branch-guard against a real git repo (concrete)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "branch-guard-concrete-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("currentBranch reports the real checked-out branch", () => {
    checkoutBranch(dir, "main");
    expect(currentBranch(dir, exec)).toEqual({ kind: "branch", name: "main" });
  });

  test("checkRunsOn passes on the expected branch", () => {
    checkoutBranch(dir, "main");
    expect(() => checkRunsOn({ cwd: dir, manifest: {}, exec })).not.toThrow();
  });

  test("checkRunsOn refuses a real feature branch", () => {
    checkoutBranch(dir, "feat/real-branch");
    try {
      checkRunsOn({ cwd: dir, manifest: {}, exec });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchGuardError);
      const e = err as BranchGuardError;
      expect(e.expected).toBe("main");
      expect(e.actual).toBe("feat/real-branch");
    }
  });
});
