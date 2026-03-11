import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORKTREE_CONFIG_FILENAME,
  buildHookEnv,
  hasWorktreeHooks,
  readWorktreeConfig,
  resolveWorktreeBase,
  resolveWorktreePath,
} from "./worktree-config";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-config-"));
}

describe("readWorktreeConfig", () => {
  test("returns null when no config file exists", () => {
    const dir = makeTempDir();
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("returns null on malformed JSON and logs warning", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), "not json{{{");
    // Should return null without throwing
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("returns null when file has no worktree section", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ other: true }));
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("parses valid worktree config", () => {
    const dir = makeTempDir();
    const config = {
      worktree: {
        setup: "./scripts/setup.sh $MCX_BRANCH",
        teardown: "./scripts/teardown.sh $MCX_PATH",
        base: "../worktrees/myproject",
      },
    };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual(config.worktree);
  });

  test("returns config with only setup (no teardown/base)", () => {
    const dir = makeTempDir();
    const config = { worktree: { setup: "echo $MCX_BRANCH" } };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual({ setup: "echo $MCX_BRANCH" });
  });
});

describe("resolveWorktreeBase", () => {
  test("defaults to .claude/worktrees when no config", () => {
    expect(resolveWorktreeBase("/repo", null)).toBe("/repo/.claude/worktrees");
  });

  test("defaults to .claude/worktrees when config has no base", () => {
    expect(resolveWorktreeBase("/repo", { setup: "echo" })).toBe("/repo/.claude/worktrees");
  });

  test("resolves relative base from repo root", () => {
    expect(resolveWorktreeBase("/repo", { base: "../worktrees/proj" })).toBe("/worktrees/proj");
  });

  test("uses absolute base as-is", () => {
    expect(resolveWorktreeBase("/repo", { base: "/tmp/worktrees" })).toBe("/tmp/worktrees");
  });
});

describe("resolveWorktreePath", () => {
  test("joins base with name", () => {
    expect(resolveWorktreePath("/repo", "fix-123", null)).toBe("/repo/.claude/worktrees/fix-123");
  });

  test("uses custom base", () => {
    expect(resolveWorktreePath("/repo", "fix-123", { base: "/tmp/wt" })).toBe("/tmp/wt/fix-123");
  });
});

describe("buildHookEnv", () => {
  test("returns env vars with MCX_ prefix", () => {
    const env = buildHookEnv({
      branch: "fix-123",
      path: "/tmp/wt/fix-123",
      cwd: "/repo",
    });
    expect(env).toEqual({
      MCX_BRANCH: "fix-123",
      MCX_PATH: "/tmp/wt/fix-123",
      MCX_CWD: "/repo",
    });
  });

  test("handles special characters safely (no interpolation)", () => {
    const env = buildHookEnv({
      branch: "foo; rm -rf ~",
      path: "/tmp/wt/foo",
      cwd: "/repo",
    });
    // Values are stored as-is, no shell interpretation
    expect(env.MCX_BRANCH).toBe("foo; rm -rf ~");
  });
});

describe("hasWorktreeHooks", () => {
  test("returns false for null", () => {
    expect(hasWorktreeHooks(null)).toBe(false);
  });

  test("returns false when setup is missing", () => {
    expect(hasWorktreeHooks({ base: "/tmp" })).toBe(false);
  });

  test("returns false when setup is empty string", () => {
    expect(hasWorktreeHooks({ setup: "" })).toBe(false);
  });

  test("returns true when setup is non-empty", () => {
    expect(hasWorktreeHooks({ setup: "./scripts/setup.sh" })).toBe(true);
  });
});
