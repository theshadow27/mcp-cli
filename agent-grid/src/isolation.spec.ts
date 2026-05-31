import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

    writeFileSync(join(env1.dir, "env1-only.txt"), "hello");
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

  test("cleanGitEnv strips poisoned GIT_* vars and isolates from host gitconfig", () => {
    const original = process.env.GIT_DIR;
    const originalIdx = process.env.GIT_INDEX_FILE;
    const originalWork = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = "/tmp/bogus";
      process.env.GIT_INDEX_FILE = "/tmp/bogus-index";
      process.env.GIT_WORK_TREE = "/tmp/bogus-tree";

      const env = cleanGitEnv();

      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();

      expect(env.GIT_AUTHOR_NAME).toBe("agent-grid");
      expect(env.GIT_COMMITTER_NAME).toBe("agent-grid");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    } finally {
      if (original === undefined) process.env.GIT_DIR = undefined;
      else process.env.GIT_DIR = original;
      if (originalIdx === undefined) process.env.GIT_INDEX_FILE = undefined;
      else process.env.GIT_INDEX_FILE = originalIdx;
      if (originalWork === undefined) process.env.GIT_WORK_TREE = undefined;
      else process.env.GIT_WORK_TREE = originalWork;
    }
  });

  test("env creation works under poisoned GIT_DIR", () => {
    const original = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = "/tmp/does-not-exist";
      using env = createIsolatedEnv();
      dirs.push(env.dir);

      expect(existsSync(join(env.dir, ".git"))).toBe(true);
      expect(gitStatus(env.dir)).toBe("");
    } finally {
      if (original === undefined) process.env.GIT_DIR = undefined;
      else process.env.GIT_DIR = original;
    }
  });

  test("failed git init cleans up tmpdir and propagates error", () => {
    const before = activeEnvCount();
    const origPath = process.env.PATH ?? "";
    try {
      process.env.PATH = "/nonexistent-path-for-agent-grid-test";
      expect(() => createIsolatedEnv()).toThrow();
    } finally {
      process.env.PATH = origPath;
    }

    expect(activeEnvCount()).toBe(before);
  });

  // Regression for the #2586 SIGTERM-immortality bug: a process that imported
  // createIsolatedEnv() (which installs the interrupt handlers) MUST still die
  // on SIGTERM. The original handler re-raised the signal into a listener it
  // failed to remove, looping forever — only SIGKILL stopped it, which is what
  // made bun test-workers look "wedged" and hung check-no-claude for 96 min.
  test("a process importing createIsolatedEnv still dies on SIGTERM (not immortal)", async () => {
    const isoPath = join(import.meta.dir, "isolation.ts");
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const { createIsolatedEnv } = await import(${JSON.stringify(isoPath)});createIsolatedEnv().cleanup();console.log("READY");await new Promise(() => {});`,
      ],
      stdout: "pipe",
      stderr: "ignore",
    });

    // Wait for the child to confirm handlers are installed, then SIGTERM it.
    const reader = proc.stdout.getReader();
    await reader.read();
    proc.kill("SIGTERM");

    // A correct handler exits promptly. An immortal process never resolves
    // `exited`; race a deadline and treat the timeout as the failure signal.
    const DEADLINE_MS = 3_000;
    const verdict = await Promise.race([
      proc.exited.then(() => "exited" as const),
      Bun.sleep(DEADLINE_MS).then(() => "immortal" as const),
    ]);
    if (verdict === "immortal") proc.kill("SIGKILL");
    expect(verdict).toBe("exited");
  });
});
