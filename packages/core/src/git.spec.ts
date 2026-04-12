import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecFn, findGitRoot, fixCoreBare } from "./git";

/** Create a temp dir with a .git file (like a worktree) */
function makeFakeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-test-"));
  writeFileSync(join(dir, ".git"), "gitdir: /some/repo\n");
  return dir;
}

/** Create a temp dir WITHOUT a .git entry (simulates a bare repo root) */
function makeFakeBareRepo(): string {
  return mkdtempSync(join(tmpdir(), "git-bare-"));
}

describe("fixCoreBare", () => {
  test("unsets core.bare when it is true", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          // git config core.bare (read)
          return { stdout: "true\n", exitCode: 0 };
        }
        // git config --unset core.bare
        return { stdout: "", exitCode: 0 };
      });

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(["git", "-C", cwd, "config", "core.bare"]);
      expect(calls[1]).toEqual(["git", "-C", cwd, "config", "--unset", "core.bare"]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns false when unset fails", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          // read — core.bare is true
          return { stdout: "true\n", exitCode: 0 };
        }
        // unset fails
        return { stdout: "", exitCode: 1 };
      });

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(false);
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("does nothing for a bare repo (no .git entry)", () => {
    const cwd = makeFakeBareRepo();
    try {
      const exec: ExecFn = mock(() => ({ stdout: "", exitCode: 0 }));

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(false);
      expect(exec).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("does nothing when core.bare is false", () => {
    const cwd = makeFakeWorktree();
    try {
      const exec: ExecFn = mock((_cmd: string[]) => {
        return { stdout: "false\n", exitCode: 0 };
      });

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(false);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("does nothing when core.bare is not set (git exits non-zero)", () => {
    const cwd = makeFakeWorktree();
    try {
      const exec: ExecFn = mock(() => {
        return { stdout: "", exitCode: 1 };
      });

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(false);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});

/** Strip GIT_* env vars that git hooks inject — prevents them from redirecting git init/rev-parse. */
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

describe("findGitRoot", () => {
  // Strip hook-injected git env vars so fixture git calls work even under pre-commit.
  const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_INDEX_FILE: _i, ...cleanEnv } = process.env;
  const gitOpts = { env: cleanEnv, stdout: "ignore" as const, stderr: "ignore" as const };

  test("returns the repo root from a subdirectory inside a real repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-root-"));
    try {
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const sub = join(repo, "nested", "deeper");
      mkdirSync(sub, { recursive: true });
      const got = findGitRoot(sub);
      // macOS tmpdir() can resolve via /private — accept either via endsWith.
      expect(got && (got === repo || got.endsWith(repo))).toBeTruthy();
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("returns null outside any git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-no-root-"));
    try {
      expect(findGitRoot(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns main checkout root from inside a linked worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-wt-main-"));
    const wt = join(repo, "linked-wt");
    try {
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], gitOpts);
      Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "init", "-q"], {
        ...gitOpts,
        env: {
          ...cleanEnv,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      Bun.spawnSync(["git", "-C", repo, "worktree", "add", wt, "-b", "wt-branch", "-q"], gitOpts);
      const got = findGitRoot(wt);
      expect(got).not.toBeNull();
      // The linked worktree's common-dir parent should equal the main checkout.
      expect(got && (got === repo || got.endsWith(repo.replace(/^\/private/, "")))).toBeTruthy();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns git directory for a bare repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-bare-"));
    try {
      Bun.spawnSync(["git", "-C", repo, "init", "--bare", "-q"], gitOpts);
      const got = findGitRoot(repo);
      expect(got).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true });
    }
  });
});
