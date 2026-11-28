import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StageFunction } from "am-i-done";

import { type Ctx, checkDiscoveryFloor, realRunner, testTolerantNoRetry } from "./bun-test";

export function countSpecFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const _ of new Bun.Glob("**/*.spec.ts").scanSync({ cwd: dir })) count++;
  return count;
}

/**
 * `bun test --no-orphans` run from inside a spec directory the root bunfig.toml ignores
 * (`.claude/phases` #2648, `.git-hooks` #2771), so its specs are found relative to that cwd. It
 * fails closed when fewer specs ran than exist on disk (#2719), and tolerates a #1004 crash after
 * a clean summary.
 */
export async function dirScopedRun(ctx: Ctx, specDir: string, logName: string) {
  const dir = join(ctx.root, specDir);
  const specCount = countSpecFiles(dir);
  if (specCount === 0) return { success: false, error: `0 spec files found in ${specDir} — renamed or moved? (#2719)` };
  const result = await testTolerantNoRetry(ctx, { argv: ["test", "--no-orphans"], name: logName, cwd: dir });
  if (!result.success) return { success: false, error: result.error, output: result.output };
  const floor = checkDiscoveryFloor(result.outcome, specCount);
  return { ...floor, output: result.output };
}

export function dirScoped(specDir: string, logName: string): StageFunction {
  return (options) =>
    dirScopedRun({ root: options.root, logger: options.logger, run: realRunner(options) }, specDir, logName);
}
