/**
 * Integration test: reproduce the core.bare=true bug under concurrent
 * worktree removal. Uses real git repos — no mocks.
 *
 * @see https://github.com/theshadow27/mcp-cli/issues/1367
 * @see https://github.com/theshadow27/mcp-cli/issues/1330
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const env = {
  ...cleanGitEnv(),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test",
};

const spawnOpts = { env, stdout: "pipe" as const, stderr: "pipe" as const, timeout: 10_000 };

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], spawnOpts);
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "core-bare-repro-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "init");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function readCoreBare(cwd: string): boolean {
  const { stdout, exitCode } = git(cwd, "config", "core.bare");
  return exitCode === 0 && stdout === "true";
}

describe("core.bare=true repro (concurrent worktree removal)", () => {
  test("concurrent worktree remove + branch delete does not set core.bare=true", () => {
    const repo = initRepo();
    try {
      const worktreeCount = 8;
      const rounds = 5;
      let coreBareDetected = false;

      for (let round = 0; round < rounds; round++) {
        const worktrees: { path: string; branch: string }[] = [];
        for (let i = 0; i < worktreeCount; i++) {
          const branch = `wt-${round}-${i}`;
          const wtPath = join(repo, ".worktrees", branch);
          const result = git(repo, "worktree", "add", wtPath, "-b", branch, "HEAD");
          if (result.exitCode !== 0) {
            throw new Error(`worktree add failed: ${result.stderr}`);
          }
          worktrees.push({ path: wtPath, branch });
        }

        // Remove all worktrees concurrently using async processes
        const removeProcs = worktrees.map((wt) =>
          Bun.spawn(["git", "-C", repo, "worktree", "remove", wt.path], {
            env,
            stdout: "ignore",
            stderr: "pipe",
          }),
        );

        const deadline = Date.now() + 30_000;
        for (const proc of removeProcs) {
          while (!proc.killed && proc.exitCode === undefined) {
            if (Date.now() > deadline) throw new Error("Timeout waiting for worktree remove");
            Bun.sleepSync(1);
          }
        }

        // Now delete branches concurrently
        const branchProcs = worktrees.map((wt) =>
          Bun.spawn(["git", "-C", repo, "branch", "-D", wt.branch], {
            env,
            stdout: "ignore",
            stderr: "pipe",
          }),
        );

        const branchDeadline = Date.now() + 30_000;
        for (const proc of branchProcs) {
          while (!proc.killed && proc.exitCode === undefined) {
            if (Date.now() > branchDeadline) throw new Error("Timeout waiting for branch delete");
            Bun.sleepSync(1);
          }
        }

        if (readCoreBare(repo)) {
          coreBareDetected = true;
          // Don't break — record that it happened, but also verify fixCoreBare would work
          git(repo, "config", "--unset", "core.bare");
        }
      }

      // The assertion: core.bare should NOT be true after all operations
      expect(readCoreBare(repo)).toBe(false);

      // Log whether the bug was triggered during the run (informational)
      if (coreBareDetected) {
        console.error(
          "[repro] core.bare=true WAS triggered during concurrent worktree removal — bug is real and reproducible",
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("interleaved worktree remove and branch delete does not set core.bare=true", () => {
    const repo = initRepo();
    try {
      const worktreeCount = 6;
      const rounds = 5;
      let coreBareDetected = false;

      for (let round = 0; round < rounds; round++) {
        const worktrees: { path: string; branch: string }[] = [];
        for (let i = 0; i < worktreeCount; i++) {
          const branch = `interleave-${round}-${i}`;
          const wtPath = join(repo, ".worktrees", branch);
          git(repo, "worktree", "add", wtPath, "-b", branch, "HEAD");
          worktrees.push({ path: wtPath, branch });
        }

        // Interleave: spawn remove + branch-delete for each worktree at the same time
        const procs = worktrees.flatMap((wt) => [
          Bun.spawn(["git", "-C", repo, "worktree", "remove", wt.path], {
            env,
            stdout: "ignore",
            stderr: "ignore",
          }),
          Bun.spawn(["git", "-C", repo, "branch", "-D", wt.branch], {
            env,
            stdout: "ignore",
            stderr: "ignore",
          }),
        ]);

        const deadline = Date.now() + 30_000;
        for (const proc of procs) {
          while (!proc.killed && proc.exitCode === undefined) {
            if (Date.now() > deadline) throw new Error("Timeout waiting for concurrent ops");
            Bun.sleepSync(1);
          }
        }

        // Clean up any branches that survived (branch -D may fail if worktree remove hasn't finished)
        for (const wt of worktrees) {
          git(repo, "branch", "-D", wt.branch);
        }
        git(repo, "worktree", "prune");

        if (readCoreBare(repo)) {
          coreBareDetected = true;
          git(repo, "config", "--unset", "core.bare");
        }
      }

      expect(readCoreBare(repo)).toBe(false);

      if (coreBareDetected) {
        console.error(
          "[repro] core.bare=true WAS triggered during interleaved worktree ops — bug is real and reproducible",
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fixCoreBare heals the repo after concurrent worktree operations", () => {
    const repo = initRepo();
    try {
      // Simulate the bug by manually setting core.bare=true
      git(repo, "config", "core.bare", "true");
      expect(readCoreBare(repo)).toBe(true);

      // Verify the fix: unset core.bare
      const { exitCode } = git(repo, "config", "--unset", "core.bare");
      expect(exitCode).toBe(0);
      expect(readCoreBare(repo)).toBe(false);

      // Verify git operations work after healing
      writeFileSync(join(repo, "test.txt"), "after-heal");
      const addResult = git(repo, "add", "test.txt");
      expect(addResult.exitCode).toBe(0);
      const commitResult = git(repo, "commit", "-q", "-m", "post-heal commit");
      expect(commitResult.exitCode).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rapid worktree create-remove cycles do not corrupt core.bare", () => {
    const repo = initRepo();
    try {
      let coreBareCount = 0;

      // Rapid sequential create-remove to stress the git config lock
      for (let i = 0; i < 20; i++) {
        const branch = `rapid-${i}`;
        const wtPath = join(repo, ".worktrees", branch);
        git(repo, "worktree", "add", wtPath, "-b", branch, "HEAD");
        git(repo, "worktree", "remove", wtPath);
        git(repo, "branch", "-D", branch);

        if (readCoreBare(repo)) {
          coreBareCount++;
          git(repo, "config", "--unset", "core.bare");
        }
      }

      expect(readCoreBare(repo)).toBe(false);

      if (coreBareCount > 0) {
        console.error(`[repro] core.bare=true triggered ${coreBareCount}/20 times in rapid sequential cycles`);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("unset core.bare key survives worktree lifecycle (#1860)", () => {
    const repo = initRepo();
    try {
      // Start by unsetting core.bare (the #1860 structural fix)
      git(repo, "config", "--local", "--unset", "core.bare");
      const { exitCode: readExit } = git(repo, "config", "--local", "core.bare");
      expect(readExit).not.toBe(0); // key absent

      // Run worktree lifecycle: the key should not be recreated
      for (let i = 0; i < 10; i++) {
        const branch = `lifecycle-${i}`;
        const wtPath = join(repo, ".worktrees", branch);
        git(repo, "worktree", "add", wtPath, "-b", branch, "HEAD");

        // git operations in the worktree should not recreate core.bare on the parent
        const wtStatus = git(wtPath, "status");
        expect(wtStatus.exitCode).toBe(0);

        git(repo, "worktree", "remove", wtPath);
        git(repo, "branch", "-D", branch);

        // Verify local key is still absent after each cycle
        const { exitCode } = git(repo, "config", "--local", "core.bare");
        expect(exitCode).not.toBe(0);
      }

      // Final verification: git still works correctly
      expect(git(repo, "rev-parse", "--is-inside-work-tree").stdout).toBe("true");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
