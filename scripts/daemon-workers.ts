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
 *
 * The compile command must also pass `--root=packages/daemon/src`: Bun's
 * default output root is computed from the entrypoint set and silently shifts
 * with the entrypoint COUNT (Bun 1.3.14: ≤8 flat, ≥9 nested under the cwd-
 * relative source path), which breaks compiled-mode `./<name>.ts` resolution
 * for every worker at once. `scripts/build.ts` pins --root and smoke-boots
 * the compiled binary after every build to verify the embedded layout.
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
