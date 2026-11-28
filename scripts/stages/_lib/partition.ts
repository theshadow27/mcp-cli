import type { StageFunction } from "am-i-done";

import { type Ctx, joinOutputs, realRunner, testWithCrashTolerance } from "./bun-test";
import { ORPHAN_TOLERANT_TEST_FILES } from "./test-paths";

/** Which orphan-tolerant files a path selection reaches: listed exactly, or under a listed directory. */
export function orphanTolerantSubset(paths: readonly string[]): string[] {
  return ORPHAN_TOLERANT_TEST_FILES.filter((f) =>
    paths.some((p) => p === f || f.startsWith(p.endsWith("/") ? p : `${p}/`)),
  );
}

/**
 * `bun test --no-orphans <paths>` with the #1004 tolerance. Orphan-tolerant files under `paths`
 * are ignored there and run on their own afterwards without `--no-orphans` (#619); both must pass.
 */
export function partitionRun(ctx: Ctx, paths: readonly string[], logName: string) {
  return async () => {
    const tolerant = orphanTolerantSubset(paths);
    const ignore = tolerant.map((f) => `--path-ignore-patterns=${f}`);
    const main = await testWithCrashTolerance(ctx, {
      argv: ["test", "--no-orphans", ...paths, ...ignore],
      name: logName,
      cwd: ctx.root,
    });
    if (!main.success || tolerant.length === 0) return main;
    ctx.logger.info(`running orphan-tolerant tests separately (no --no-orphans, #619): ${tolerant.join(", ")}`);
    const rest = await testWithCrashTolerance(ctx, {
      argv: ["test", ...tolerant],
      name: `${logName}_orphan_tolerant`,
      cwd: ctx.root,
    });
    return { ...rest, output: joinOutputs([main, rest]) };
  };
}

export function ciPartition(paths: readonly string[], logName: string): StageFunction {
  return async (options) => {
    const ctx: Ctx = { root: options.root, logger: options.logger, run: realRunner(options) };
    const { outcome: _, ...result } = await partitionRun(ctx, paths, logName)();
    return result;
  };
}
