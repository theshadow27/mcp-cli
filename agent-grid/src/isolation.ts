import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_FILE = "README.md";
const SEED_CONTENT = "# agent-grid test seed\n";
const SEED_MESSAGE = "seed";

const activeEnvs = new Set<string>();
let handlersInstalled = false;

function cleanupAllEnvs(): void {
  for (const dir of activeEnvs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on interrupt
    }
  }
  activeEnvs.clear();
}

/**
 * Interrupt handler body: clean up active environments, then re-raise the
 * signal so the process terminates with its default disposition. `terminate`
 * is injectable so tests can exercise the cleanup + re-raise path without the
 * real `process.kill(self, signal)` tearing down the test runner.
 *
 * Exported for testing.
 */
export function onInterrupt(
  signal: NodeJS.Signals,
  terminate: (s: NodeJS.Signals) => void = (s) => process.kill(process.pid, s),
): void {
  cleanupAllEnvs();
  terminate(signal);
}

function installInterruptHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Use `once`: Node removes the listener *before* invoking it, so the
  // subsequent re-raise (in onInterrupt) hits the default disposition and the
  // process actually terminates. The previous `on(...)` +
  // `removeListener(signal, onSignal)` form passed the wrong reference (the
  // registered listener was the arrow wrapper, not `onSignal`), so removal was
  // a no-op and `process.kill(self, signal)` re-entered the still-installed
  // handler forever — the process became immortal under SIGINT/SIGTERM (#2586
  // regression; only SIGKILL stopped it, which is what made test workers look
  // "wedged").
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => onInterrupt(signal));
  }
}

export function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  env.GIT_AUTHOR_NAME = "agent-grid";
  env.GIT_AUTHOR_EMAIL = "agent-grid@test";
  env.GIT_COMMITTER_NAME = "agent-grid";
  env.GIT_COMMITTER_EMAIL = "agent-grid@test";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: cleanGitEnv(),
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${stderr}`);
  }
}

/** An isolated test environment with a fresh tmpdir and seeded git repo. */
export interface IsolatedEnv {
  /** Absolute path to the isolated directory (git work tree root). */
  dir: string;
  /** Remove the directory and deregister from interrupt cleanup. */
  cleanup(): void;
  [Symbol.dispose](): void;
}

/**
 * Create an isolated test environment: a fresh tmpdir with `git init` and
 * a single seed commit. The returned object supports both explicit
 * `cleanup()` and `using` via `Symbol.dispose`.
 *
 * Interrupt handlers (SIGINT/SIGTERM) are installed once per process to
 * clean up any active environments on unexpected exit.
 */
export function createIsolatedEnv(): IsolatedEnv {
  installInterruptHandlers();

  const dir = mkdtempSync(join(tmpdir(), "agent-grid-"));

  activeEnvs.add(dir);

  try {
    git(dir, ["init", "-b", "main"]);
    writeFileSync(join(dir, SEED_FILE), SEED_CONTENT);
    git(dir, ["add", SEED_FILE]);
    git(dir, ["commit", "-m", SEED_MESSAGE]);
  } catch (e) {
    activeEnvs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const cleanup = () => {
    activeEnvs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    cleanup,
    [Symbol.dispose]() {
      cleanup();
    },
  };
}

/** Number of currently-tracked isolated environments (for testing). */
export function activeEnvCount(): number {
  return activeEnvs.size;
}
