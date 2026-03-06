import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { readConfigFile, writeConfigFile } from "./config-file";

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
// Tests
// ---------------------------------------------------------------------------

describe("mcx export", () => {
  describe("export to file", () => {
    test("exports all servers from a config file to .mcp.json format", () => {
      using opts = testOptions();
      const sourcePath = join(opts.dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("notion", "github", "filesystem"));

      const config = readConfigFile(sourcePath);
      const outputPath = join(opts.dir, ".mcp.json");
      writeConfigFile(outputPath, config);

      const result = JSON.parse(readFileSync(outputPath, "utf-8")) as McpConfigFile;
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(3);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
    });

    test("exports specific servers via filtering", () => {
      using opts = testOptions();
      const sourcePath = join(opts.dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("notion", "github", "filesystem", "sentry"));

      const config = readConfigFile(sourcePath);
      const serverFilter = ["notion", "github"];

      const filtered: Record<string, ServerConfig> = {};
      for (const name of serverFilter) {
        if (config.mcpServers && name in config.mcpServers) {
          filtered[name] = config.mcpServers[name];
        }
      }

      const outputPath = join(opts.dir, "filtered.json");
      writeConfigFile(outputPath, { mcpServers: filtered });

      const result = JSON.parse(readFileSync(outputPath, "utf-8")) as McpConfigFile;
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(2);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.filesystem).toBeUndefined();
    });

    test("handles empty config gracefully", () => {
      using opts = testOptions();
      const sourcePath = join(opts.dir, "servers.json");
      writeConfigFile(sourcePath, { mcpServers: {} });

      const config = readConfigFile(sourcePath);
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(0);
    });

    test("handles non-existent config (returns empty)", () => {
      using opts = testOptions();
      const sourcePath = join(opts.dir, "nonexistent.json");
      const config = readConfigFile(sourcePath);
      expect(config.mcpServers).toEqual({});
    });
  });

  describe("scope merging (--all)", () => {
    test("merges project and user configs, user takes priority", () => {
      using opts = testOptions();
      const projectPath = join(opts.dir, "project-servers.json");
      const userPath = join(opts.dir, "user-servers.json");

      writeConfigFile(projectPath, fixtureConfig("notion", "filesystem"));

      const userConfig: McpConfigFile = {
        mcpServers: {
          github: FIXTURES.github,
          notion: { type: "http" as const, url: "https://user-override.example.com" },
        },
      };
      writeConfigFile(userPath, userConfig);

      const merged: Record<string, ServerConfig> = {};
      const project = readConfigFile(projectPath);
      Object.assign(merged, project.mcpServers);
      const user = readConfigFile(userPath);
      Object.assign(merged, user.mcpServers);

      expect(Object.keys(merged)).toHaveLength(3);
      expect(merged.filesystem).toEqual(FIXTURES.filesystem);
      expect(merged.github).toEqual(FIXTURES.github);
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
      using opts = testOptions();
      const sourcePath = join(opts.dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("filesystem", "notion", "atlassian"));

      const config = readConfigFile(sourcePath);
      const outputPath = join(opts.dir, "export.json");
      writeConfigFile(outputPath, config);

      const exported = readConfigFile(outputPath);
      expect(exported.mcpServers).toBeDefined();

      const reimportPath = join(opts.dir, "reimport.json");
      writeConfigFile(reimportPath, exported);

      const reimported = readConfigFile(reimportPath);
      expect(reimported.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
      expect(reimported.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(reimported.mcpServers?.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("preserves all server config fields through export", () => {
      using opts = testOptions();
      const sourcePath = join(opts.dir, "servers.json");
      writeConfigFile(sourcePath, fixtureConfig("github"));

      const config = readConfigFile(sourcePath);
      const outputPath = join(opts.dir, "export.json");
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
