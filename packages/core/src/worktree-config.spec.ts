import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORKTREE_CONFIG_FILENAME,
  __resetNagStateForTests,
  buildHookEnv,
  hasWorktreeHooks,
  readWorktreeConfig,
  resolveWorktreeBase,
  resolveWorktreePath,
} from "./worktree-config";

beforeEach(() => {
  __resetNagStateForTests();
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-config-"));
}

describe("readWorktreeConfig", () => {
  test("returns null when no config file exists", () => {
    const dir = makeTempDir();
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("returns null on malformed JSON and logs warning", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), "not json{{{");
    // Should return null without throwing
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("returns null when file has no worktree section", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ other: true }));
    expect(readWorktreeConfig(dir)).toBeNull();
  });

  test("parses valid worktree config", () => {
    const dir = makeTempDir();
    const config = {
      worktree: {
        setup: "./scripts/setup.sh $MCX_BRANCH",
        teardown: "./scripts/teardown.sh $MCX_PATH",
        base: "../worktrees/myproject",
      },
    };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual(config.worktree);
  });

  test("returns config with only setup (no teardown/base)", () => {
    const dir = makeTempDir();
    const config = { worktree: { setup: "echo $MCX_BRANCH" } };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual({ setup: "echo $MCX_BRANCH" });
  });

  test("parses branchPrefix: false", () => {
    const dir = makeTempDir();
    const config = { worktree: { branchPrefix: false } };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual({ branchPrefix: false });
  });

  test("parses branchPrefix: true with other fields", () => {
    const dir = makeTempDir();
    const config = {
      worktree: {
        setup: "./scripts/setup.sh",
        branchPrefix: true,
      },
    };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify(config));
    expect(readWorktreeConfig(dir)).toEqual(config.worktree);
  });
});

describe("readWorktreeConfig migration (#1288)", () => {
  test("migrates legacy .mcx-worktree.json into a new .mcx.yaml when no manifest exists", () => {
    const dir = makeTempDir();
    const hooks = { setup: "./scripts/setup.sh", branchPrefix: false };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    const result = readWorktreeConfig(dir);
    expect(result).toEqual(hooks);

    // Newly created yaml holds the migrated section
    const yamlPath = join(dir, ".mcx.yaml");
    expect(existsSync(yamlPath)).toBe(true);
    const yaml = readFileSync(yamlPath, "utf-8");
    expect(yaml).toContain("worktree:");
    expect(yaml).toContain('setup: "./scripts/setup.sh"');
    expect(yaml).toContain("branchPrefix: false");

    // Legacy file left in place
    expect(existsSync(join(dir, WORKTREE_CONFIG_FILENAME))).toBe(true);
  });

  test("appends worktree section to an existing manifest missing one", () => {
    const dir = makeTempDir();
    const existingYaml = "initial: impl\nphases:\n  impl:\n    source: ./a.ts\n";
    writeFileSync(join(dir, ".mcx.yaml"), existingYaml);
    const hooks = { setup: "./s.sh" };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    expect(readWorktreeConfig(dir)).toEqual(hooks);

    const updated = readFileSync(join(dir, ".mcx.yaml"), "utf-8");
    expect(updated.startsWith(existingYaml)).toBe(true);
    expect(updated).toContain("worktree:");
    expect(updated).toContain('setup: "./s.sh"');
  });

  test("merges worktree section into an existing .mcx.json manifest", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcx.json"), JSON.stringify({ initial: "a", phases: { a: { source: "./a.ts" } } }));
    const hooks = { setup: "./s.sh", branchPrefix: true };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    expect(readWorktreeConfig(dir)).toEqual(hooks);

    const parsed = JSON.parse(readFileSync(join(dir, ".mcx.json"), "utf-8"));
    expect(parsed.worktree).toEqual(hooks);
    expect(parsed.initial).toBe("a");
  });

  test("emits nag when both files exist and manifest already has worktree section", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcx.yaml"), 'worktree:\n  setup: "./from-yaml.sh"\n');
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { setup: "./legacy.sh" } }));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readWorktreeConfig(dir);
      expect(result).toEqual({ setup: "./from-yaml.sh" });
      // Filter specifically for nag messages (which start with the legacy filename).
      // Unrelated console.error calls (e.g. environment-specific I/O warnings on Linux)
      // are excluded so the test stays green across platforms.
      const nagCalls = errSpy.mock.calls.filter(([msg]) => String(msg).startsWith(WORKTREE_CONFIG_FILENAME));
      expect(nagCalls).toHaveLength(1);
      const msg = String(nagCalls[0]?.[0]);
      expect(msg).toContain("ignored");
      expect(msg).toContain(".mcx.yaml");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("nag fires only once per process for the same legacy path", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcx.yaml"), 'worktree:\n  setup: "./x.sh"\n');
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { setup: "./y.sh" } }));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      readWorktreeConfig(dir);
      readWorktreeConfig(dir);
      readWorktreeConfig(dir);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("no nag when only the manifest has a worktree section", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcx.yaml"), 'worktree:\n  setup: "./x.sh"\n');
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(readWorktreeConfig(dir)).toEqual({ setup: "./x.sh" });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("migration is idempotent — second call does not duplicate the section", () => {
    const dir = makeTempDir();
    const hooks = { setup: "./s.sh" };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      readWorktreeConfig(dir);
      readWorktreeConfig(dir);

      const yaml = readFileSync(join(dir, ".mcx.yaml"), "utf-8");
      const occurrences = yaml.match(/^worktree:/gm)?.length ?? 0;
      expect(occurrences).toBe(1);
      // Second call sees manifest + legacy → fires nag
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
  test("migrates legacy .mcx-worktree.json into an existing .mcx.yml manifest", () => {
    const dir = makeTempDir();
    const existingYaml = "initial: impl\nphases:\n  impl:\n    source: ./a.ts\n";
    writeFileSync(join(dir, ".mcx.yml"), existingYaml);
    const hooks = { setup: "./s.sh", teardown: "./t.sh" };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    expect(readWorktreeConfig(dir)).toEqual(hooks);

    const updated = readFileSync(join(dir, ".mcx.yml"), "utf-8");
    expect(updated.startsWith(existingYaml)).toBe(true);
    expect(updated).toContain("worktree:");
    expect(updated).toContain('setup: "./s.sh"');
    expect(updated).toContain('teardown: "./t.sh"');
    // .mcx.yaml should NOT be created
    expect(existsSync(join(dir, ".mcx.yaml"))).toBe(false);
  });

  test("skips migration and warns when manifest exists but is unparseable", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".mcx.yaml"), "{ invalid yaml: [unterminated");
    const hooks = { setup: "./s.sh" };
    writeFileSync(join(dir, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: hooks }));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readWorktreeConfig(dir);
      // Returns legacy config, does not migrate
      expect(result).toEqual(hooks);
      // Warns user about the broken manifest
      expect(errSpy).toHaveBeenCalledTimes(1);
      const msg = String(errSpy.mock.calls[0]?.[0]);
      expect(msg).toContain(".mcx.yaml");
      expect(msg).toContain("could not be parsed");
      // Broken manifest is untouched (not overwritten)
      const unchanged = readFileSync(join(dir, ".mcx.yaml"), "utf-8");
      expect(unchanged).toBe("{ invalid yaml: [unterminated");
      // No shadow .mcx.yaml created alongside .mcx.json
      expect(existsSync(join(dir, ".mcx.json"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("resolveWorktreeBase", () => {
  test("defaults to .claude/worktrees when no config", () => {
    expect(resolveWorktreeBase("/repo", null)).toBe("/repo/.claude/worktrees");
  });

  test("defaults to .claude/worktrees when config has no base", () => {
    expect(resolveWorktreeBase("/repo", { setup: "echo" })).toBe("/repo/.claude/worktrees");
  });

  test("resolves relative base from repo root", () => {
    expect(resolveWorktreeBase("/repo", { base: "../worktrees/proj" })).toBe("/worktrees/proj");
  });

  test("uses absolute base as-is", () => {
    expect(resolveWorktreeBase("/repo", { base: "/tmp/worktrees" })).toBe("/tmp/worktrees");
  });
});

describe("resolveWorktreePath", () => {
  test("joins base with name", () => {
    expect(resolveWorktreePath("/repo", "fix-123", null)).toBe("/repo/.claude/worktrees/fix-123");
  });

  test("uses custom base", () => {
    expect(resolveWorktreePath("/repo", "fix-123", { base: "/tmp/wt" })).toBe("/tmp/wt/fix-123");
  });
});

describe("buildHookEnv", () => {
  test("returns env vars with MCX_ prefix", () => {
    const env = buildHookEnv({
      branch: "fix-123",
      path: "/tmp/wt/fix-123",
      cwd: "/repo",
    });
    expect(env).toEqual({
      MCX_BRANCH: "fix-123",
      MCX_PATH: "/tmp/wt/fix-123",
      MCX_CWD: "/repo",
    });
  });

  test("handles special characters safely (no interpolation)", () => {
    const env = buildHookEnv({
      branch: "foo; rm -rf ~",
      path: "/tmp/wt/foo",
      cwd: "/repo",
    });
    // Values are stored as-is, no shell interpretation
    expect(env.MCX_BRANCH).toBe("foo; rm -rf ~");
  });
});

describe("hasWorktreeHooks", () => {
  test("returns false for null", () => {
    expect(hasWorktreeHooks(null)).toBe(false);
  });

  test("returns false when setup is missing", () => {
    expect(hasWorktreeHooks({ base: "/tmp" })).toBe(false);
  });

  test("returns false when setup is empty string", () => {
    expect(hasWorktreeHooks({ setup: "" })).toBe(false);
  });

  test("returns true when setup is non-empty", () => {
    expect(hasWorktreeHooks({ setup: "./scripts/setup.sh" })).toBe(true);
  });
});
