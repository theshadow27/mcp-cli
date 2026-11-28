/**
 * How the suite is split across `bun test` runs. Adding a package directory means adding it to one
 * of the CI partitions; `test-paths.spec.ts` fails until every spec belongs to exactly one.
 */

export { ORPHAN_TOLERANT_TEST_FILES } from "../../orphan-tolerant-tests";
export { PARALLEL_FLAG } from "../../test-parallelism";

/** CI's first run: everything that does not start a daemon. */
export const NON_DAEMON_TEST_PATHS = [
  "packages/acp",
  "packages/clone",
  "packages/codex",
  "packages/command",
  "packages/control",
  "packages/core",
  "packages/opencode",
  "packages/permissions",
  "scripts/",
  "agent-grid/",
];

/** CI's second run: the daemon and the integration tests. */
export const DAEMON_TEST_PATHS = ["packages/daemon", "test/"];

/** Specs the root bunfig.toml ignores, run from their own directory instead (#2648, #2771). */
export const DIR_SCOPED_SPEC_DIRS = { phases: ".claude/phases", hooks: ".git-hooks" } as const;
