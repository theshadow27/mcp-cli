/**
 * @rule spec-git-env-spread
 * @expect 0
 * @path packages/core/src/git.spec.ts
 *
 * The cleanGitEnv() pattern strips hook vars before spreading — safe.
 * A bare env object (no spread) is also safe.
 * An inline spread with explicit GIT_DIR: undefined is also exempt.
 */

import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

describe("safe patterns", () => {
  test("cleanGitEnv() strips hook vars", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: cleanGitEnv() });
  });

  test("bare env object — no spread at all", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], {
      env: { PATH: process.env.PATH ?? "/usr/bin", HOME: process.env.HOME ?? "/tmp" },
    });
  });

  test("explicit GIT_DIR: undefined on the same line is exempt", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["bun", "script.ts"], { env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  });
});
