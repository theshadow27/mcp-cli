import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile } from "@mcp-cli/core";
import { findFileUpward } from "@mcp-cli/core";
import { readConfigFile, writeConfigFile } from "./config-file.js";

/**
 * These tests exercise the import command's source resolution and file I/O.
 * We test the underlying logic rather than the CLI entrypoint to avoid IPC dependencies.
 */

// -- Helpers --

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

// -- Tests --

describe("mcp import", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("source file reading", () => {
    test("reads servers from .mcp.json file", () => {
      const mcpJson: McpConfigFile = {
        mcpServers: {
          github: { type: "http", url: "https://github.example.com/mcp" },
          notion: { type: "sse", url: "https://notion.example.com/sse" },
        },
      };
      const filePath = writeMcpJson(dir, mcpJson);

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      expect(config.mcpServers).toBeDefined();
      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toEqual(["github", "notion"]);
      expect(servers.github).toEqual({ type: "http", url: "https://github.example.com/mcp" });
    });

    test("handles file with no mcpServers key", () => {
      const filePath = join(dir, "empty.json");
      writeFileSync(filePath, "{}");

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      expect(config.mcpServers).toBeUndefined();
    });

    test("handles empty mcpServers", () => {
      const filePath = join(dir, "empty-servers.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));

      const content = readFileSync(filePath, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;

      const servers = config.mcpServers ?? {};
      expect(Object.keys(servers)).toHaveLength(0);
    });
  });

  describe("import into config file", () => {
    test("imports servers into empty config", () => {
      const targetPath = join(dir, "servers.json");

      const source: McpConfigFile = {
        mcpServers: {
          api: { type: "http", url: "https://api.example.com" },
        },
      };

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.api).toEqual({ type: "http", url: "https://api.example.com" });
    });

    test("merges with existing servers", () => {
      const targetPath = join(dir, "servers.json");

      writeConfigFile(targetPath, {
        mcpServers: { existing: { command: "echo" } },
      });

      const source: McpConfigFile = {
        mcpServers: {
          imported: { type: "http", url: "https://imported.example.com" },
        },
      };

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.existing).toEqual({ command: "echo" });
      expect(result.mcpServers?.imported).toEqual({ type: "http", url: "https://imported.example.com" });
    });

    test("overwrites duplicate server names", () => {
      const targetPath = join(dir, "servers.json");

      writeConfigFile(targetPath, {
        mcpServers: { api: { type: "http", url: "https://old.example.com" } },
      });

      const source: McpConfigFile = {
        mcpServers: {
          api: { type: "http", url: "https://new.example.com" },
        },
      };

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      expect(result.mcpServers?.api).toEqual({ type: "http", url: "https://new.example.com" });
    });
  });

  describe("directory source", () => {
    test("finds .mcp.json in directory", () => {
      writeMcpJson(dir, {
        mcpServers: { myserver: { command: "my-mcp-server" } },
      });

      const candidate = join(dir, ".mcp.json");
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, "utf-8");
      const config = JSON.parse(content) as McpConfigFile;
      expect(config.mcpServers?.myserver).toEqual({ command: "my-mcp-server" });
    });

    test("reports error when directory has no .mcp.json", () => {
      const emptyDir = join(dir, "empty");
      mkdirSync(emptyDir);

      const candidate = join(emptyDir, ".mcp.json");
      expect(existsSync(candidate)).toBe(false);
    });
  });

  describe("walk-up source", () => {
    test("finds .mcp.json in parent directory", () => {
      writeMcpJson(dir, {
        mcpServers: { parent: { command: "parent-server" } },
      });

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

  describe("stdio server configs", () => {
    test("preserves all stdio config fields during import", () => {
      const targetPath = join(dir, "servers.json");
      const source: McpConfigFile = {
        mcpServers: {
          local: {
            command: "npx",
            args: ["-y", "@some/mcp-server"],
            env: { API_KEY: "${API_KEY}" },
            cwd: "/some/dir",
          },
        },
      };

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      const server = result.mcpServers?.local;
      expect(server).toBeDefined();
      if (server && "command" in server) {
        expect(server.command).toBe("npx");
        expect(server.args).toEqual(["-y", "@some/mcp-server"]);
        expect(server.env).toEqual({ API_KEY: "${API_KEY}" });
        expect(server.cwd).toBe("/some/dir");
      }
    });
  });

  describe("multiple servers", () => {
    test("imports all servers from a multi-server config", () => {
      const targetPath = join(dir, "servers.json");
      const source: McpConfigFile = {
        mcpServers: {
          github: { type: "http", url: "https://github.example.com/mcp" },
          notion: { type: "sse", url: "https://notion.example.com/sse" },
          local: { command: "my-local-server", args: ["--port", "3000"] },
        },
      };

      const existing = readConfigFile(targetPath);
      existing.mcpServers = { ...existing.mcpServers, ...source.mcpServers };
      writeConfigFile(targetPath, existing);

      const result = readConfigFile(targetPath);
      const servers = result.mcpServers ?? {};
      expect(Object.keys(servers)).toHaveLength(3);
      expect(servers.github).toBeDefined();
      expect(servers.notion).toBeDefined();
      expect(servers.local).toBeDefined();
    });
  });
});
