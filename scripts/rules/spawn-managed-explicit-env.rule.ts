/**
 * Rule: spawn-managed-explicit-env
 *
 * Every `spawnManaged(cmd, args, opts)` call must pass an explicit `env`
 * field in `opts` — never omit it and rely on the implicit "inherit
 * process.env" fallback.
 *
 * That implicit fallback is NOT what it looks like. `Bun.spawn`'s
 * "inherit when `env` is omitted/undefined" behavior snapshots the
 * environment at Bun process *startup*, not the live `process.env`
 * object — a later in-JS mutation of `process.env` (e.g. a test preload
 * setting `MCP_CLI_DIR`, or `testOptions()`) is invisible to it. Passing
 * `env: process.env` explicitly instead reads the current value at spawn
 * time and is passed through correctly.
 *
 * This is exactly how #3233's second offender happened: `startDaemon()`
 * (packages/command/src/daemon-lifecycle.ts) called
 * `spawnManaged(bin, args, { stdout: "pipe", stderr: "pipe" })` with no
 * `env`. Under `bun test`, `test/preload-mcp-cli-isolation.ts` correctly
 * set `process.env.MCP_CLI_DIR` to a per-run temp dir — visible to
 * `options.MCP_CLI_DIR` in the SAME process — but the auto-started daemon
 * subprocess, spawned via the implicit-inherit path, silently got the
 * Bun-startup-time environment instead (no MCP_CLI_DIR at all), fell back
 * to deriving its state dir from the real `homedir()`, and collided with
 * the real production daemon's PID flock. Confirmed by reproduction: a
 * `Bun.spawn(cmd, { env: undefined })` call in a process that mutates
 * `process.env.X` after startup does NOT pass `X` through to the child;
 * `Bun.spawn(cmd, { env: process.env })` does.
 *
 * Scope: this rule is about `spawnManaged` specifically — the shared
 * long-lived-subprocess helper (`packages/core/src/subprocess.ts`) most
 * production call sites use to launch the daemon, agent-provider
 * processes, and worker subprocesses. Test files are exempt
 * (`appliesToTests: false`) — `subprocess.spec.ts`'s own unit tests spawn
 * generic system binaries (`echo`, `sleep`, `cat`, ...) to exercise
 * `spawnManaged`'s plumbing itself, not anything MCP_CLI_DIR-sensitive.
 *
 * `env: process.env` is enough — no need to merge in extra overrides
 * unless the call site has its own reason to (see `acp-process.ts`,
 * `codex-process.ts` for `{ ...process.env, ...opts.env }` examples).
 *
 * Suppression: `// dotw-ignore spawn-managed-explicit-env: <reason>` —
 * expected to be rare; a `spawnManaged` call that genuinely wants a
 * process with a Bun-startup-time (not live) environment snapshot is
 * unusual enough to deserve a comment explaining why.
 *
 * See #3233.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "spawn-managed-explicit-env",
  kind: "check",
  scold:
    "calls spawnManaged() without an explicit `env` — Bun's implicit-inherit fallback snapshots the environment at Bun startup, not the live process.env, so post-startup mutations (test isolation, MCP_CLI_DIR overrides) silently don't reach the child — see #3233",
  guidance: [
    "pass `env: process.env` explicitly in the spawnManaged() options object — reads the CURRENT process.env at spawn time, unlike the implicit fallback",
    "if the call site needs extra/overridden vars, merge them: `env: { ...process.env, ...extra }`",
    "suppress with // dotw-ignore spawn-managed-explicit-env: <reason> only if this spawn genuinely wants a Bun-startup-time environment snapshot rather than the live one",
  ],
  documentation: "#3233",
  appliesToTests: false,
  check({ violated, checked, ast }) {
    checked();

    for (const call of ast.callsTo("spawnManaged")) {
      const optsArg = call.arguments[2];
      if (!optsArg || !ts.isObjectLiteralExpression(optsArg)) {
        // No options object (or a non-literal, e.g. a spread/variable) at
        // all — can't tell statically whether env is set. Flag the missing
        // literal case (arguments.length < 3); leave a non-literal 3rd arg
        // (rare) alone rather than risk a false positive.
        if (call.arguments.length < 3) {
          const pos = ast.positionOf(call);
          violated(pos.line, pos.column, call.getText(ast.sourceFile).slice(0, 100));
        }
        continue;
      }
      const hasEnv = optsArg.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name &&
          ts.isIdentifier(p.name) &&
          p.name.text === "env",
      );
      if (!hasEnv) {
        const pos = ast.positionOf(call);
        violated(pos.line, pos.column, call.getText(ast.sourceFile).slice(0, 100));
      }
    }
  },
};

export default rule;
