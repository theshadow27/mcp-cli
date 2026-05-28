import { describe, expect, test } from "bun:test";
import { type GitRunner, coveragePathInDiff, resolveChangedSourceFiles } from "./coverage-diff";

describe("coveragePathInDiff", () => {
  test("returns true when changed is null (full enforcement)", () => {
    expect(coveragePathInDiff("packages/core/src/config.ts", null)).toBe(true);
  });

  test("exact match", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(true);
  });

  test("no match for unrelated file", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/daemon/src/server-pool.ts", changed)).toBe(false);
  });

  test("suffix match — coverage path is shorter", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("core/src/config.ts", changed)).toBe(true);
  });

  test("suffix match — changed path is shorter (requires / separator)", () => {
    const changed = new Set(["src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(true);
  });

  test("empty changed set means nothing is in diff", () => {
    const changed = new Set<string>();
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(false);
  });

  test("multiple changed files — match on second", () => {
    const changed = new Set(["scripts/am-i-done.ts", "packages/core/src/env.ts"]);
    expect(coveragePathInDiff("packages/core/src/env.ts", changed)).toBe(true);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(false);
  });

  test("does not false-positive on partial filename overlap", () => {
    const changed = new Set(["packages/core/src/config.ts"]);
    expect(coveragePathInDiff("packages/core/src/config-display.ts", changed)).toBe(false);
  });

  test("slash guard prevents bare suffix collision without path separator", () => {
    const changed = new Set(["ig.ts"]);
    expect(coveragePathInDiff("packages/core/src/config.ts", changed)).toBe(false);
    expect(coveragePathInDiff("ig.ts", changed)).toBe(true);
  });
});

function makeGit(responses: Record<string, { status: number; stdout: string }>): GitRunner {
  return (_cmd: string, args: string[]) => {
    const key = args.join(" ");
    return responses[key] ?? { status: 1, stdout: "" };
  };
}

describe("resolveChangedSourceFiles", () => {
  test("returns null when rev-parse fails", () => {
    const git = makeGit({});
    expect(resolveChangedSourceFiles(git)).toBeNull();
  });

  test("returns null on main branch", () => {
    const git = makeGit({ "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "main\n" } });
    expect(resolveChangedSourceFiles(git)).toBeNull();
  });

  test("returns null on master branch", () => {
    const git = makeGit({ "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "master\n" } });
    expect(resolveChangedSourceFiles(git)).toBeNull();
  });

  test("returns null on detached HEAD", () => {
    const git = makeGit({ "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "HEAD\n" } });
    expect(resolveChangedSourceFiles(git)).toBeNull();
  });

  test("returns changed files on feature branch via origin/main", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 0, stdout: "abc123\n" },
      "diff --name-only abc123 HEAD": {
        status: 0,
        stdout: "packages/core/src/config.ts\npackages/daemon/src/main.ts\n",
      },
      "diff --name-only HEAD": { status: 0, stdout: "packages/core/src/env.ts\n" },
    });
    const result = resolveChangedSourceFiles(git);
    expect(result).toEqual(
      new Set(["packages/core/src/config.ts", "packages/daemon/src/main.ts", "packages/core/src/env.ts"]),
    );
  });

  test("falls back to local main when origin/main is unavailable", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 1, stdout: "" },
      "merge-base main HEAD": { status: 0, stdout: "def456\n" },
      "diff --name-only def456 HEAD": { status: 0, stdout: "scripts/check-coverage.ts\n" },
      "diff --name-only HEAD": { status: 0, stdout: "" },
    });
    const result = resolveChangedSourceFiles(git);
    expect(result).toEqual(new Set(["scripts/check-coverage.ts"]));
  });

  test("returns null when both origin/main and main merge-base fail", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 1, stdout: "" },
      "merge-base main HEAD": { status: 1, stdout: "" },
    });
    expect(resolveChangedSourceFiles(git)).toBeNull();
  });

  test("skips ref when committed diff fails", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 0, stdout: "abc123\n" },
      "diff --name-only abc123 HEAD": { status: 1, stdout: "" },
      "merge-base main HEAD": { status: 0, stdout: "def456\n" },
      "diff --name-only def456 HEAD": { status: 0, stdout: "src/foo.ts\n" },
      "diff --name-only HEAD": { status: 0, stdout: "" },
    });
    const result = resolveChangedSourceFiles(git);
    expect(result).toEqual(new Set(["src/foo.ts"]));
  });

  test("handles uncommitted diff failure gracefully", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 0, stdout: "abc123\n" },
      "diff --name-only abc123 HEAD": { status: 0, stdout: "src/bar.ts\n" },
      "diff --name-only HEAD": { status: 1, stdout: "" },
    });
    const result = resolveChangedSourceFiles(git);
    expect(result).toEqual(new Set(["src/bar.ts"]));
  });

  test("deduplicates files appearing in both committed and uncommitted", () => {
    const git = makeGit({
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "fix/my-branch\n" },
      "merge-base origin/main HEAD": { status: 0, stdout: "abc123\n" },
      "diff --name-only abc123 HEAD": { status: 0, stdout: "src/shared.ts\nsrc/other.ts\n" },
      "diff --name-only HEAD": { status: 0, stdout: "src/shared.ts\n" },
    });
    const result = resolveChangedSourceFiles(git);
    expect(result).toEqual(new Set(["src/shared.ts", "src/other.ts"]));
    expect(result?.size).toBe(2);
  });
});
