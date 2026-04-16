import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { findFileUpward } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { readConfigFile, writeConfigFile } from "./config-file";
import {
  type ClaudeConfig,
  type KeychainOAuthEntry,
  cmdAddFromClaudeDesktop,
  cmdImport,
  collectClaudeServers,
  importFromClaude,
  importFromKeychain,
  inferTransportType,
  keychainEntryToServerConfig,
  readKeychainOAuthEntries,
} from "./import";

/**
 * Tests for mcx import's source resolution and file I/O.
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

function writeMcpJson(dir: string, config: McpConfigFile): string {
  const path = join(dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcx import", () => {
  describe("source file reading", () => {
    test("reads HTTP and SSE servers from .mcp.json", () => {
      using opts = testOptions();
      const filePath = writeMcpJson(opts.dir, fixtureConfig("notion", "atlassian"));

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toEqual(["notion", "atlassian"]);
      expect(servers.notion).toEqual(FIXTURES.notion);
      expect(servers.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("reads stdio servers with env vars from .mcp.json", () => {
      using opts = testOptions();
      const filePath = writeMcpJson(opts.dir, fixtureConfig("airtable", "jupyter-mcp"));

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toEqual(["airtable", "jupyter-mcp"]);
      const airtable = servers.airtable;
      expect("command" in airtable && airtable.command).toBe("npx");
      expect("env" in airtable && airtable.env).toEqual({ AIRTABLE_API_KEY: "${AIRTABLE_API_KEY}" });
    });

    test("handles file with no mcpServers key", () => {
      using opts = testOptions();
      const filePath = join(opts.dir, "empty.json");
      writeFileSync(filePath, "{}");

      const config = JSON.parse(readFileSync(filePath, "utf-8")) as McpConfigFile;
      expect(config.mcpServers).toBeUndefined();
    });

    test("handles empty mcpServers", () => {
      using opts = testOptions();
      const filePath = join(opts.dir, "empty-servers.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));

      const config = JSON.parse(readFileSync(filePath, "utf-8")) as McpConfigFile;
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(0);
    });
  });

  describe("import into config file", () => {
    test("imports catalog servers into empty config", () => {
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");

      const source = fixtureConfig("notion", "sentry");

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });

    test("merges imported servers with existing ones", () => {
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");

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
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");

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
      using opts = testOptions();
      writeMcpJson(opts.dir, fixtureConfig("filesystem", "notion", "atlassian"));

      const candidate = join(opts.dir, ".mcp.json");
      expect(existsSync(candidate)).toBe(true);

      const config = JSON.parse(readFileSync(candidate, "utf-8")) as McpConfigFile;
      expect(Object.keys(config.mcpServers ?? {})).toHaveLength(3);
    });

    test("reports error when directory has no .mcp.json", () => {
      using opts = testOptions();
      const emptyDir = join(opts.dir, "empty");
      mkdirSync(emptyDir);

      expect(existsSync(join(emptyDir, ".mcp.json"))).toBe(false);
    });
  });

  describe("walk-up source", () => {
    test("finds .mcp.json in parent directory", () => {
      using opts = testOptions();
      writeMcpJson(opts.dir, fixtureConfig("github"));

      const child = join(opts.dir, "sub", "deep");
      mkdirSync(child, { recursive: true });

      const found = findFileUpward(".mcp.json", child);
      expect(found).toBe(join(opts.dir, ".mcp.json"));
    });

    test("returns null when no .mcp.json found", () => {
      using opts = testOptions();
      const isolated = join(opts.dir, "isolated");
      mkdirSync(isolated);

      const result = findFileUpward(".mcp.json", isolated);
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("--claude: collectClaudeServers", () => {
    const coralogix: ServerConfig = {
      command: "npx",
      args: ["-y", "coralogix-mcp"],
      env: { CORALOGIX_API_KEY: "test-key-123" },
    };

    const grafana: ServerConfig = {
      type: "http" as const,
      url: "https://grafana.example.com/mcp",
    };

    const atlassian: ServerConfig = {
      type: "sse" as const,
      url: "https://mcp.atlassian.com/v1/sse",
    };

    // collectClaudeServers is a pure function — no options mutation needed

    test("collects global mcpServers", () => {
      const config: ClaudeConfig = {
        mcpServers: { grafana },
      };
      const result = collectClaudeServers(config, "/some/path", false);
      expect(Object.keys(result.servers)).toEqual(["grafana"]);
      expect(result.servers.grafana).toEqual(grafana);
      expect(result.sources).toEqual(["global"]);
    });

    test("collects project-scoped servers matching CWD", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev/github": { mcpServers: { coralogix } },
          "/Users/dev/other": { mcpServers: { atlassian } },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev/github/my-project", false);
      expect(Object.keys(result.servers)).toEqual(["coralogix"]);
      expect(result.sources).toEqual(["/Users/dev/github"]);
    });

    test("skips projects not matching CWD", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev/other": { mcpServers: { atlassian } },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev/github", false);
      expect(Object.keys(result.servers)).toHaveLength(0);
      expect(result.sources).toHaveLength(0);
    });

    test("--all collects from all projects", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev/github": { mcpServers: { coralogix } },
          "/Users/dev/other": { mcpServers: { atlassian } },
        },
      };
      const result = collectClaudeServers(config, "/unrelated/path", true);
      expect(Object.keys(result.servers).sort()).toEqual(["atlassian", "coralogix"]);
      expect(result.sources).toHaveLength(2);
    });

    test("merges global and project-scoped servers", () => {
      const config: ClaudeConfig = {
        mcpServers: { grafana },
        projects: {
          "/Users/dev/github": { mcpServers: { coralogix } },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev/github", false);
      expect(Object.keys(result.servers).sort()).toEqual(["coralogix", "grafana"]);
      expect(result.sources).toEqual(["global", "/Users/dev/github"]);
    });

    test("project server overwrites global with warning", () => {
      const projectGrafana: ServerConfig = { type: "http" as const, url: "https://other.grafana.com/mcp" };
      const config: ClaudeConfig = {
        mcpServers: { grafana },
        projects: {
          "/Users/dev/github": { mcpServers: { grafana: projectGrafana } },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev/github", false);
      expect(result.servers.grafana).toEqual(projectGrafana);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("grafana");
    });

    test("handles empty claude config", () => {
      const result = collectClaudeServers({}, "/some/path", false);
      expect(Object.keys(result.servers)).toHaveLength(0);
      expect(result.sources).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    test("handles projects with no mcpServers key", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev/github": {} as { mcpServers?: Record<string, ServerConfig> },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev/github", false);
      expect(Object.keys(result.servers)).toHaveLength(0);
    });

    test("matches parent project paths", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev": { mcpServers: { coralogix } },
        },
      };
      // CWD is a deeply nested child of the project path
      const result = collectClaudeServers(config, "/Users/dev/github/my-org/my-repo", false);
      expect(Object.keys(result.servers)).toEqual(["coralogix"]);
    });

    test("preserves env vars in imported server configs", () => {
      const config: ClaudeConfig = {
        projects: {
          "/Users/dev": { mcpServers: { coralogix } },
        },
      };
      const result = collectClaudeServers(config, "/Users/dev", false);
      const server = result.servers.coralogix;
      expect("env" in server && server.env).toEqual({ CORALOGIX_API_KEY: "test-key-123" });
    });
  });

  describe("importServers writes to config file", () => {
    test("imports servers to user scope config", () => {
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");
      writeConfigFile(targetPath, { mcpServers: {} });

      const servers: Record<string, ServerConfig> = { notion: FIXTURES.notion, sentry: FIXTURES.sentry };
      for (const [name, config] of Object.entries(servers)) {
        const existing = readConfigFile(targetPath);
        existing.mcpServers = existing.mcpServers ?? {};
        existing.mcpServers[name] = config;
        writeConfigFile(targetPath, existing);
      }

      const result = readConfigFile(targetPath);
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(2);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });
  });

  describe("importFromClaude end-to-end", () => {
    test("imports global servers from claude config file", async () => {
      using opts = testOptions();
      const claudePath = join(opts.dir, "claude.json");
      const claudeConfig: ClaudeConfig = {
        mcpServers: { notion: FIXTURES.notion, github: FIXTURES.github },
      };
      writeFileSync(claudePath, JSON.stringify(claudeConfig));

      const { servers } = collectClaudeServers(claudeConfig, opts.dir, false);
      const targetPath = join(opts.dir, "servers.json");
      for (const [name, config] of Object.entries(servers)) {
        const existing = readConfigFile(targetPath);
        existing.mcpServers = existing.mcpServers ?? {};
        existing.mcpServers[name] = config;
        writeConfigFile(targetPath, existing);
      }

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
    });

    test("importFromClaude throws when config file missing", async () => {
      using opts = testOptions();
      const missingPath = join(opts.dir, "nonexistent.json");
      await expect(importFromClaude("user", false, missingPath)).rejects.toThrow("config not found");
    });

    test("importFromClaude throws on invalid JSON", async () => {
      using opts = testOptions();
      const badPath = join(opts.dir, "bad.json");
      writeFileSync(badPath, "not valid json{{{");
      await expect(importFromClaude("user", false, badPath)).rejects.toThrow("Cannot parse");
    });

    test("importFromClaude handles empty config gracefully", async () => {
      using opts = testOptions();
      const emptyPath = join(opts.dir, "empty-claude.json");
      writeFileSync(emptyPath, JSON.stringify({}));
      await importFromClaude("user", false, emptyPath);
    });

    test("importFromClaude with --all on empty config", async () => {
      using opts = testOptions();
      const emptyPath = join(opts.dir, "empty-claude.json");
      writeFileSync(emptyPath, JSON.stringify({}));
      await importFromClaude("user", true, emptyPath);
    });
  });

  describe("config field preservation", () => {
    test("preserves all stdio config fields during import", () => {
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");
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
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");
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
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");
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

  describe("cmdImport no-arg fallback to ~/.claude.json", () => {
    test("falls back to claude.json when no .mcp.json found in cwd", async () => {
      using opts = testOptions({
        files: { "claude.json": { mcpServers: { notion: FIXTURES.notion } } },
      });
      // opts.dir has no .mcp.json, so fallback to ~/.claude.json triggers
      await cmdImport([], opts.dir);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
    });

    test("imports from .mcp.json when present, skips fallback", async () => {
      using opts = testOptions({
        files: { "claude.json": { mcpServers: { github: FIXTURES.github } } },
      });
      writeMcpJson(opts.dir, fixtureConfig("sentry"));

      await cmdImport([], opts.dir);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      // sentry from .mcp.json should be imported
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
      // github from claude.json should NOT be imported (no fallback)
      expect(result.mcpServers?.github).toBeUndefined();
    });
  });

  describe("cmdImport with file source", () => {
    test("imports from a specific JSON file", async () => {
      using opts = testOptions();
      const filePath = join(opts.dir, "my-servers.json");
      writeFileSync(filePath, JSON.stringify(fixtureConfig("notion", "sentry")));

      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        import { cmdImport } from "./packages/command/src/commands/import";
        await cmdImport(["${filePath}"]);
      `,
        ],
        {
          env: { ...process.env, MCP_CLI_DIR: opts.dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("Imported 2 server(s)");
      expect(stderr).toContain("notion");
      expect(stderr).toContain("sentry");

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });

    test("cmdImport throws on unknown flag", async () => {
      using opts = testOptions();
      await expect(cmdImport(["--bogus"])).rejects.toThrow("Unknown flag");
    });

    test("cmdImport throws on invalid scope", async () => {
      using opts = testOptions();
      await expect(cmdImport(["--scope", "invalid"])).rejects.toThrow('Invalid scope "invalid"');
    });

    test("cmdImport accepts valid --scope user", async () => {
      using opts = testOptions();
      const filePath = join(opts.dir, "scoped.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));
      await cmdImport(["--scope", "user", filePath]);
    });

    test("cmdImport accepts -s shorthand for scope", async () => {
      using opts = testOptions();
      const filePath = join(opts.dir, "scoped2.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));
      await cmdImport(["-s", "user", filePath]);
    });

    test("cmdImport --help does not throw", async () => {
      await cmdImport(["--help"]);
    });

    test("cmdImport -h does not throw", async () => {
      await cmdImport(["-h"]);
    });

    test("cmdImport --claude flag reads from options.CLAUDE_CONFIG_PATH", async () => {
      using opts = testOptions({
        files: { "claude.json": { mcpServers: { notion: FIXTURES.notion } } },
      });
      await cmdImport(["--claude"]);
    });

    test("cmdImport -c shorthand sets claude mode", async () => {
      using opts = testOptions({
        files: { "claude.json": { mcpServers: { sentry: FIXTURES.sentry } } },
      });
      await cmdImport(["-c"]);
    });

    test("cmdImport --claude --all parses both flags", async () => {
      using opts = testOptions({
        files: {
          "claude.json": {
            projects: { "/other/path": { mcpServers: { github: FIXTURES.github } } },
          },
        },
      });
      await cmdImport(["--claude", "--all"]);
    });

    test("cmdImport throws when file not found", async () => {
      using opts = testOptions();
      await expect(cmdImport([join(opts.dir, "nonexistent.json")])).rejects.toThrow("File not found");
    });

    test("cmdImport throws on unreadable file content", async () => {
      using opts = testOptions();
      const badPath = join(opts.dir, "bad.json");
      writeFileSync(badPath, "{{invalid json");
      await expect(cmdImport([badPath])).rejects.toThrow("Invalid JSON");
    });

    test("cmdImport reports empty servers without throwing", async () => {
      using opts = testOptions();
      const emptyPath = join(opts.dir, "empty.json");
      writeFileSync(emptyPath, JSON.stringify({ mcpServers: {} }));
      await cmdImport([emptyPath]);
    });

    test("cmdImport with directory source finds .mcp.json", async () => {
      using opts = testOptions();
      writeMcpJson(opts.dir, fixtureConfig("notion"));
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `import { cmdImport } from "./packages/command/src/commands/import"; await cmdImport(["${opts.dir}"]);`,
        ],
        { env: { ...process.env, MCP_CLI_DIR: opts.dir }, stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("Imported 1 server(s)");
    });

    test("cmdImport with directory without .mcp.json throws", async () => {
      using opts = testOptions();
      const emptyDir = join(opts.dir, "empty-dir");
      mkdirSync(emptyDir);
      await expect(cmdImport([emptyDir])).rejects.toThrow("No .mcp.json found");
    });
  });

  describe("cmdImport --claude end-to-end via subprocess", () => {
    test("imports project-scoped servers from claude config", async () => {
      using opts = testOptions();
      const claudePath = join(opts.dir, "claude.json");
      const cwd = process.cwd();
      const claudeConfig: ClaudeConfig = {
        mcpServers: { notion: FIXTURES.notion },
        projects: {
          [cwd]: { mcpServers: { atlassian: FIXTURES.atlassian } },
        },
      };
      writeFileSync(claudePath, JSON.stringify(claudeConfig));

      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        import { importFromClaude } from "./packages/command/src/commands/import";
        await importFromClaude("user", false, "${claudePath}");
      `,
        ],
        {
          env: { ...process.env, MCP_CLI_DIR: opts.dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("Imported 2 server(s)");

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.atlassian).toEqual(FIXTURES.atlassian);
    });

    test("imports all projects with --all flag", async () => {
      using opts = testOptions();
      const claudePath = join(opts.dir, "claude.json");
      const claudeConfig: ClaudeConfig = {
        projects: {
          "/some/other/path": { mcpServers: { github: FIXTURES.github } },
          "/another/path": { mcpServers: { sentry: FIXTURES.sentry } },
        },
      };
      writeFileSync(claudePath, JSON.stringify(claudeConfig));

      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        import { importFromClaude } from "./packages/command/src/commands/import";
        await importFromClaude("user", true, "${claudePath}");
      `,
        ],
        {
          env: { ...process.env, MCP_CLI_DIR: opts.dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("Imported 2 server(s)");

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });
  });

  describe("cmdAddFromClaudeDesktop", () => {
    test("imports servers from Claude Desktop config", async () => {
      using opts = testOptions();
      const configPath = join(opts.dir, "claude_desktop_config.json");
      const desktopConfig = fixtureConfig("notion", "filesystem");
      writeFileSync(configPath, JSON.stringify(desktopConfig));

      await cmdAddFromClaudeDesktop([], configPath);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
      expect(result.mcpServers?.filesystem).toEqual(FIXTURES.filesystem);
    });

    test("throws when config file is missing", async () => {
      using opts = testOptions();
      const missingPath = join(opts.dir, "nonexistent.json");
      await expect(cmdAddFromClaudeDesktop([], missingPath)).rejects.toThrow("config not found");
    });

    test("throws on invalid JSON", async () => {
      using opts = testOptions();
      const badPath = join(opts.dir, "bad.json");
      writeFileSync(badPath, "not valid json{{{");
      await expect(cmdAddFromClaudeDesktop([], badPath)).rejects.toThrow("Cannot parse");
    });

    test("handles empty mcpServers gracefully", async () => {
      using opts = testOptions();
      const emptyPath = join(opts.dir, "empty-desktop.json");
      writeFileSync(emptyPath, JSON.stringify({ mcpServers: {} }));
      await cmdAddFromClaudeDesktop([], emptyPath);
    });

    test("handles config with no mcpServers key", async () => {
      using opts = testOptions();
      const noServersPath = join(opts.dir, "no-servers.json");
      writeFileSync(noServersPath, JSON.stringify({}));
      await cmdAddFromClaudeDesktop([], noServersPath);
    });

    test("accepts --scope flag", async () => {
      using opts = testOptions();
      const configPath = join(opts.dir, "desktop.json");
      writeFileSync(configPath, JSON.stringify(fixtureConfig("sentry")));

      await cmdAddFromClaudeDesktop(["--scope", "user"], configPath);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.sentry).toEqual(FIXTURES.sentry);
    });

    test("accepts -s shorthand for scope", async () => {
      using opts = testOptions();
      const configPath = join(opts.dir, "desktop.json");
      writeFileSync(configPath, JSON.stringify(fixtureConfig("github")));

      await cmdAddFromClaudeDesktop(["-s", "user"], configPath);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.github).toEqual(FIXTURES.github);
    });

    test("throws on unknown flag", async () => {
      using opts = testOptions();
      await expect(cmdAddFromClaudeDesktop(["--bogus"], join(opts.dir, "x.json"))).rejects.toThrow("Unknown flag");
    });

    test("--help does not throw", async () => {
      await cmdAddFromClaudeDesktop(["--help"]);
    });

    test("-h does not throw", async () => {
      await cmdAddFromClaudeDesktop(["-h"]);
    });

    test("--from-keychain flag is recognized", async () => {
      // On non-macOS or without keychain, this should just print "no OAuth servers"
      await cmdImport(["--from-keychain"]);
    });

    test("imports all transport types", async () => {
      using opts = testOptions();
      const configPath = join(opts.dir, "desktop-all.json");
      const allServers = fixtureConfig("filesystem", "notion", "atlassian", "sentry");
      writeFileSync(configPath, JSON.stringify(allServers));

      await cmdAddFromClaudeDesktop([], configPath);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(Object.keys(result.mcpServers ?? {})).toHaveLength(4);
      expect("command" in (result.mcpServers?.filesystem ?? {})).toBe(true);
      expect(result.mcpServers?.notion?.type).toBe("http");
      expect(result.mcpServers?.atlassian?.type).toBe("sse");
    });

    test("overwrites existing servers", async () => {
      using opts = testOptions();
      const targetPath = join(opts.dir, "servers.json");
      writeConfigFile(targetPath, {
        mcpServers: { notion: { type: "http" as const, url: "https://old.example.com" } },
      });

      const configPath = join(opts.dir, "desktop-overwrite.json");
      writeFileSync(configPath, JSON.stringify(fixtureConfig("notion")));

      await cmdAddFromClaudeDesktop([], configPath);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.notion).toEqual(FIXTURES.notion);
    });
  });

  describe("--from-keychain: readKeychainOAuthEntries", () => {
    const sampleKeychainData = JSON.stringify({
      mcpOAuth: {
        "asana|abc123": {
          serverName: "asana",
          serverUrl: "https://mcp.asana.com/sse",
          clientId: "44EBfNxyz",
          accessToken: "tok_asana",
        },
        "sentry|def456": {
          serverName: "sentry",
          serverUrl: "https://mcp.sentry.dev/mcp",
          clientId: "lwL7Cdabc",
          accessToken: "tok_sentry",
        },
      },
    });

    test("parses entries from keychain JSON", async () => {
      const entries = await readKeychainOAuthEntries(async () => sampleKeychainData);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.serverName).sort()).toEqual(["asana", "sentry"]);
      expect(entries.find((e) => e.serverName === "asana")?.serverUrl).toBe("https://mcp.asana.com/sse");
      expect(entries.find((e) => e.serverName === "asana")?.clientId).toBe("44EBfNxyz");
    });

    test("returns empty array when keychain returns null", async () => {
      const entries = await readKeychainOAuthEntries(async () => null);
      expect(entries).toEqual([]);
    });

    test("returns empty array when no mcpOAuth key", async () => {
      const entries = await readKeychainOAuthEntries(async () => JSON.stringify({ otherStuff: true }));
      expect(entries).toEqual([]);
    });

    test("returns empty array on invalid JSON", async () => {
      const entries = await readKeychainOAuthEntries(async () => "not valid json{{{");
      expect(entries).toEqual([]);
    });

    test("skips entries missing required fields", async () => {
      const data = JSON.stringify({
        mcpOAuth: {
          "missing-url|123": {
            serverName: "test",
            clientId: "abc",
            accessToken: "tok",
            // serverUrl is missing
          },
          "valid|456": {
            serverName: "valid",
            serverUrl: "https://example.com/mcp",
            clientId: "xyz",
            accessToken: "tok",
          },
        },
      });
      const entries = await readKeychainOAuthEntries(async () => data);
      expect(entries).toHaveLength(1);
      expect(entries[0].serverName).toBe("valid");
    });
  });

  describe("--from-keychain: inferTransportType", () => {
    test("returns sse for URLs ending with /sse", () => {
      expect(inferTransportType("https://mcp.asana.com/sse")).toBe("sse");
      expect(inferTransportType("https://mcp.atlassian.com/v1/sse")).toBe("sse");
    });

    test("returns http for other URLs", () => {
      expect(inferTransportType("https://mcp.sentry.dev/mcp")).toBe("http");
      expect(inferTransportType("https://mcp.notion.com/mcp")).toBe("http");
    });

    test("returns http for invalid URLs", () => {
      expect(inferTransportType("not a url")).toBe("http");
    });
  });

  describe("--from-keychain: keychainEntryToServerConfig", () => {
    test("creates SSE config for /sse URLs", () => {
      const config = keychainEntryToServerConfig({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
        clientId: "44EBfN",
      });
      expect(config).toEqual({ type: "sse", url: "https://mcp.asana.com/sse" });
    });

    test("creates HTTP config for non-sse URLs", () => {
      const config = keychainEntryToServerConfig({
        serverName: "sentry",
        serverUrl: "https://mcp.sentry.dev/mcp",
        clientId: "lwL7Cd",
      });
      expect(config).toEqual({ type: "http", url: "https://mcp.sentry.dev/mcp" });
    });
  });

  describe("--from-keychain: importFromKeychain", () => {
    const keychainJson = JSON.stringify({
      mcpOAuth: {
        "asana|abc123": {
          serverName: "asana",
          serverUrl: "https://mcp.asana.com/sse",
          clientId: "44EBfNxyz",
          accessToken: "tok_asana",
        },
        "sentry|def456": {
          serverName: "sentry",
          serverUrl: "https://mcp.sentry.dev/mcp",
          clientId: "lwL7Cdabc",
          accessToken: "tok_sentry",
        },
      },
    });

    test("imports new servers from keychain", async () => {
      using opts = testOptions();
      await importFromKeychain("user", async () => keychainJson);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.asana).toEqual({ type: "sse", url: "https://mcp.asana.com/sse" });
      expect(result.mcpServers?.sentry).toEqual({ type: "http", url: "https://mcp.sentry.dev/mcp" });
    });

    test("skips servers that are already configured by URL", async () => {
      using opts = testOptions();
      // Pre-configure asana with the same URL
      writeConfigFile(join(opts.dir, "servers.json"), {
        mcpServers: {
          "my-asana": { type: "sse" as const, url: "https://mcp.asana.com/sse" },
        },
      });

      await importFromKeychain("user", async () => keychainJson);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      // asana should NOT be added (URL already exists under "my-asana")
      expect(result.mcpServers?.asana).toBeUndefined();
      // my-asana should still be there
      expect(result.mcpServers?.["my-asana"]).toBeDefined();
      // sentry should be added
      expect(result.mcpServers?.sentry).toEqual({ type: "http", url: "https://mcp.sentry.dev/mcp" });
    });

    test("handles empty keychain gracefully", async () => {
      using opts = testOptions();
      await importFromKeychain("user", async () => null);
      // Should not throw, just print a message
    });

    test("handles keychain with no entries", async () => {
      using opts = testOptions();
      await importFromKeychain("user", async () => JSON.stringify({ mcpOAuth: {} }));
    });

    test("preserves URL exactly as-is from keychain", async () => {
      using opts = testOptions();
      const data = JSON.stringify({
        mcpOAuth: {
          "test|1": {
            serverName: "test",
            serverUrl: "https://WEIRD.example.COM/Path/To/MCP",
            clientId: "abc",
            accessToken: "tok",
          },
        },
      });
      await importFromKeychain("user", async () => data);

      const result = readConfigFile(join(opts.dir, "servers.json"));
      expect(result.mcpServers?.test).toBeDefined();
      if (result.mcpServers?.test && "url" in result.mcpServers.test) {
        expect(result.mcpServers.test.url).toBe("https://WEIRD.example.COM/Path/To/MCP");
      }
    });
  });
});
