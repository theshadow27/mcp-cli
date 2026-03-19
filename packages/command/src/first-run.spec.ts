import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { maybeShowFirstRunPrompt } from "./first-run";

let tmpDir: string;
let configDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `first-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  configDir = join(tmpDir, "mcp-cli");
  mkdirSync(configDir, { recursive: true });

  // Point options to temp dirs for isolation
  options.MCP_CLI_DIR = configDir;
  options.MCP_CLI_CONFIG_PATH = join(configDir, "config.json");
  options.PROJECTS_DIR = join(configDir, "projects");
});

afterEach(() => {
  _restoreOptions();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("maybeShowFirstRunPrompt", () => {
  test("shows prompt when .mcp.json exists and no project config", () => {
    const mcpJson = { mcpServers: { github: { command: "gh" }, notion: { command: "notion" } } };
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify(mcpJson));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("Found .mcp.json with 2 server(s)");
    expect(errors[0]).toContain("github");
    expect(errors[0]).toContain("notion");
    expect(errors[1]).toContain("mcx import");
  });

  test("does not show prompt when no .mcp.json", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors.length).toBe(0);
  });

  test("does not show prompt when project config already exists", () => {
    const mcpJson = { mcpServers: { github: { command: "gh" } } };
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify(mcpJson));

    // Create project config
    const projDir = join(configDir, "projects", tmpDir.replaceAll("/", "_").replace(/^_/, ""));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "servers.json"), "{}");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors.length).toBe(0);
  });

  test("shows prompt only once per directory", () => {
    const mcpJson = { mcpServers: { github: { command: "gh" } } };
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify(mcpJson));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
      errors.length = 0; // reset
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    // Second call should produce no output
    expect(errors.length).toBe(0);
  });

  test("does not show prompt for empty mcpServers", () => {
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors.length).toBe(0);
  });

  test("truncates long server lists", () => {
    const servers: Record<string, { command: string }> = {};
    for (let i = 0; i < 8; i++) servers[`server${i}`] = { command: `cmd${i}` };
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors[0]).toContain("8 server(s)");
    expect(errors[0]).toContain("...");
  });

  test("handles malformed .mcp.json gracefully", () => {
    writeFileSync(join(tmpDir, ".mcp.json"), "not valid json{{{");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      maybeShowFirstRunPrompt(tmpDir);
    } finally {
      console.error = origError;
    }

    expect(errors.length).toBe(0);
  });
});
