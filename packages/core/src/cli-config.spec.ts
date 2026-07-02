import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { prunePromptedDirs, readCliConfig, writeCliConfig } from "./cli-config";

describe("readCliConfig", () => {
  test("returns {} when file is missing", () => {
    using _opts = testOptions();
    expect(readCliConfig()).toEqual({});
  });

  test("returns {} on malformed JSON", () => {
    using _opts = testOptions({ files: { "config.json": "not json{{{" } });
    expect(readCliConfig()).toEqual({});
  });

  test("parses valid JSON", () => {
    const config = { trustClaude: true, terminal: "ghostty" };
    using _opts = testOptions({ files: { "config.json": config } });
    expect(readCliConfig()).toEqual(config);
  });

  test("parses wsPort as number", () => {
    const config = { wsPort: 19275 };
    using _opts = testOptions({ files: { "config.json": config } });
    expect(readCliConfig()).toEqual(config);
    expect(readCliConfig().wsPort).toBe(19275);
  });
});

describe("prunePromptedDirs", () => {
  test("keeps existing dirs and drops missing ones", () => {
    using opts = testOptions();
    const alive = join(opts.dir, "alive");
    mkdirSync(alive, { recursive: true });
    const dead = join(opts.dir, "worktrees", "claude-gone");

    expect(prunePromptedDirs([alive, dead])).toEqual([alive]);
  });

  test("returns empty array when all dirs are stale", () => {
    using opts = testOptions();
    expect(prunePromptedDirs([join(opts.dir, "a"), join(opts.dir, "b")])).toEqual([]);
  });

  test("preserves order of surviving dirs", () => {
    using opts = testOptions();
    const a = join(opts.dir, "a");
    const c = join(opts.dir, "c");
    mkdirSync(a, { recursive: true });
    mkdirSync(c, { recursive: true });

    expect(prunePromptedDirs([a, join(opts.dir, "b"), c])).toEqual([a, c]);
  });
});

describe("writeCliConfig", () => {
  test("creates parent directory and writes JSON with trailing newline", () => {
    using opts = testOptions();
    const config = { trustClaude: false };

    writeCliConfig(config);

    const content = readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8");
    expect(content).toBe(`${JSON.stringify(config, null, 2)}\n`);
    expect(content.endsWith("\n")).toBe(true);
  });

  test("overwrites existing config", () => {
    using opts = testOptions({ files: { "config.json": { trustClaude: true } } });

    writeCliConfig({ terminal: "iterm" });

    const result = JSON.parse(readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8"));
    expect(result).toEqual({ terminal: "iterm" });
    expect(result.trustClaude).toBeUndefined();
  });

  test("creates nested parent directories", () => {
    using opts = testOptions();
    // testOptions already sets MCP_CLI_CONFIG_PATH inside temp dir
    // writeCliConfig should create the dir if it doesn't exist
    writeCliConfig({ trustClaude: true });

    const content = readFileSync(opts.MCP_CLI_CONFIG_PATH, "utf-8");
    expect(JSON.parse(content)).toEqual({ trustClaude: true });
  });
});
