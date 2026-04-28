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
    printInfo: mock(() => {}),
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

  test("throws WorktreeError on git failure with stderr message", () => {
    const deps = makeDeps({
      exec: mock(() => ({ stdout: "", stderr: "fatal: branch already exists", exitCode: 128 })),
    });
    expect(() => createWorktree({ name: "my-feat", repoRoot: "/repo", branchPrefix: "codex/" }, deps)).toThrow(
      "Failed to create worktree: fatal: branch already exists",
    );
  });

  test("guards against path traversal", () => {
    const deps = makeDeps();
    expect(() =>
      createWorktree({ name: "../../../etc/passwd", repoRoot: "/repo", branchPrefix: "codex/" }, deps),
    ).toThrow("resolves outside the worktree base directory");
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

  test("shimmed worktree: fixes core.bare=true after worktree add", () => {
    tmpDir = makeTmpDir();
    // Create .git dir so fixCoreBare detects a non-bare repo
    mkdirSync(join(tmpDir, ".git"), { recursive: true });

    const execCalls: string[][] = [];
    const deps = makeDeps({
      exec: mock((cmd: string[]) => {
        execCalls.push(cmd);
        // Simulate git reporting core.bare=true (the bug we're guarding against)
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          return { stdout: "true", stderr: "", exitCode: 0 };
        }
        // git config --unset core.bare — the fix
        if (cmd.includes("--unset") && cmd.includes("core.bare")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });

    const result = createWorktree({ name: "my-feat", repoRoot: tmpDir, branchPrefix: "claude/" }, deps);
    expect(result.shimmed).toBe(true);

    // Verify core.bare was checked both before and after worktree add
    const worktreeAddIdx = execCalls.findIndex((c) => c.includes("worktree") && c.includes("add"));
    const isCoreBareRead = (c: string[]) => c.includes("config") && c.includes("core.bare") && !c.includes("--unset");
    // There should be a read BEFORE the add (pre-probe) and one AFTER (post-probe / fixCoreBare)
    expect(execCalls.slice(0, worktreeAddIdx).some(isCoreBareRead)).toBe(true);
    const coreBareReadAfterIdx = execCalls.findIndex((c, i) => i > worktreeAddIdx && isCoreBareRead(c));
    expect(coreBareReadAfterIdx).toBeGreaterThan(worktreeAddIdx);

    // Verify it was fixed (core.bare unset)
    const coreBareFixIdx = execCalls.findIndex((c) => c.includes("--unset") && c.includes("core.bare"));
    expect(coreBareFixIdx).toBeGreaterThan(coreBareReadAfterIdx);

    // Should log the fix (via printInfo, not printError)
    expect(deps.printInfo).toHaveBeenCalledWith("Fixed core.bare=true after worktree add");
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
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  // Helper: builds an exec mock that handles the standard git commands.
  // worktreePath doesn't exist on disk, so existsSync returns false → verified removed.
  function happyExec() {
    return mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/my-branch", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      // rev-parse --verify: branch gone after -d → exit 1
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
  }

  test("removes clean worktree and deletes merged branch", () => {
    const exec = happyExec();
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");

    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining("Removed worktree"));
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
    expect(printError).not.toHaveBeenCalledWith(expect.stringContaining("Removed worktree"));
    expect(printError).not.toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
  });

  test("warns on dirty worktree without removing", () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "M file.ts", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");

    expect(printError).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
    // Should NOT have called worktree remove
    const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string[]).includes("remove"),
    );
    expect(removeCalls.length).toBe(0);
  });

  test("no-ops when worktree is already gone and directory absent", () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 128 }));
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");
    // Path doesn't exist on disk → no removal attempted, no messages
    expect(printError).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
  });

  test("guards against path traversal", () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("../../../etc/passwd", "/repo/.claude/worktrees/x", { exec, printError, printInfo }, "/repo");
    expect(exec).not.toHaveBeenCalled();
  });

  test("trims branch name before deleting", () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/my-branch\n", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");

    // The branch delete call should use the trimmed branch name
    const deleteCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string[]).includes("-d"),
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0] as string[]).toContain("feat/my-branch");
    expect(deleteCalls[0][0] as string[]).not.toContain("feat/my-branch\n");
  });

  test("handles trailing newline in git status --porcelain for clean repo", () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "\n", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/branch", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");

    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining("Removed worktree"));
  });

  test("retries with --force when directory persists after exit-0 remove", () => {
    // Create a real temp dir so existsSync returns true after the first remove
    tmpDir = makeTmpDir();
    const worktreeBase = join(tmpDir, ".claude", "worktrees");
    const worktreePath = join(worktreeBase, "stubborn-wt");
    mkdirSync(worktreePath, { recursive: true });

    let forceAttempted = false;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/branch", stderr: "", exitCode: 0 };
      if (cmd.includes("remove") && cmd.includes("--force")) {
        forceAttempted = true;
        // Simulate --force succeeding: remove the dir so existsSync returns false
        rmSync(worktreePath, { recursive: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 }; // exit 0 but dir stays
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("stubborn-wt", worktreePath, { exec, printError, printInfo }, tmpDir);

    expect(forceAttempted).toBe(true);
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining("Removed worktree (--force)"));
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
    expect(printError).not.toHaveBeenCalledWith(expect.stringContaining("Removed worktree"));
    expect(printError).not.toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
  });

  test("reports failure with diagnostics when both remove attempts fail", () => {
    tmpDir = makeTmpDir();
    const worktreeBase = join(tmpDir, ".claude", "worktrees");
    const worktreePath = join(worktreeBase, "stuck-wt");
    mkdirSync(worktreePath, { recursive: true });

    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/branch", stderr: "", exitCode: 0 };
      // Both remove attempts fail (dir stays on disk)
      if (cmd.includes("remove") && cmd.includes("--force"))
        return { stdout: "", stderr: "fatal: cannot force remove", exitCode: 1 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "is dirty", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("stuck-wt", worktreePath, { exec, printError, printInfo }, tmpDir);

    const msgs = (printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(msgs.some((m) => m.includes("Failed to remove worktree"))).toBe(true);
    expect(msgs.some((m) => m.includes("fatal: cannot force remove"))).toBe(true);
    // Success messages must NOT appear on printError
    expect(msgs.some((m) => m.startsWith("Removed worktree"))).toBe(false);
    expect(msgs.some((m) => m.startsWith("Deleted branch"))).toBe(false);
    // printInfo must also be silent — nothing was successfully removed
    const infoMsgs = (printInfo as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoMsgs.some((m) => m.startsWith("Removed worktree"))).toBe(false);
    expect(infoMsgs.some((m) => m.startsWith("Deleted branch"))).toBe(false);
  });

  test("attempts removal when git status fails but directory exists (corrupted worktree)", () => {
    tmpDir = makeTmpDir();
    const worktreeBase = join(tmpDir, ".claude", "worktrees");
    const worktreePath = join(worktreeBase, "corrupt-wt");
    mkdirSync(worktreePath, { recursive: true });

    const exec = mock((cmd: string[]) => {
      // git status fails (corrupted .git file)
      if (cmd.includes("status") && cmd.includes("--porcelain"))
        return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
      if (cmd.includes("remove") && !cmd.includes("--force")) {
        rmSync(worktreePath, { recursive: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("corrupt-wt", worktreePath, { exec, printError, printInfo }, tmpDir);

    const errorMsgs = (printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    const infoMsgs = (printInfo as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(errorMsgs.some((m) => m.includes("git status failed in worktree"))).toBe(true);
    // Successful removal is an info message, not an error
    expect(infoMsgs.some((m) => m.includes("Removed worktree"))).toBe(true);
    expect(errorMsgs.some((m) => m.includes("Removed worktree"))).toBe(false);
  });

  test("corrupted worktree: skips --force when non-force removal fails", () => {
    tmpDir = makeTmpDir();
    const worktreeBase = join(tmpDir, ".claude", "worktrees");
    const worktreePath = join(worktreeBase, "corrupt-stuck-wt");
    mkdirSync(worktreePath, { recursive: true });

    let forceAttempted = false;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain"))
        return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
      if (cmd.includes("remove") && cmd.includes("--force")) {
        forceAttempted = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 1 }; // non-force fails; dir stays
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("corrupt-stuck-wt", worktreePath, { exec, printError, printInfo }, tmpDir);

    const msgs = (printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(forceAttempted).toBe(false);
    expect(msgs.some((m) => m.includes("skipping --force because cleanliness could not be verified"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("Removed worktree"))).toBe(false);
    expect(
      (printInfo as ReturnType<typeof mock>).mock.calls
        .map((c: unknown[]) => c[0] as string)
        .some((m) => m.startsWith("Removed worktree")),
    ).toBe(false);
  });

  test("branch delete reports success only after rev-parse verification", () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "zombie-branch", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      // Branch still exists after -d (rev-parse succeeds → branch NOT gone)
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "abc123", stderr: "", exitCode: 0 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    cleanupWorktree("my-wt", "/repo/.claude/worktrees/my-wt", { exec, printError, printInfo }, "/repo");

    const errorMsgs = (printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    const infoMsgs = (printInfo as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string);
    // Worktree was removed (path doesn't exist on disk) — success goes to printInfo
    expect(infoMsgs.some((m) => m.startsWith("Removed worktree"))).toBe(true);
    expect(errorMsgs.some((m) => m.startsWith("Removed worktree"))).toBe(false);
    // Branch should NOT be claimed as deleted — verification failed
    expect(infoMsgs.some((m) => m.startsWith("Deleted branch"))).toBe(false);
    expect(errorMsgs.some((m) => m.includes("branch still exists"))).toBe(true);
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
    expect(result.allWorktrees).toHaveLength(3);
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
  test("prunes clean merged worktrees", async () => {
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
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("core.bare")) return { stdout: "false", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});

    const result = await pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(),
      deps: { exec, printError, printInfo },
    });

    expect(result.pruned).toBe(1);
    expect(result.prunedNames).toEqual(["feat-done"]);
    expect(result.skippedUnmerged).toEqual([]);
  });

  test("skips worktrees with active sessions", async () => {
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
    const printInfo = mock(() => {});

    const result = await pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(["feat-active"]),
      deps: { exec, printError, printInfo },
    });

    expect(result.pruned).toBe(0);
  });

  test("skips unmerged branches", async () => {
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
    const printInfo = mock(() => {});

    const result = await pruneWorktrees({
      repoRoot: "/repo",
      activeWorktrees: new Set(),
      deps: { exec, printError, printInfo },
    });

    expect(result.pruned).toBe(0);
    expect(result.skippedUnmerged).toEqual(["claude/feat-wip"]);
  });

  test("batch guard: calls fixCoreBare after pruning when core.bare=true on last removal", async () => {
    // Simulate the recurrence bug: individual per-removal fix runs but a subsequent
    // removal flips core.bare back to true. The final batch guard should catch it.
    // fixCoreBare guards against non-existent repos via existsSync(.git), so we need
    // a real temp dir with a .git marker.
    const repoRoot = makeTmpDir();
    try {
      writeFileSync(join(repoRoot, ".git"), "gitdir: /some/repo\n");
      const wt1 = join(repoRoot, ".claude", "worktrees", "feat-a");
      const wt2 = join(repoRoot, ".claude", "worktrees", "feat-b");

      const porcelainOutput = [
        `worktree ${repoRoot}`,
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        `worktree ${wt1}`,
        "HEAD def456",
        "branch refs/heads/claude/feat-a",
        "",
        `worktree ${wt2}`,
        "HEAD ghi789",
        "branch refs/heads/claude/feat-b",
        "",
      ].join("\n");

      const execCalls: string[][] = [];
      const exec = mock((cmd: string[]) => {
        execCalls.push(cmd);
        if (cmd.includes("list") && cmd.includes("--porcelain"))
          return { stdout: porcelainOutput, stderr: "", exitCode: 0 };
        if (cmd.includes("symbolic-ref")) return { stdout: "refs/remotes/origin/main", stderr: "", exitCode: 0 };
        if (cmd.includes("--merged"))
          return { stdout: "  main\n  claude/feat-a\n  claude/feat-b\n", stderr: "", exitCode: 0 };
        if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("worktree") && cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("branch") && cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
        // Simulate core.bare=true after all removals complete
        if (cmd.includes("config") && cmd.includes("core.bare") && !cmd.includes("--unset")) {
          return { stdout: "true", stderr: "", exitCode: 0 };
        }
        // --unset succeeds
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const printErrors: string[] = [];
      const printError = mock((msg: string) => printErrors.push(msg));
      const printInfos: string[] = [];
      const printInfo = mock((msg: string) => printInfos.push(msg));

      const result = await pruneWorktrees({
        repoRoot,
        activeWorktrees: new Set(),
        deps: { exec, printError, printInfo },
      });

      expect(result.pruned).toBe(2);
      // Verify the batch-guard --unset call was made
      const unsetCalls = execCalls.filter((c) => c.includes("--unset") && c.includes("core.bare"));
      expect(unsetCalls.length).toBeGreaterThanOrEqual(1);
      // Verify the batch guard printed the fix (via printInfo, not printError)
      expect(printInfos.some((m) => m.includes("batch worktree prune"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true });
    }
  });
});
