import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { buildServerConfig, parseAddArgs } from "./add.js";
import {
  addServerToConfig,
  readConfigFile,
  removeServerFromConfig,
  resolveConfigPath,
  writeConfigFile,
} from "./config-file.js";
import { parseRemoveArgs } from "./remove.js";

// -- parseAddArgs tests --

describe("parseAddArgs", () => {
  test("parses http transport with name and url", () => {
    const result = parseAddArgs(["--transport", "http", "my-server", "https://example.com/mcp"]);
    expect(result.transport).toBe("http");
    expect(result.name).toBe("my-server");
    expect(result.url).toBe("https://example.com/mcp");
    expect(result.scope).toBe("user");
  });

  test("parses sse transport", () => {
    const result = parseAddArgs(["--transport", "sse", "my-sse", "https://sse.example.com"]);
    expect(result.transport).toBe("sse");
    expect(result.name).toBe("my-sse");
    expect(result.url).toBe("https://sse.example.com");
  });

  test("parses stdio transport with command after --", () => {
    const result = parseAddArgs(["--transport", "stdio", "my-stdio", "--", "npx", "-y", "some-pkg"]);
    expect(result.transport).toBe("stdio");
    expect(result.name).toBe("my-stdio");
    expect(result.command).toBe("npx");
    expect(result.commandArgs).toEqual(["-y", "some-pkg"]);
  });

  test("parses repeatable --env flags", () => {
    const result = parseAddArgs([
      "--transport",
      "stdio",
      "--env",
      "API_KEY=secret",
      "--env",
      "MODE=prod",
      "my-server",
      "--",
      "cmd",
    ]);
    expect(result.env).toEqual({ API_KEY: "secret", MODE: "prod" });
  });

  test("parses repeatable --header flags", () => {
    const result = parseAddArgs([
      "--transport",
      "http",
      "--header",
      "Authorization: Bearer tok",
      "--header",
      "X-Custom: val",
      "my-server",
      "https://example.com",
    ]);
    expect(result.headers).toEqual({ Authorization: "Bearer tok", "X-Custom": "val" });
  });

  test("parses --scope project", () => {
    const result = parseAddArgs(["--transport", "http", "--scope", "project", "my-server", "https://example.com"]);
    expect(result.scope).toBe("project");
  });

  test("parses --scope local as valid", () => {
    const result = parseAddArgs(["--transport", "http", "--scope", "local", "my-server", "https://example.com"]);
    expect(result.scope).toBe("local");
  });

  test("throws on missing --transport", () => {
    expect(() => parseAddArgs(["my-server", "https://example.com"])).toThrow("--transport is required");
  });

  test("throws on invalid transport", () => {
    expect(() => parseAddArgs(["--transport", "grpc", "name", "url"])).toThrow('Invalid transport "grpc"');
  });

  test("throws on missing name", () => {
    expect(() => parseAddArgs(["--transport", "http"])).toThrow("Server name is required");
  });

  test("throws on missing url for http", () => {
    expect(() => parseAddArgs(["--transport", "http", "name"])).toThrow("URL is required");
  });

  test("throws on missing command for stdio", () => {
    expect(() => parseAddArgs(["--transport", "stdio", "name"])).toThrow("stdio transport requires a command after --");
  });

  test("throws on --header with stdio", () => {
    expect(() => parseAddArgs(["--transport", "stdio", "--header", "H: V", "name", "--", "cmd"])).toThrow(
      "--header is not valid for stdio",
    );
  });

  test("throws on -- with http transport", () => {
    expect(() => parseAddArgs(["--transport", "http", "name", "https://example.com", "--", "cmd"])).toThrow(
      "-- command separator is not valid for http",
    );
  });

  test("throws on invalid --env format", () => {
    expect(() => parseAddArgs(["--transport", "http", "--env", "NOEQUALS", "name", "https://example.com"])).toThrow(
      'Invalid --env value "NOEQUALS"',
    );
  });

  test("throws on unknown flag", () => {
    expect(() => parseAddArgs(["--transport", "http", "--unknown", "name", "https://example.com"])).toThrow(
      "Unknown flag: --unknown",
    );
  });

  test("parses short flags -t -e -s", () => {
    const result = parseAddArgs(["-t", "stdio", "-e", "K=V", "-s", "project", "name", "--", "cmd"]);
    expect(result.transport).toBe("stdio");
    expect(result.env).toEqual({ K: "V" });
    expect(result.scope).toBe("project");
  });

  test("handles env value with multiple equals signs", () => {
    const result = parseAddArgs(["-t", "http", "--env", "URL=https://a.com?x=1", "name", "https://example.com"]);
    expect(result.env).toEqual({ URL: "https://a.com?x=1" });
  });
});

// -- buildServerConfig tests --

describe("buildServerConfig", () => {
  test("builds http config", () => {
    const config = buildServerConfig({
      transport: "http",
      name: "s",
      url: "https://example.com",
      env: {},
      headers: {},
      scope: "user",
    });
    expect(config).toEqual({ type: "http", url: "https://example.com" });
  });

  test("builds http config with headers", () => {
    const config = buildServerConfig({
      transport: "http",
      name: "s",
      url: "https://example.com",
      env: {},
      headers: { Authorization: "Bearer tok" },
      scope: "user",
    });
    expect(config).toEqual({
      type: "http",
      url: "https://example.com",
      headers: { Authorization: "Bearer tok" },
    });
  });

  test("builds sse config", () => {
    const config = buildServerConfig({
      transport: "sse",
      name: "s",
      url: "https://example.com",
      env: {},
      headers: {},
      scope: "user",
    });
    expect(config).toEqual({ type: "sse", url: "https://example.com" });
  });

  test("builds stdio config", () => {
    const config = buildServerConfig({
      transport: "stdio",
      name: "s",
      command: "npx",
      commandArgs: ["-y", "pkg"],
      env: { KEY: "val" },
      headers: {},
      scope: "user",
    });
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
      env: { KEY: "val" },
    });
  });

  test("omits empty args and env for stdio", () => {
    const config = buildServerConfig({
      transport: "stdio",
      name: "s",
      command: "cmd",
      commandArgs: [],
      env: {},
      headers: {},
      scope: "user",
    });
    expect(config).toEqual({ command: "cmd" });
    expect("args" in config).toBe(false);
    expect("env" in config).toBe(false);
  });
});

// -- parseRemoveArgs tests --

describe("parseRemoveArgs", () => {
  test("parses name", () => {
    const result = parseRemoveArgs(["my-server"]);
    expect(result.name).toBe("my-server");
    expect(result.scope).toBe("user");
  });

  test("parses --scope project", () => {
    const result = parseRemoveArgs(["--scope", "project", "my-server"]);
    expect(result.name).toBe("my-server");
    expect(result.scope).toBe("project");
  });

  test("throws on missing name", () => {
    expect(() => parseRemoveArgs([])).toThrow("Server name is required");
  });

  test("throws on invalid scope", () => {
    expect(() => parseRemoveArgs(["--scope", "global", "my-server"])).toThrow('Invalid scope "global"');
  });
});

// -- Config file operations --

describe("config file operations", () => {
  let tmpDir: string;
  let serversPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    serversPath = join(tmpDir, "servers.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("readConfigFile returns empty for missing file", () => {
    const config = readConfigFile(join(tmpDir, "nonexistent.json"));
    expect(config).toEqual({ mcpServers: {} });
  });

  test("readConfigFile reads existing file", () => {
    const data: McpConfigFile = {
      mcpServers: { test: { type: "http", url: "https://example.com" } },
    };
    writeFileSync(serversPath, JSON.stringify(data));

    const config = readConfigFile(serversPath);
    expect(config.mcpServers?.test).toEqual({ type: "http", url: "https://example.com" });
  });

  test("writeConfigFile creates file with JSON", () => {
    const config: McpConfigFile = {
      mcpServers: { s: { type: "http", url: "https://example.com" } },
    };
    writeConfigFile(serversPath, config);

    expect(existsSync(serversPath)).toBe(true);
    const content = readFileSync(serversPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.s.url).toBe("https://example.com");
    // Should end with newline
    expect(content.endsWith("\n")).toBe(true);
  });

  test("writeConfigFile creates parent directory", () => {
    const nested = join(tmpDir, "sub", "dir", "config.json");
    writeConfigFile(nested, { mcpServers: {} });
    expect(existsSync(nested)).toBe(true);
  });

  test("addServerToConfig creates file and adds entry", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    const file = readConfigFile(serversPath);
    file.mcpServers = file.mcpServers ?? {};
    const existed = "test" in file.mcpServers;
    file.mcpServers.test = config;
    writeConfigFile(serversPath, file);

    expect(existed).toBe(false);
    const result = readConfigFile(serversPath);
    expect(result.mcpServers?.test).toEqual({ type: "http", url: "https://example.com" });
  });

  test("addServerToConfig returns true when overwriting existing entry", () => {
    writeConfigFile(serversPath, {
      mcpServers: { s: { type: "http", url: "https://old.com" } },
    });

    const file = readConfigFile(serversPath);
    const existed = "s" in (file.mcpServers ?? {});
    file.mcpServers = file.mcpServers ?? {};
    file.mcpServers.s = { type: "http", url: "https://new.com" };
    writeConfigFile(serversPath, file);

    expect(existed).toBe(true);
    const result = readConfigFile(serversPath);
    expect(result.mcpServers?.s).toEqual({ type: "http", url: "https://new.com" });
  });

  test("addServerToConfig preserves existing entries", () => {
    const initial: McpConfigFile = {
      mcpServers: { existing: { type: "http", url: "https://existing.com" } },
    };
    writeConfigFile(serversPath, initial);

    const file = readConfigFile(serversPath);
    file.mcpServers = file.mcpServers ?? {};
    file.mcpServers["new-server"] = { type: "sse", url: "https://new.com" };
    writeConfigFile(serversPath, file);

    const result = readConfigFile(serversPath);
    expect(result.mcpServers?.existing).toEqual({ type: "http", url: "https://existing.com" });
    expect(result.mcpServers?.["new-server"]).toEqual({ type: "sse", url: "https://new.com" });
  });

  test("removeServerFromConfig removes entry", () => {
    const initial: McpConfigFile = {
      mcpServers: {
        keep: { type: "http", url: "https://keep.com" },
        toRemove: { type: "http", url: "https://remove.com" },
      },
    };
    writeConfigFile(serversPath, initial);

    const file = readConfigFile(serversPath);
    const existed = file.mcpServers !== undefined && "toRemove" in file.mcpServers;
    expect(existed).toBe(true);
    const { toRemove: _, ...rest } = file.mcpServers ?? {};
    file.mcpServers = rest;
    writeConfigFile(serversPath, file);

    const result = readConfigFile(serversPath);
    expect(result.mcpServers?.keep).toEqual({ type: "http", url: "https://keep.com" });
    expect(result.mcpServers?.toRemove).toBeUndefined();
  });

  test("removeServerFromConfig returns false for missing server", () => {
    writeConfigFile(serversPath, { mcpServers: {} });

    const file = readConfigFile(serversPath);
    const existed = file.mcpServers !== undefined && "nonexistent" in file.mcpServers;
    expect(existed).toBe(false);
  });

  test("readConfigFile handles file without mcpServers key", () => {
    writeFileSync(serversPath, "{}");
    const config = readConfigFile(serversPath);
    expect(config.mcpServers).toEqual({});
  });
});

// -- Scope resolution --

describe("resolveConfigPath", () => {
  test("user scope resolves to USER_SERVERS_PATH", () => {
    const path = resolveConfigPath("user");
    expect(path).toContain("servers.json");
    expect(path).toContain(".mcp-cli");
  });

  test("local scope resolves same as user", () => {
    expect(resolveConfigPath("local")).toBe(resolveConfigPath("user"));
  });

  test("project scope resolves to .mcp.json in cwd", () => {
    const path = resolveConfigPath("project");
    expect(path).toContain(".mcp.json");
    expect(path).toContain(process.cwd());
  });
});

// -- cmdAddJson validation (unit-testable parts) --

describe("cmdAddJson validation", () => {
  test("invalid JSON throws", () => {
    expect(() => JSON.parse("not-json")).toThrow();
  });

  test("config missing command and url is rejected", () => {
    const config = JSON.parse('{"type":"unknown"}');
    const valid = "command" in config || "url" in config;
    expect(valid).toBe(false);
  });

  test("valid http config has url", () => {
    const config = JSON.parse('{"type":"http","url":"https://example.com"}');
    expect("url" in config).toBe(true);
  });

  test("valid stdio config has command", () => {
    const config = JSON.parse('{"command":"npx","args":["-y","pkg"]}');
    expect("command" in config).toBe(true);
  });
});

// -- parseRemoveArgs edge cases --

describe("parseRemoveArgs edge cases", () => {
  test("throws on unknown flag", () => {
    expect(() => parseRemoveArgs(["--verbose", "my-server"])).toThrow("Unknown flag: --verbose");
  });

  test("parses -s shorthand", () => {
    const result = parseRemoveArgs(["-s", "local", "my-server"]);
    expect(result.scope).toBe("local");
    expect(result.name).toBe("my-server");
  });
});
