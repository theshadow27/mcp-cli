import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecFn,
  type GitSpawnFn,
  clearFindGitRootCache,
  clearFindWorktreeRootCache,
  computeGitRootResult,
  computeWorktreeRootResult,
  ensureCoreBareUnset,
  findGitRoot,
  findWorktreeRoot,
  fixCoreBare,
} from "./git";
import type { SpawnResult } from "./subprocess";

/** Build a SpawnResult with sensible defaults, overriding only what a test cares about. */
function spawnResult(overrides: Partial<SpawnResult>): SpawnResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

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

describe("ensureCoreBareUnset", () => {
  test("removes core.bare when set to true", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          return { stdout: "true\n", exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
      });

      expect(ensureCoreBareUnset(cwd, exec)).toBe("removed");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(["git", "-C", cwd, "config", "--local", "--unset", "core.bare"]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("removes core.bare when set to false", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          return { stdout: "false\n", exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
      });

      expect(ensureCoreBareUnset(cwd, exec)).toBe("removed");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(["git", "-C", cwd, "config", "--local", "--unset", "core.bare"]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns absent when key is already absent", () => {
    const cwd = makeFakeWorktree();
    try {
      const exec: ExecFn = mock(() => ({ stdout: "", exitCode: 1 }));
      expect(ensureCoreBareUnset(cwd, exec)).toBe("absent");
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns absent for bare repo (no .git entry)", () => {
    const cwd = makeFakeBareRepo();
    try {
      const exec: ExecFn = mock(() => ({ stdout: "", exitCode: 0 }));
      expect(ensureCoreBareUnset(cwd, exec)).toBe("absent");
      expect(exec).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns fallback when unset fails and re-read confirms key still present", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const isRead = (cmd: string[]) =>
        cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset") && cmd.length === 6;
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (isRead(cmd)) return { stdout: "true\n", exitCode: 0 };
        if (cmd.includes("--unset")) return { stdout: "", exitCode: 1 };
        return { stdout: "", exitCode: 0 }; // fallback set
      });

      expect(ensureCoreBareUnset(cwd, exec)).toBe("fallback");
      expect(calls).toHaveLength(4);
      expect(calls[2]).toEqual(["git", "-C", cwd, "config", "--local", "core.bare"]); // re-read
      expect(calls[3]).toEqual(["git", "-C", cwd, "config", "--local", "core.bare", "false"]); // fallback
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns removed when unset fails but re-read shows key gone (benign race)", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      let readCount = 0;
      const isRead = (cmd: string[]) =>
        cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset") && cmd.length === 6;
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (isRead(cmd)) {
          readCount++;
          if (readCount === 1) return { stdout: "true\n", exitCode: 0 }; // initial read
          return { stdout: "", exitCode: 1 }; // re-read: key gone
        }
        if (cmd.includes("--unset")) return { stdout: "", exitCode: 1 }; // unset fails (race)
        return { stdout: "", exitCode: 0 };
      });

      expect(ensureCoreBareUnset(cwd, exec)).toBe("removed");
      expect(calls).toHaveLength(3); // read, unset, re-read — no fallback set
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
  const cleanEnv = cleanGitEnv();
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

  test("caches result: repeated calls for the same path return identical value", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-cache-"));
    try {
      clearFindGitRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const first = findGitRoot(repo);
      const second = findGitRoot(repo);
      expect(first).toBe(second);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("caches null for directories outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-cache-null-"));
    try {
      clearFindGitRootCache();
      const first = findGitRoot(dir);
      const second = findGitRoot(dir);
      expect(first).toBeNull();
      expect(second).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("clearFindGitRootCache resets the cache", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-cache-clear-"));
    try {
      clearFindGitRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const before = findGitRoot(repo);
      clearFindGitRootCache();
      const after = findGitRoot(repo);
      expect(before).toBe(after); // same result after cache clear
    } finally {
      rmSync(repo, { recursive: true });
    }
  });
});

describe("findWorktreeRoot (#2737)", () => {
  const cleanEnv = cleanGitEnv();
  const gitOpts = { env: cleanEnv, stdout: "ignore" as const, stderr: "ignore" as const };
  const commitEnv = {
    ...cleanEnv,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  test("returns the worktree's OWN toplevel, not the main checkout, from a linked worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-wt-local-"));
    const wt = join(repo, "linked-wt");
    try {
      clearFindWorktreeRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], gitOpts);
      Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "init", "-q"], { ...gitOpts, env: commitEnv });
      Bun.spawnSync(["git", "-C", repo, "worktree", "add", wt, "-b", "wt-branch", "-q"], gitOpts);

      const wtRoot = findWorktreeRoot(wt);
      const mainRoot = findGitRoot(wt);
      // findGitRoot maps the worktree back to main; findWorktreeRoot does NOT.
      expect(wtRoot).not.toBeNull();
      expect(wtRoot && (wtRoot === wt || wtRoot.endsWith(wt.replace(/^\/private/, "")))).toBeTruthy();
      expect(wtRoot).not.toBe(mainRoot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns the repo root from a subdirectory of a normal checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-wt-sub-"));
    try {
      clearFindWorktreeRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const sub = join(repo, "nested", "deeper");
      mkdirSync(sub, { recursive: true });
      const got = findWorktreeRoot(sub);
      expect(got && (got === repo || got.endsWith(repo.replace(/^\/private/, "")))).toBeTruthy();
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("returns null outside any git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-wt-none-"));
    try {
      clearFindWorktreeRootCache();
      expect(findWorktreeRoot(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("clearFindWorktreeRootCache resets the cache", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-wt-cache-"));
    try {
      clearFindWorktreeRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const before = findWorktreeRoot(repo);
      clearFindWorktreeRootCache();
      const after = findWorktreeRoot(repo);
      expect(before).toBe(after);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });
});

describe("git-unavailable vs not-a-repo distinction (#2862)", () => {
  // A --show-toplevel spawn that reports a hard timeout (SIGTERM via the
  // GIT_REV_PARSE_TIMEOUT_MS deadline).
  const timeoutSpawn: GitSpawnFn = () => spawnResult({ timedOut: true, signal: "SIGTERM" });
  // A spawn that failed to launch (git binary missing / ENOENT) — spawnCaptureSync
  // catches and returns exitCode: null, timedOut: false.
  const spawnFailed: GitSpawnFn = () => spawnResult({ exitCode: null });
  // A genuine "outside any repo" — git answered with exit 128.
  const notARepo: GitSpawnFn = () => spawnResult({ exitCode: 128, stderr: "fatal: not a git repository" });

  describe("computeWorktreeRootResult", () => {
    test("timeout → git-unavailable(timeout), not not-a-repo", () => {
      const r = computeWorktreeRootResult("/anywhere", timeoutSpawn);
      expect(r.kind).toBe("git-unavailable");
      if (r.kind === "git-unavailable") expect(r.reason).toBe("timeout");
    });

    test("spawn failure → git-unavailable(spawn-failed)", () => {
      const r = computeWorktreeRootResult("/anywhere", spawnFailed);
      expect(r.kind).toBe("git-unavailable");
      if (r.kind === "git-unavailable") expect(r.reason).toBe("spawn-failed");
    });

    test("outside a repo (exit 128) → not-a-repo", () => {
      expect(computeWorktreeRootResult("/anywhere", notARepo).kind).toBe("not-a-repo");
    });

    test("success → root with the toplevel path", () => {
      const ok: GitSpawnFn = () => spawnResult({ ok: true, exitCode: 0, stdout: "/repo/top\n" });
      const r = computeWorktreeRootResult("/repo/top/sub", ok);
      expect(r).toEqual({ kind: "root", path: "/repo/top" });
    });
  });

  describe("computeGitRootResult", () => {
    test("timeout on --show-toplevel → git-unavailable(timeout), no bare fallback", () => {
      const r = computeGitRootResult("/anywhere", timeoutSpawn);
      expect(r.kind).toBe("git-unavailable");
      if (r.kind === "git-unavailable") expect(r.reason).toBe("timeout");
    });

    test("spawn failure → git-unavailable(spawn-failed)", () => {
      const r = computeGitRootResult("/anywhere", spawnFailed);
      expect(r.kind).toBe("git-unavailable");
      if (r.kind === "git-unavailable") expect(r.reason).toBe("spawn-failed");
    });

    test("--show-toplevel exit 128 but --git-common-dir succeeds → root (bare repo)", () => {
      // Bare-repo path: --show-toplevel errors (non-zero, not a timeout/spawn-fail),
      // then --git-common-dir answers. Must still resolve, not collapse to unavailable.
      const bare: GitSpawnFn = (_cmd, args) =>
        args.includes("--show-toplevel")
          ? spawnResult({ exitCode: 128, stderr: "fatal: this operation must be run in a work tree" })
          : spawnResult({ ok: true, exitCode: 0, stdout: "/bare/repo.git\n" });
      const r = computeGitRootResult("/bare/repo.git", bare);
      expect(r.kind).toBe("root");
    });

    test("--show-toplevel exits 0 with empty stdout → not-a-repo", () => {
      const empty: GitSpawnFn = () => spawnResult({ ok: true, exitCode: 0, stdout: "\n" });
      expect(computeGitRootResult("/x", empty).kind).toBe("not-a-repo");
    });
  });
});

describe("gitDiscoverEnv strip reaches --show-toplevel (#2862 secondary gap)", () => {
  test("findWorktreeRoot resolves the correct toplevel even with GIT_DIR/GIT_WORK_TREE injected", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-envstrip-"));
    const priorGitDir = process.env.GIT_DIR;
    const priorWorkTree = process.env.GIT_WORK_TREE;
    try {
      clearFindWorktreeRootCache();
      Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
      const sub = join(repo, "nested");
      mkdirSync(sub, { recursive: true });
      // Git hooks inject these; without the strip in gitDiscoverEnv() the probe
      // would honor GIT_DIR=/tmp and resolve the wrong (or no) tree.
      process.env.GIT_DIR = "/tmp";
      process.env.GIT_WORK_TREE = "/tmp";
      const got = findWorktreeRoot(sub);
      expect(got && (got === repo || got.endsWith(repo.replace(/^\/private/, "")))).toBeTruthy();
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined" (the string)
      if (priorGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = priorGitDir;
      // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined" (the string)
      if (priorWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = priorWorkTree;
      rmSync(repo, { recursive: true });
    }
  });
});
