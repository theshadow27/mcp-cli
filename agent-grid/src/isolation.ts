import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_FILE = "README.md";
const SEED_CONTENT = "# agent-grid test seed\n";
const SEED_MESSAGE = "seed";

const activeEnvs = new Set<string>();
let handlersInstalled = false;

function installInterruptHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const cleanup = () => {
    for (const dir of activeEnvs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort on interrupt
      }
    }
    activeEnvs.clear();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
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
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: cleanGitEnv(),
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
    Bun.write(join(dir, SEED_FILE), SEED_CONTENT);
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
