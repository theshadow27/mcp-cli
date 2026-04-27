import { describe, expect, test } from "bun:test";
import { BranchGuardError, DEFAULT_RUNS_ON, checkRunsOn, currentBranch } from "./branch-guard";
import type { ExecFn, ExecResult } from "./git";
import type { Manifest } from "./manifest";

type CmdKey = string;

function mockExec(responses: Record<CmdKey, ExecResult>): ExecFn {
  return (cmd: string[]): ExecResult => {
    const key = cmd.join(" ");
    const resp = responses[key];
    if (!resp) {
      return { stdout: "", exitCode: 128 };
    }
    return resp;
  };
}

const CWD = "/repo";

function manifest(runsOn?: string): Pick<Manifest, "runsOn"> {
  return runsOn === undefined ? {} : { runsOn };
}

const OK = (stdout: string): ExecResult => ({ stdout, exitCode: 0 });
const FAIL: ExecResult = { stdout: "", exitCode: 128 };

describe("currentBranch", () => {
  test("returns branch name on normal worktree", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("main\n"),
    });
    expect(currentBranch(CWD, exec)).toEqual({ kind: "branch", name: "main" });
  });

  test("returns detached for detached HEAD", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": FAIL,
    });
    expect(currentBranch(CWD, exec)).toEqual({ kind: "detached" });
  });

  test("returns bare for bare repository", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": { stdout: "false\n", exitCode: 128 },
      "git -C /repo rev-parse --is-bare-repository": OK("true\n"),
    });
    expect(currentBranch(CWD, exec)).toEqual({ kind: "bare" });
  });

  test("returns not-a-repo when rev-parse fails entirely", () => {
    const exec = mockExec({});
    expect(currentBranch(CWD, exec)).toEqual({ kind: "not-a-repo" });
  });

  test("returns detached when symbolic-ref prints empty stdout", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK(""),
    });
    expect(currentBranch(CWD, exec)).toEqual({ kind: "detached" });
  });
});

describe("checkRunsOn", () => {
  test("passes on main when runsOn is unset (default)", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("main\n"),
    });
    expect(() => checkRunsOn({ cwd: CWD, manifest: manifest(), exec })).not.toThrow();
  });

  test("refuses on feature branch with explicit message", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("feat/1241-foo\n"),
    });
    try {
      checkRunsOn({ cwd: CWD, manifest: manifest(), exec });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchGuardError);
      const e = err as BranchGuardError;
      expect(e.expected).toBe("main");
      expect(e.actual).toBe("feat/1241-foo");
      expect(e.message).toContain('phases only run from branch "main"');
      expect(e.message).toContain('current branch is "feat/1241-foo"');
      expect(e.message).toContain("install security boundary");
    }
  });

  test("passes when manifest runsOn matches current branch (develop)", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("develop\n"),
    });
    expect(() => checkRunsOn({ cwd: CWD, manifest: manifest("develop"), exec })).not.toThrow();
  });

  test("refuses when on main but manifest requires develop", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("main\n"),
    });
    expect(() => checkRunsOn({ cwd: CWD, manifest: manifest("develop"), exec })).toThrow(
      /phases only run from branch "develop", current branch is "main"/,
    );
  });

  test("refuses on detached HEAD", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": FAIL,
    });
    try {
      checkRunsOn({ cwd: CWD, manifest: manifest(), exec });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchGuardError);
      expect((err as BranchGuardError).actual).toBe("detached");
      expect((err as BranchGuardError).message).toContain("detached HEAD");
    }
  });

  test("refuses in bare repo", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": { stdout: "false\n", exitCode: 128 },
      "git -C /repo rev-parse --is-bare-repository": OK("true\n"),
    });
    try {
      checkRunsOn({ cwd: CWD, manifest: manifest(), exec });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchGuardError);
      expect((err as BranchGuardError).actual).toBe("bare");
      expect((err as BranchGuardError).message).toContain("bare repository");
    }
  });

  test("refuses outside any git repo", () => {
    const exec = mockExec({});
    try {
      checkRunsOn({ cwd: CWD, manifest: manifest(), exec });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchGuardError);
      expect((err as BranchGuardError).actual).toBe("not-a-repo");
      expect((err as BranchGuardError).message).toContain("not a git repository");
    }
  });

  test("DEFAULT_RUNS_ON is main", () => {
    expect(DEFAULT_RUNS_ON).toBe("main");
  });

  test("passes with no warning when on expected branch (allowBranches irrelevant)", () => {
    const exec = mockExec({
      "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
      "git -C /repo symbolic-ref --short HEAD": OK("main\n"),
    });
    const result = checkRunsOn({ cwd: CWD, manifest: manifest(), exec, allowBranches: ["feat/x"] });
    expect(result).toEqual({ warning: null });
  });

  describe("allowBranches", () => {
    test("bypasses guard with one-line warning when current branch is in list", () => {
      const exec = mockExec({
        "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
        "git -C /repo symbolic-ref --short HEAD": OK("feat/poc\n"),
      });
      const result = checkRunsOn({
        cwd: CWD,
        manifest: manifest(),
        exec,
        allowBranches: ["feat/poc"],
      });
      expect(result.warning).toBeTypeOf("string");
      expect(result.warning).toContain('phases running from branch "feat/poc"');
      expect(result.warning).toContain('"main"');
      expect(result.warning).toContain("install-security boundary not enforced");
    });

    test("still throws when current branch is not in the list", () => {
      const exec = mockExec({
        "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
        "git -C /repo symbolic-ref --short HEAD": OK("feat/other\n"),
      });
      expect(() => checkRunsOn({ cwd: CWD, manifest: manifest(), exec, allowBranches: ["feat/poc"] })).toThrow(
        BranchGuardError,
      );
    });

    test("bypass works when list contains multiple branches", () => {
      const exec = mockExec({
        "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
        "git -C /repo symbolic-ref --short HEAD": OK("feat/b\n"),
      });
      const result = checkRunsOn({
        cwd: CWD,
        manifest: manifest(),
        exec,
        allowBranches: ["feat/a", "feat/b"],
      });
      expect(result.warning).toContain('phases running from branch "feat/b"');
    });

    test("does not bypass for detached HEAD even if list is non-empty", () => {
      const exec = mockExec({
        "git -C /repo rev-parse --is-inside-work-tree": OK("true\n"),
        "git -C /repo symbolic-ref --short HEAD": FAIL,
      });
      expect(() => checkRunsOn({ cwd: CWD, manifest: manifest(), exec, allowBranches: ["feat/poc"] })).toThrow(
        BranchGuardError,
      );
    });
  });
});
