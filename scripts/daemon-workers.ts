/**
 * mcpd worker entrypoints — must be listed explicitly so `bun build --compile`
 * embeds them. Each name here corresponds to a `workerPath(...)` /
 * `workerScript: ...` reference in `packages/daemon/src`; the daemon resolves
 * them via `./<name>` at runtime in compiled mode (see `worker-path.ts`).
 *
 * A worker missing from this list builds fine but fails at runtime with
 * `ModuleNotFound resolving "./<name>" (entry point)` the moment its server is
 * started. `daemon-workers.spec.ts` guards against that by asserting every
 * referenced worker appears here.
 */
export const daemonWorkers = [
  "packages/daemon/src/alias-executor.ts",
  "packages/daemon/src/claude-session-worker.ts",
  "packages/daemon/src/codex-session-worker.ts",
  "packages/daemon/src/acp-session-worker.ts",
  "packages/daemon/src/opencode-session-worker.ts",
  "packages/daemon/src/mock-session-worker.ts",
  "packages/daemon/src/monitor-executor.ts",
  "packages/daemon/src/site-worker.ts",
];
