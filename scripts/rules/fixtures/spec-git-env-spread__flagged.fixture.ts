/**
 * @rule spec-git-env-spread
 * @expect 3
 * @path packages/command/src/commands/session-deps.spec.ts
 *
 * Three git subprocess calls with a raw `...process.env` spread and no
 * GIT_DIR strip — the inline form, the multi-line object form (which the old
 * PatternRule missed), and the hoisted-variable form (which the old PatternRule
 * also missed). All three must be flagged.
 */

import { describe, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("git env violations", () => {
  test("inline — single-line spread without GIT_DIR strip", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  });

  test("multi-line — formatter-wrapped object (old PatternRule miss)", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-m", "init"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
      },
    });
  });

  test("hoisted variable without strip — one-level indirection (old PatternRule miss)", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    const unsafeEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
    execSync("git init -q", { cwd: repo, env: unsafeEnv });
  });
});
