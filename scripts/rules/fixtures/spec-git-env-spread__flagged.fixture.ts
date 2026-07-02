/**
 * @rule spec-git-env-spread
 * @expect 5
 * @path packages/command/src/commands/session-deps.spec.ts
 *
 * Five git subprocess calls with a raw `...process.env` spread and no GIT_DIR
 * strip — the inline form, the multi-line object form (old PatternRule miss),
 * the hoisted-variable form (old PatternRule miss), the node-form
 * `spawnSync("git", args, opts)` with opts at index 2 (#2785), and the
 * template-literal git command (#2785). All five must be flagged.
 */

import { describe, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
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

  test("node-form spawnSync(cmd, args, opts) — opts at index 2 (#2785)", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    spawnSync("git", ["-C", repo, "init", "-q"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  });

  test("template-literal git command (#2785)", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    execSync(`git init -q`, { cwd: repo, env: { ...process.env } });
  });
});
