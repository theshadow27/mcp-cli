import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecFn, fixCoreBare } from "./git";

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
  test("resets core.bare when it is true", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.length === 5) {
          // git config core.bare (read)
          return { stdout: "true\n", exitCode: 0 };
        }
        // git config core.bare false (write)
        return { stdout: "", exitCode: 0 };
      });

      const result = fixCoreBare(cwd, exec);

      expect(result).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(["git", "-C", cwd, "config", "core.bare"]);
      expect(calls[1]).toEqual(["git", "-C", cwd, "config", "core.bare", "false"]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  test("returns false when write fails", () => {
    const cwd = makeFakeWorktree();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = mock((cmd: string[]) => {
        calls.push(cmd);
        if (cmd.length === 5) {
          // read — core.bare is true
          return { stdout: "true\n", exitCode: 0 };
        }
        // write fails
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
