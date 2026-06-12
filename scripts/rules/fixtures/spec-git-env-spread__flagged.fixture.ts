/**
 * @rule spec-git-env-spread
 * @expect 2
 * @path packages/command/src/commands/session-deps.spec.ts
 *
 * Two subprocess spawns that spread process.env directly into the env option
 * without stripping GIT_DIR — both should be flagged.
 */

import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("session-deps (bad)", () => {
  test("git init in temp dir — inherits GIT_DIR from hook", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  });

  test("git commit — also bad", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "init"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "test" },
    });
  });
});
