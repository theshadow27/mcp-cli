import { spawnSync } from "node:child_process";

import { type Ctx, joinOutputs, testTolerantNoRetry } from "./bun-test";
import { ORPHAN_TOLERANT_TEST_FILES, PARALLEL_FLAG } from "./test-paths";

/**
 * The ref to diff against: the merge-base with origin/main (what the change proposes to merge
 * into), else with the upstream (incremental pushes), else with local main, else HEAD~1.
 */
export function resolveBase(cwd: string): string {
  for (const ref of ["origin/main", "@{upstream}", "main"]) {
    const r = spawnSync("git", ["merge-base", ref, "HEAD"], { cwd, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return "HEAD~1";
}

/**
 * Diff-aware tests for the pre-push gate (#2393): only the specs Bun's module graph says the diff
 * reaches (`bun test --changed=<base>`), in the same three runs as the developer suite (parallel
 * without control; control sequential, #2362; orphan-tolerant without --no-orphans, #619). A diff
 * that reaches no spec passes (`--pass-with-no-tests`). Each run tolerates a #1004 crash after a
 * clean summary, without a retry. CI runs the whole suite and the coverage ratchet.
 */
export async function changedRuns(ctx: Ctx, base: string) {
  ctx.logger.info(`diff-aware: running tests affected by changes since ${base} (bun test --changed)`);
  const changed = `--changed=${base}`;
  const ignore = ORPHAN_TOLERANT_TEST_FILES.map((f) => `--path-ignore-patterns=${f}`);
  const runs = [
    {
      name: "test_changed",
      argv: ["test", "--no-orphans", changed, PARALLEL_FLAG, "--path-ignore-patterns=packages/control/**", ...ignore],
    },
    { name: "test_changed_control", argv: ["test", "--no-orphans", changed, "packages/control"] },
    { name: "test_changed_orphan_tolerant", argv: ["test", changed, ...ORPHAN_TOLERANT_TEST_FILES] },
  ];
  const results = [];
  for (const run of runs) {
    const result = await testTolerantNoRetry(ctx, {
      argv: [...run.argv, "--pass-with-no-tests"],
      name: run.name,
      cwd: ctx.root,
    });
    results.push(result);
    if (!result.success) return { success: false, error: `${run.name}: ${result.error}`, output: joinOutputs(results) };
  }
  return { success: true, output: joinOutputs(results) };
}
