import type { Stage } from "am-i-done";

import { type Ctx, joinOutputs, realRunner } from "./_lib/bun-test";
import { MAX_LEASE_WAIT_MS, withLease } from "./_lib/lease";
import { ORPHAN_TOLERANT_TEST_FILES, PARALLEL_FLAG } from "./_lib/test-paths";

/**
 * The developer suite, in three runs under one gate lease (#2690):
 *
 *   1. everything but packages/control and the orphan-tolerant files, `--parallel=N`;
 *   2. packages/control on its own, sequential (yoga-layout TDZ under --parallel, #2362);
 *   3. the orphan-tolerant files without `--no-orphans`, which would kill the real daemon
 *      test/stress.spec.ts detaches on purpose (#619).
 *
 * `--path-ignore-patterns` is repeated per file: one comma-joined pattern is a single literal glob.
 * CI runs the sequential partitions instead (test-non-daemon, test-daemon); pre-push runs
 * test-changed.
 */
export default {
  id: "test",
  description: "bun test: parallel suite, then packages/control, then the orphan-tolerant specs",
  phase: "test",
  modes: ["default"],
  cores: "max",
  timeoutMs: MAX_LEASE_WAIT_MS + 300_000,
  command: async (options) =>
    withLease(options, async () => {
      const run = realRunner(options);
      const ctx: Ctx = { root: options.root, logger: options.logger, run };
      const ignore = ORPHAN_TOLERANT_TEST_FILES.map((f) => `--path-ignore-patterns=${f}`);
      const runs = [
        ["test", PARALLEL_FLAG, "--no-orphans", "--path-ignore-patterns=packages/control/**", ...ignore],
        ["test", "--no-orphans", "packages/control"],
        ["test", ...ORPHAN_TOLERANT_TEST_FILES],
      ];
      const results = [];
      for (const argv of runs) {
        const outcome = await ctx.run([...argv, ...options.args], { cwd: options.root, junit: false });
        const result = { output: outcome.output, success: outcome.code === 0 };
        results.push(result);
        if (!result.success)
          return { success: false, error: `bun ${argv.join(" ")}: exit ${outcome.code}`, output: joinOutputs(results) };
      }
      return { success: true, output: joinOutputs(results) };
    }),
  onFailure: [
    "rerun one file: bun test --no-orphans <path>",
    "CI runs the sequential partitions: bun run am-i-done --ci",
  ],
} satisfies Stage;
