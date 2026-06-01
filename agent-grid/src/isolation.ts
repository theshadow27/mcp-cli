import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_FILE = "README.md";
const SEED_CONTENT = "# agent-grid test seed\n";
const SEED_MESSAGE = "seed";

const activeEnvs = new Set<string>();

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
  /** Remove the directory and deregister it from the active-env set. */
  cleanup(): void;
  [Symbol.dispose](): void;
}

/**
 * Create an isolated test environment: a fresh tmpdir with `git init` and
 * a single seed commit. The returned object supports both explicit
 * `cleanup()` and `using` via `Symbol.dispose`.
 *
 * No process-wide signal handler is installed: tmpdir cleanup is handled by
 * explicit `cleanup()` / `Symbol.dispose` / test `afterEach`, and the OS
 * reclaims `/tmp` on process exit. A library used under `bun test` must never
 * install global SIGINT/SIGTERM handlers on the shared runner (that caused the
 * #2586 SIGTERM-immortality bug).
 */
export function createIsolatedEnv(): IsolatedEnv {
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
