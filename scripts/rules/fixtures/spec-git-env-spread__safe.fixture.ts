/**
 * @rule spec-git-env-spread
 * @expect 0
 * @path packages/core/src/git.spec.ts
 *
 * All safe patterns — none should be flagged:
 *   1. cleanGitEnv() function call (no direct process.env spread at call site)
 *   2. Inline spread with explicit GIT_DIR: undefined strip
 *   3. Hoisted variable with GIT_DIR: undefined strip (canonical #2400 fix form)
 *   4. Delete-based stripping (packages/daemon/src/index.spec.ts pattern)
 *   5. Non-git subprocess spreading process.env (bun, node) — out of scope
 *   6. execSync string-form with hoisted stripped env (cli-orchestration.spec.ts pattern)
 *   7. node-form spawnSync("git", args, cleanGitEnv()) — opts at index 2 (#2785)
 *   8. template-literal git command with cleanGitEnv() (#2785)
 */

import { describe, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function cleanGitEnv(): Record<string, string | undefined> {
  const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_COMMON_DIR: _c, GIT_INDEX_FILE: _i, GIT_OBJECT_DIRECTORY: _o, ...rest } =
    process.env;
  return rest;
}

describe("safe git env patterns", () => {
  test("1. cleanGitEnv() — no direct process.env spread at the spawn site", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
  });

  test("2. inline spread with explicit GIT_DIR: undefined strip", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], {
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    });
  });

  test("3. hoisted variable with GIT_DIR: undefined strip (canonical #2400 fix)", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    const gitSafeEnv = {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
    };
    execSync("git init -q", { cwd: repo, env: gitSafeEnv });
  });

  test("4. delete-based stripping (index.spec.ts pattern)", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    const cleanEnv = { ...process.env };
    for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
      delete (cleanEnv as Record<string, string | undefined>)[k];
    }
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanEnv });
  });

  test("5. non-git subprocess spreading process.env — out of scope", () => {
    Bun.spawn(["bun", "script.ts"], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    Bun.spawnSync(["node", "--version"], { env: { ...process.env } });
  });

  test("6. execSync string-form with hoisted stripped env", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    const gitSafeEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
    execSync(
      'git init && git -c user.email="t@t.com" -c user.name="T" commit --allow-empty -m init',
      { cwd: repo, stdio: "pipe", env: gitSafeEnv },
    );
  });

  test("7. node-form spawnSync(cmd, args, opts) with cleanGitEnv()", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    spawnSync("git", ["-C", repo, "init", "-q"], { env: cleanGitEnv() });
  });

  test("8. template-literal git command with cleanGitEnv()", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-test-"));
    execSync(`git init -q`, { cwd: repo, env: cleanGitEnv() });
  });
});
