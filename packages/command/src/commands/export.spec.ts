import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { readConfigFile, writeConfigFile } from "./config-file.js";

/**
 * Tests for mcp export's core logic: reading mcp-cli configs and writing .mcp.json format.
 * Tests the underlying helpers rather than the CLI entrypoint to avoid IPC dependencies.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, ServerConfig> = {
  filesystem: {
    command: "npx",
    args: ["-y", "@anthropic/mcp-filesystem"],
    env: { MCP_FS_ROOT: "/home/user/projects" },
  },
  notion: {
    type: "http" as const,
    url: "https://mcp.notion.com/mcp",
  },
  github: {
    type: "http" as const,
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ${GH_TOKEN}" },
  },
  atlassian: {
    type: "sse" as const,
    url: "https://mcp.atlassian.com/v1/sse",
    headers: { Authorization: "Bearer ${ATLASSIAN_TOKEN}" },
  },
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
  const dir = join(tmpdir(), `mcp-cli-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp export", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("export to file", () => {
    test("exports all servers from a config file to .mcp.json format", () => {
      // Simulate user-scoped config
      const sourcePath = join(dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("notion", "github", "filesystem"));

      // Read and re-write as export would
      const config = readConfigFile(sourcePath);
      const outputPath = join(dir, ".mcp.json");
      writeConfigFile(outputPath, config);

      const result = JSON.parse(readFileSync(outputPath, "utf-8")) as McpConfigFile;
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(3);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
    });

    test("exports specific servers via filtering", () => {
      const sourcePath = join(dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("notion", "github", "filesystem", "sentry"));

      const config = readConfigFile(sourcePath);
      const serverFilter = ["notion", "github"];

      // Apply filter (same logic as cmdExport)
      const filtered: Record<string, ServerConfig> = {};
      for (const name of serverFilter) {
        if (config.mcpServers && name in config.mcpServers) {
          filtered[name] = config.mcpServers[name];
        }
      }

      const outputPath = join(dir, "filtered.json");
      writeConfigFile(outputPath, { mcpServers: filtered });

      const result = JSON.parse(readFileSync(outputPath, "utf-8")) as McpConfigFile;
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(2);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.filesystem).toBeUndefined();
    });

    test("handles empty config gracefully", () => {
      const sourcePath = join(dir, "servers.json");
      writeConfigFile(sourcePath, { mcpServers: {} });

      const config = readConfigFile(sourcePath);
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(0);
    });

    test("handles non-existent config (returns empty)", () => {
      const sourcePath = join(dir, "nonexistent.json");
      const config = readConfigFile(sourcePath);
      expect(config.mcpServers).toEqual({});
    });
  });

  describe("scope merging (--all)", () => {
    test("merges project and user configs, user takes priority", () => {
      const projectPath = join(dir, "project-servers.json");
      const userPath = join(dir, "user-servers.json");

      // Project has notion + filesystem
      writeConfigFile(projectPath, fixtureConfig("notion", "filesystem"));

      // User has github + notion (overrides project's notion)
      const userConfig: McpConfigFile = {
        mcpServers: {
          github: FIXTURES.github,
          notion: { type: "http" as const, url: "https://user-override.example.com" },
        },
      };
      writeConfigFile(userPath, userConfig);

      // Merge: project first, then user overrides
      const merged: Record<string, ServerConfig> = {};
      const project = readConfigFile(projectPath);
      Object.assign(merged, project.mcpServers);
      const user = readConfigFile(userPath);
      Object.assign(merged, user.mcpServers);

      expect(Object.keys(merged)).toHaveLength(3); // filesystem, notion, github
      expect(merged.filesystem).toEqual(FIXTURES.filesystem);
      expect(merged.github).toEqual(FIXTURES.github);
      // User's notion override wins
      expect((merged.notion as { url: string }).url).toBe("https://user-override.example.com");
    });
  });

  describe("server filtering", () => {
    test("filter returns only matching servers", () => {
      const servers: Record<string, ServerConfig> = {
        ...fixtureConfig("notion", "github", "filesystem", "atlassian", "sentry").mcpServers,
      };

      const filter = ["github", "sentry"];
      const filtered: Record<string, ServerConfig> = {};
      for (const name of filter) {
        if (name in servers) {
          filtered[name] = servers[name];
        }
      }

      expect(Object.keys(filtered)).toEqual(["github", "sentry"]);
    });

    test("filter with unknown server names skips them", () => {
      const servers: Record<string, ServerConfig> = {
        ...fixtureConfig("notion").mcpServers,
      };

      const filter = ["notion", "nonexistent"];
      const filtered: Record<string, ServerConfig> = {};
      const missing: string[] = [];
      for (const name of filter) {
        if (name in servers) {
          filtered[name] = servers[name];
        } else {
          missing.push(name);
        }
      }

      expect(Object.keys(filtered)).toEqual(["notion"]);
      expect(missing).toEqual(["nonexistent"]);
    });
  });

  describe("output format", () => {
    test("exported JSON is valid and re-importable", () => {
      const sourcePath = join(dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("filesystem", "notion", "atlassian"));

      const config = readConfigFile(sourcePath);
      const outputPath = join(dir, "export.json");
      writeConfigFile(outputPath, config);

      // Verify the output is valid JSON that can be re-imported
      const exported = readConfigFile(outputPath);
      expect(exported.mcpServers).toBeDefined();

      // Re-import into a fresh config
      const reimportPath = join(dir, "reimport.json");
      writeConfigFile(reimportPath, exported);

      const reimported = readConfigFile(reimportPath);
      expect(reimported.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
      expect(reimported.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(reimported.mcpServers?.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("preserves all server config fields through export", () => {
      const sourcePath = join(dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("github"));

      const config = readConfigFile(sourcePath);
      const outputPath = join(dir, "export.json");
      writeConfigFile(outputPath, config);

      const exported = readConfigFile(outputPath);
      const server = exported.mcpServers?.github;
      expect(server).toBeDefined();
      if (server && "headers" in server) {
        expect(server.type).toBe("http");
        expect((server as { url: string }).url).toBe("https://api.githubcopilot.com/mcp/");
        expect(server.headers).toEqual({ Authorization: "Bearer ${GH_TOKEN}" });
      }
    });
  });
});
