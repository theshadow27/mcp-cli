import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeEnvCount, cleanGitEnv, createIsolatedEnv } from "./isolation";

function gitLog(cwd: string): string {
  const r = spawnSync("git", ["log", "--oneline"], { cwd, stdio: ["ignore", "pipe", "ignore"], env: cleanGitEnv() });
  return r.stdout?.toString().trim() ?? "";
}

function gitStatus(cwd: string): string {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env: cleanGitEnv(),
  });
  return r.stdout?.toString().trim() ?? "";
}

describe("createIsolatedEnv", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        Bun.spawnSync(["rm", "-rf", d]);
      } catch {
        // already cleaned
      }
    }
    dirs = [];
  });

  test("creates a tmpdir with a git repo and seed commit", () => {
    using env = createIsolatedEnv();
    dirs.push(env.dir);

    expect(existsSync(env.dir)).toBe(true);
    expect(existsSync(join(env.dir, ".git"))).toBe(true);

    const readme = readFileSync(join(env.dir, "README.md"), "utf-8");
    expect(readme).toBe("# agent-grid test seed\n");

    const log = gitLog(env.dir);
    expect(log).toContain("seed");

    expect(gitStatus(env.dir)).toBe("");
  });

  test("cleanup removes the directory", () => {
    const env = createIsolatedEnv();
    const { dir } = env;
    dirs.push(dir);

    expect(existsSync(dir)).toBe(true);
    env.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  test("Symbol.dispose removes the directory", () => {
    let savedDir = "";
    {
      using env = createIsolatedEnv();
      savedDir = env.dir;
      dirs.push(savedDir);
      expect(existsSync(savedDir)).toBe(true);
    }
    expect(existsSync(savedDir)).toBe(false);
  });

  test("environments are independent", () => {
    using env1 = createIsolatedEnv();
    using env2 = createIsolatedEnv();
    dirs.push(env1.dir, env2.dir);

    expect(env1.dir).not.toBe(env2.dir);

    Bun.write(join(env1.dir, "env1-only.txt"), "hello");
    expect(existsSync(join(env1.dir, "env1-only.txt"))).toBe(true);
    expect(existsSync(join(env2.dir, "env1-only.txt"))).toBe(false);
  });

  test("activeEnvCount tracks live environments", () => {
    const before = activeEnvCount();
    const env = createIsolatedEnv();
    dirs.push(env.dir);

    expect(activeEnvCount()).toBe(before + 1);
    env.cleanup();
    expect(activeEnvCount()).toBe(before);
  });

  test("cleanup is idempotent", () => {
    const env = createIsolatedEnv();
    dirs.push(env.dir);

    env.cleanup();
    expect(() => env.cleanup()).not.toThrow();
  });

  test("seed commit is on main branch", () => {
    using env = createIsolatedEnv();
    dirs.push(env.dir);

    const r = spawnSync("git", ["branch", "--show-current"], {
      cwd: env.dir,
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitEnv(),
    });
    expect(r.stdout?.toString().trim()).toBe("main");
  });
});
