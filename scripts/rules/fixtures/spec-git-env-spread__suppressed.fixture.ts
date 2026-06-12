/**
 * @rule spec-git-env-spread
 * @expect 0
 * @path packages/command/src/commands/session-deps.spec.ts
 *
 * A git spawn with an unstripped process.env spread that is suppressed via
 * dotw-ignore. This is the escape hatch for genuinely exceptional cases where
 * the spawn cannot inherit GIT_DIR (e.g. the git process runs in a container
 * that doesn't forward env, or the test explicitly verifies hook-env behaviour).
 */

import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("suppressed", () => {
  test("git spawn with dotw-ignore on the preceding line", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-"));
    // dotw-ignore spec-git-env-spread: test intentionally inherits hook env to verify isolation behaviour
    Bun.spawnSync(["git", "-C", repo, "init", "-q"], { env: { ...process.env } });
  });
});
