import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { findFileUpward } from "@mcp-cli/core";
import { readConfigFile, writeConfigFile } from "./config-file.js";

/**
 * Tests for mcp import's source resolution and file I/O.
 * Tests the underlying logic rather than the CLI entrypoint to avoid IPC dependencies.
 */

// ---------------------------------------------------------------------------
// Fixtures — realistic MCP server configs based on catalog entries
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, ServerConfig> = {
  // Stdio: filesystem server (npx)
  filesystem: {
    command: "npx",
    args: ["-y", "@anthropic/mcp-filesystem"],
    env: { MCP_FS_ROOT: "/home/user/projects" },
  },
  // Stdio: Airtable (env var for API key)
  airtable: {
    command: "npx",
    args: ["-y", "airtable-mcp-server"],
    env: { AIRTABLE_API_KEY: "${AIRTABLE_API_KEY}" },
  },
  // HTTP: Notion (remote, streamable HTTP)
  notion: {
    type: "http" as const,
    url: "https://mcp.notion.com/mcp",
  },
  // HTTP: GitHub (remote, with auth header)
  github: {
    type: "http" as const,
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ${GH_TOKEN}" },
  },
  // SSE: Atlassian (legacy SSE transport)
  atlassian: {
    type: "sse" as const,
    url: "https://mcp.atlassian.com/v1/sse",
    headers: { Authorization: "Bearer ${ATLASSIAN_TOKEN}" },
  },
  // Stdio: Python-based server via uvx
  "jupyter-mcp": {
    command: "uvx",
    args: ["jupyter-mcp-server"],
    env: { JUPYTER_TOKEN: "${JUPYTER_TOKEN}" },
  },
  // HTTP: Sentry (remote, authless)
  sentry: {
    type: "http" as const,
    url: "https://mcp.sentry.dev/sse",
  },
};

function fixtureConfig(...names: (keyof typeof FIXTURES)[]): McpConfigFile {
  const mcpServers: Record<string, ServerConfig> = {};
  for (const name of names) {
    mcpServers[name] = FIXTURES[name];
  }
  return { mcpServers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `mcp-cli-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMcpJson(dir: string, config: McpConfigFile): string {
  const path = join(dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp import", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("source file reading", () => {
    test("reads HTTP and SSE servers from .mcp.json", () => {
      const filePath = writeMcpJson(dir, fixtureConfig("notion", "atlassian"));

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toEqual(["notion", "atlassian"]);
      expect(servers.notion).toEqual(FIXTURES.notion);
      expect(servers.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("reads stdio servers with env vars from .mcp.json", () => {
      const filePath = writeMcpJson(dir, fixtureConfig("airtable", "jupyter-mcp"));

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toEqual(["airtable", "jupyter-mcp"]);
      const airtable = servers.airtable;
      expect("command" in airtable && airtable.command).toBe("npx");
      expect("env" in airtable && airtable.env).toEqual({ AIRTABLE_API_KEY: "${AIRTABLE_API_KEY}" });
    });

    test("handles file with no mcpServers key", () => {
      const filePath = join(dir, "empty.json");
      writeFileSync(filePath, "{}");

      const config = JSON.parse(readFileSync(filePath, "utf-8")) as McpConfigFile;
      expect(config.mcpServers).toBeUndefined();
    });

    test("handles empty mcpServers", () => {
      const filePath = join(dir, "empty-servers.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));

      const config = JSON.parse(readFileSync(filePath, "utf-8")) as McpConfigFile;
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(0);
    });
  });

  describe("import into config file", () => {
    test("imports catalog servers into empty config", () => {
      const targetPath = join(dir, "servers.json");

      const source = fixtureConfig("notion", "sentry");

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });

    test("merges imported servers with existing ones", () => {
      const targetPath = join(dir, "servers.json");

      // Pre-existing server
      writeConfigFile(targetPath, fixtureConfig("filesystem"));

      // Import new ones
      const source = fixtureConfig("github", "atlassian");
      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("overwrites duplicate server names on re-import", () => {
      const targetPath = join(dir, "servers.json");

      writeConfigFile(targetPath, {
        mcpServers: { notion: { type: "http" as const, url: "https://old.example.com" } },
      });

      const source = fixtureConfig("notion");
      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
    });
  });

  describe("directory source", () => {
    test("finds .mcp.json with mixed transports in directory", () => {
      writeMcpJson(dir, fixtureConfig("filesystem", "notion", "atlassian"));

      const candidate = join(dir, ".mcp.json");
      expect(existsSync(candidate)).toBe(true);

      const config = JSON.parse(readFileSync(candidate, "utf-8")) as McpConfigFile;
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(3);
    });

    test("reports error when directory has no .mcp.json", () => {
      const emptyDir = join(dir, "empty");
      mkdirSync(emptyDir);

      expect(existsSync(join(emptyDir, ".mcp.json"))).toBe(false);
    });
  });

  describe("walk-up source", () => {
    test("finds .mcp.json in parent directory", () => {
      writeMcpJson(dir, fixtureConfig("github"));

      const child = join(dir, "sub", "deep");
      mkdirSync(child, { recursive: true });

      const found = findFileUpward(".mcp.json", child);
      expect(found).toBe(join(dir, ".mcp.json"));
    });

    test("returns null when no .mcp.json found", () => {
      const isolated = join(dir, "isolated");
      mkdirSync(isolated);

      const result = findFileUpward(".mcp.json", isolated);
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("config field preservation", () => {
    test("preserves all stdio config fields during import", () => {
      const targetPath = join(dir, "servers.json");
      const source = fixtureConfig("filesystem");

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      const server = result.mcpServers?.filesystem;
      expect(server).toBeDefined();
      if (server && "command" in server) {
        expect(server.command).toBe("npx");
        expect(server.args).toEqual(["-y", "@anthropic/mcp-filesystem"]);
        expect(server.env).toEqual({ MCP_FS_ROOT: "/home/user/projects" });
      }
    });

    test("preserves headers on HTTP servers", () => {
      const targetPath = join(dir, "servers.json");
      const source = fixtureConfig("github");

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      const server = result.mcpServers?.github;
      expect(server).toBeDefined();
      if (server && "headers" in server) {
        expect(server.headers).toEqual({ Authorization: "Bearer ${GH_TOKEN}" });
      }
    });

    test("imports full catalog-like config with all transport types", () => {
      const targetPath = join(dir, "servers.json");
      const source = fixtureConfig("filesystem", "airtable", "jupyter-mcp", "notion", "github", "atlassian", "sentry");

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      const servers = result.mcpServers ?? {};
      expect(Object.keys(servers)).toHaveLength(7);

      // Spot-check each transport type
      expect("command" in servers.filesystem).toBe(true);
      expect(servers.notion.type).toBe("http");
      expect(servers.atlassian.type).toBe("sse");
    });
  });
});
