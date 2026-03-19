import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKTREE_CONFIG_FILENAME } from "./worktree-config";
import type { WorktreeShimDeps } from "./worktree-shim";
import {
  WorktreeError,
  cleanupWorktree,
  createWorktree,
  getDefaultBranch,
  listMcxWorktrees,
  parseWorktreeList,
  pruneWorktrees,
} from "./worktree-shim";

// ── Helpers ──

function makeDeps(overrides?: Partial<WorktreeShimDeps>): WorktreeShimDeps {
  return {
    exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    printError: mock(() => {}),
    ...overrides,
  };
}

/** Create a temp directory for test isolation. */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `worktree-shim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── parseWorktreeList ──

describe("parseWorktreeList", () => {
  test("parses porcelain output with branches", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/claude-abc",
      "HEAD def456",
      "branch refs/heads/feat/issue-42",
      "",
    ].join("\n");
    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.claude/worktrees/claude-abc", branch: "feat/issue-42" },
    ]);
  });

  test("handles detached HEAD (no branch)", () => {
    const output = ["worktree /repo", "HEAD abc123", "detached", ""].join("\n");
    const result = parseWorktreeList(output);
    expect(result).toEqual([{ path: "/repo", branch: null }]);
  });

  test("returns empty array for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

// ── createWorktree ──

describe("createWorktree", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("native worktree: returns shimmed=false with just worktree name", () => {
    const deps = makeDeps();
    const result = createWorktree({ name: "my-feat", repoRoot: "/repo", nativeWorktree: true }, deps);
    expect(result.shimmed).toBe(false);
    expect(result.toolArgs).toEqual({ worktree: "my-feat" });
    expect(result.path).toBe("/repo/.claude/worktrees/my-feat");
    // exec should NOT have been called — no git commands for native
    expect(deps.exec).not.toHaveBeenCalled();
  });

  test("shimmed worktree: creates with branch prefix", () => {
    const deps = makeDeps();
    const result = createWorktree({ name: "my-feat", repoRoot: "/repo", branchPrefix: "codex/" }, deps);
    expect(result.shimmed).toBe(true);
    expect(result.path).toBe("/repo/.claude/worktrees/my-feat");
    expect(result.toolArgs).toEqual({
      cwd: "/repo/.claude/worktrees/my-feat",
      worktree: "my-feat",
      repoRoot: "/repo",
    });
    // Should call git worktree add with prefixed branch
    expect(deps.exec).toHaveBeenCalledWith([
      "git",
      "worktree",
      "add",
      "/repo/.claude/worktrees/my-feat",
      "-b",
      "codex/my-feat",
      "HEAD",
    ]);
  });

  test("shimmed worktree: no prefix when branchPrefix not set", () => {
    const deps = makeDeps();
    const result = createWorktree({ name: "my-feat", repoRoot: "/repo" }, deps);
    expect(result.shimmed).toBe(true);
    // Should use name as-is for branch name
    expect(deps.exec).toHaveBeenCalledWith([
      "git",
      "worktree",
      "add",
      "/repo/.claude/worktrees/my-feat",
      "-b",
      "my-feat",
      "HEAD",
    ]);
  });

  test("throws WorktreeError on git failure", () => {
    const deps = makeDeps({
      exec: mock(() => ({ stdout: "error: branch already exists", stderr: "", exitCode: 128 })),
    });
    expect(() => createWorktree({ name: "my-feat", repoRoot: "/repo", branchPrefix: "codex/" }, deps)).toThrow(
      WorktreeError,
    );
  });

  test("hooks: runs setup hook and sets cwd", () => {
    tmpDir = makeTmpDir();
    // Write config with setup hook
    writeFileSync(
      join(tmpDir, WORKTREE_CONFIG_FILENAME),
      JSON.stringify({ worktree: { setup: "mkdir -p $MCX_PATH" } }),
    );
    // Create the expected worktree path so existsSync passes
    const expectedPath = join(tmpDir, ".claude", "worktrees", "my-feat");
    mkdirSync(expectedPath, { recursive: true });

    const deps = makeDeps({
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });

    const result = createWorktree({ name: "my-feat", repoRoot: tmpDir }, deps);
    expect(result.shimmed).toBe(true);
    expect(result.toolArgs.cwd).toBe(expectedPath);
    expect(result.toolArgs.worktree).toBe("my-feat");
    expect(result.toolArgs.repoRoot).toBe(tmpDir);
    // Should have called exec with the hook command
    expect(deps.exec).toHaveBeenCalledWith(
      ["sh", "-c", "mkdir -p $MCX_PATH"],
      expect.objectContaining({ env: expect.objectContaining({ MCX_BRANCH: "my-feat" }) }),
    );
  });

  test("hooks: throws on hook failure", () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { setup: "false" } }));
    const deps = makeDeps({
      exec: mock(() => ({ stdout: "", stderr: "hook failed", exitCode: 1 })),
    });

    expect(() => createWorktree({ name: "my-feat", repoRoot: tmpDir }, deps)).toThrow(
      "Worktree setup hook failed: hook failed",
    );
  });

  test("branchPrefix: false creates with raw branch name", () => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { branchPrefix: false } }));
    const deps = makeDeps();
    const result = createWorktree({ name: "my-feat", repoRoot: tmpDir }, deps);
    expect(result.shimmed).toBe(true);
    expect(deps.exec).toHaveBeenCalledWith([
      "git",
      "worktree",
      "add",
      join(tmpDir, ".claude", "worktrees", "my-feat"),
      "-b",
      "my-feat",
      "HEAD",
    ]);
  });
});

// ── cleanupWorktree ──

describe("cleanupWorktree", () => {
  test("removes clean worktree and deletes merged branch", () => {
    const execResults: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/my-branch", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError }, "/repo");

    expect(printError).toHaveBeenCalledWith(expect.stringContaining("Removed worktree"));
    expect(printError).toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
  });

  test("warns on dirty worktree without removing", () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "M file.ts", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError }, "/repo");

    expect(printError).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
    // Should NOT have called worktree remove
    const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string[]).includes("remove"),
    );
    expect(removeCalls.length).toBe(0);
  });

  test("no-ops when worktree is already gone", () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 128 }));
    const printError = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError }, "/repo");
    expect(printError).not.toHaveBeenCalled();
  });

  test("guards against path traversal", () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const printError = mock(() => {});

    cleanupWorktree("../../../etc/passwd", "/repo/.claude/worktrees/x", { exec, printError }, "/repo");
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── getDefaultBranch ──

describe("getDefaultBranch", () => {
  test("returns main from origin/HEAD", () => {
    const deps = makeDeps({
      exec: mock(() => ({
        stdout: "refs/remotes/origin/main",
        stderr: "",
        exitCode: 0,
      })),
    });
    expect(getDefaultBranch(deps, "/repo")).toBe("main");
  });

  test("returns master from origin/HEAD", () => {
    const deps = makeDeps({
      exec: mock(() => ({
        stdout: "refs/remotes/origin/master",
        stderr: "",
        exitCode: 0,
      })),
    });
    expect(getDefaultBranch(deps, "/repo")).toBe("master");
  });

  test("defaults to main when symbolic-ref fails", () => {
    const deps = makeDeps({
      exec: mock(() => ({ stdout: "", stderr: "error", exitCode: 1 })),
    });
    expect(getDefaultBranch(deps, "/repo")).toBe("main");
  });
});

// ── listMcxWorktrees ──

describe("listMcxWorktrees", () => {
  test("filters to worktrees under .claude/worktrees/", () => {
    const porcelainOutput = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat-a",
      "HEAD def456",
      "branch refs/heads/feat/a",
      "",
      "worktree /other/worktrees/b",
      "HEAD ghi789",
      "branch refs/heads/feat/b",
      "",
    ].join("\n");

    const deps = makeDeps({
      exec: mock(() => ({ stdout: porcelainOutput, stderr: "", exitCode: 0 })),
    });

    const result = listMcxWorktrees("/repo", deps);
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0].path).toBe("/repo/.claude/worktrees/feat-a");
    expect(result.worktreeBase).toBe("/repo/.claude/worktrees");
  });

  test("throws WorktreeError when git fails", () => {
    const deps = makeDeps({
      exec: mock(() => ({ stdout: "", stderr: "not a git repo", exitCode: 128 })),
    });
    expect(() => listMcxWorktrees("/repo", deps)).toThrow(WorktreeError);
  });
});

// ── pruneWorktrees ──

describe("pruneWorktrees", () => {
  test("prunes clean merged worktrees", () => {
    const porcelainOutput = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat-done",
      "HEAD def456",
      "branch refs/heads/claude/feat-done",
      "",
    ].join("\n");

    const exec = mock((cmd: string[]) => {
      // "worktree list --porcelain" vs "status --porcelain": disambiguate by checking for "list"
      if (cmd.includes("list") && cmd.includes("--porcelain"))
        return { stdout: porcelainOutput, stderr: "", exitCode: 0 };
      if (cmd.includes("symbolic-ref")) return { stdout: "refs/remotes/origin/main", stderr: "", exitCode: 0 };
      if (cmd.includes("--merged")) return { stdout: "  main\n  claude/feat-done\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 }; // clean
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});

    const result = pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(),
      deps: { exec, printError },
    });

    expect(result.pruned).toBe(1);
    expect(result.skippedUnmerged).toEqual([]);
  });

  test("skips worktrees with active sessions", () => {
    const porcelainOutput = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat-active",
      "HEAD def456",
      "branch refs/heads/claude/feat-active",
      "",
    ].join("\n");

    const exec = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain"))
        return { stdout: porcelainOutput, stderr: "", exitCode: 0 };
      if (cmd.includes("symbolic-ref")) return { stdout: "refs/remotes/origin/main", stderr: "", exitCode: 0 };
      if (cmd.includes("--merged")) return { stdout: "  main\n  claude/feat-active\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});

    const result = pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(["feat-active"]),
      deps: { exec, printError },
    });

    expect(result.pruned).toBe(0);
  });

  test("skips unmerged branches", () => {
    const porcelainOutput = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat-wip",
      "HEAD def456",
      "branch refs/heads/claude/feat-wip",
      "",
    ].join("\n");

    const exec = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain"))
        return { stdout: porcelainOutput, stderr: "", exitCode: 0 };
      if (cmd.includes("symbolic-ref")) return { stdout: "refs/remotes/origin/main", stderr: "", exitCode: 0 };
      if (cmd.includes("--merged")) return { stdout: "  main\n", stderr: "", exitCode: 0 }; // feat-wip NOT merged
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});

    const result = pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(),
      deps: { exec, printError },
    });

    expect(result.pruned).toBe(0);
    expect(result.skippedUnmerged).toEqual(["claude/feat-wip"]);
  });
});
