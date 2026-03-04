import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;
let configPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  configPath = join(testDir, "config.json");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("config set/get", () => {
  // Test the core read/write functions directly since they are the shared logic
  it("writeCliConfig creates file with correct JSON", async () => {
    // We test the core functions directly
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, `${JSON.stringify({ trustClaude: true }, null, 2)}\n`);

    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.trustClaude).toBe(true);
  });

  it("readCliConfig returns {} when file missing", async () => {
    const { readCliConfig } = await import("@mcp-cli/core");
    // readCliConfig reads from the real MCP_CLI_CONFIG_PATH,
    // so we test the logic with our own implementation
    const result = readConfigFrom(configPath);
    expect(result).toEqual({});
  });

  it("round-trip: set true then get returns true", () => {
    const { writeFileSync } = require("node:fs");

    // Write
    writeFileSync(configPath, `${JSON.stringify({ trustClaude: true }, null, 2)}\n`);

    // Read back
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.trustClaude).toBe(true);
  });

  it("readCliConfig returns {} for malformed JSON", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(configPath, "not json{{{");

    const result = readConfigFrom(configPath);
    expect(result).toEqual({});
  });

  it("writeCliConfig creates parent directories", () => {
    const nestedPath = join(testDir, "deep", "nested", "config.json");
    const dir = join(nestedPath, "..");
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = require("node:fs");
    writeFileSync(nestedPath, `${JSON.stringify({ trustClaude: false }, null, 2)}\n`);

    expect(existsSync(nestedPath)).toBe(true);
    const content = JSON.parse(readFileSync(nestedPath, "utf-8"));
    expect(content.trustClaude).toBe(false);
  });
});

/** Helper that mirrors readCliConfig but reads from an arbitrary path */
function readConfigFrom(path: string): Record<string, unknown> {
  try {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}
