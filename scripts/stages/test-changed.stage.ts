import type { Stage } from "am-i-done";

import { realRunner } from "./_lib/bun-test";
import { changedRuns, resolveBase } from "./_lib/changed";
import { MAX_LEASE_WAIT_MS, withLease } from "./_lib/lease";

export default {
  id: "test-changed",
  description: "diff-aware tests: only specs the diff reaches (bun test --changed)",
  phase: "test",
  modes: ["pre-push"],
  cores: "max",
  timeoutMs: MAX_LEASE_WAIT_MS + 300_000,
  command: async (options) =>
    withLease(options, () =>
      changedRuns({ root: options.root, logger: options.logger, run: realRunner(options) }, resolveBase(options.root)),
    ),
  onFailure: [
    "this runs only the specs in your diff's reach; CI (`--ci`) runs the whole suite and coverage",
    "to reproduce a CI-only failure locally: bun run am-i-done --ci",
    "a changed worker or alias file can reach 0 specs: Bun's module graph cannot follow dynamic imports or path-string worker loads, so run `bun run am-i-done --ci` before pushing (#2396)",
  ],
} satisfies Stage;
