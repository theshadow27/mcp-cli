import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import {
  addServerToConfig,
  readConfigFile,
  removeServerFromConfig,
  resolveConfigPath,
  writeConfigFile,
} from "./config-file";

const HTTP_SERVER: ServerConfig = { type: "http", url: "https://example.com/mcp" };
const SSE_SERVER: ServerConfig = { type: "sse", url: "https://sse.example.com" };
const STDIO_SERVER: ServerConfig = { command: "npx", args: ["-y", "some-pkg"] };

describe("resolveConfigPath", () => {
  test("user scope returns USER_SERVERS_PATH", () => {
    using opts = testOptions();
    expect(resolveConfigPath("user")).toBe(opts.USER_SERVERS_PATH);
  });

  test("local scope returns same as user", () => {
    using opts = testOptions();
    expect(resolveConfigPath("local")).toBe(opts.USER_SERVERS_PATH);
  });

  test("project scope returns path under PROJECTS_DIR", () => {
    using opts = testOptions();
    const path = resolveConfigPath("project");
    expect(path).toContain(opts.PROJECTS_DIR);
    expect(path).toEndWith("servers.json");
  });
});

describe("readConfigFile", () => {
  test("returns empty structure for missing file", () => {
    using opts = testOptions();
    expect(readConfigFile(join(opts.dir, "nonexistent.json"))).toEqual({ mcpServers: {} });
  });

  test("reads existing config", () => {
    const data: McpConfigFile = { mcpServers: { test: HTTP_SERVER } };
    using opts = testOptions({ files: { "servers.json": data } });
    const result = readConfigFile(opts.USER_SERVERS_PATH);
    expect(result.mcpServers?.test).toEqual(HTTP_SERVER);
  });

  test("adds mcpServers key if missing", () => {
    using opts = testOptions({ files: { "servers.json": "{}" } });
    const result = readConfigFile(opts.USER_SERVERS_PATH);
    expect(result.mcpServers).toEqual({});
  });
});

describe("writeConfigFile", () => {
  test("writes JSON with trailing newline", () => {
    using opts = testOptions();
    const config: McpConfigFile = { mcpServers: { s: HTTP_SERVER } };
    const path = join(opts.dir, "output.json");

    writeConfigFile(path, config);

    const content = readFileSync(path, "utf-8");
    expect(content).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  test("creates parent directories", () => {
    using opts = testOptions();
    const nested = join(opts.dir, "a", "b", "config.json");

    writeConfigFile(nested, { mcpServers: {} });

    const content = readFileSync(nested, "utf-8");
    expect(JSON.parse(content)).toEqual({ mcpServers: {} });
  });
});

describe("addServerToConfig", () => {
  test("creates file and adds new server, returns false", () => {
    using opts = testOptions();
    const result = addServerToConfig("user", "my-server", HTTP_SERVER);

    expect(result).toBe(false);
    const config = readConfigFile(opts.USER_SERVERS_PATH);
    expect(config.mcpServers?.["my-server"]).toEqual(HTTP_SERVER);
  });

  test("returns true when replacing existing server", () => {
    using opts = testOptions({
      files: { "servers.json": { mcpServers: { s: HTTP_SERVER } } },
    });
    const result = addServerToConfig("user", "s", SSE_SERVER);

    expect(result).toBe(true);
    const config = readConfigFile(opts.USER_SERVERS_PATH);
    expect(config.mcpServers?.s).toEqual(SSE_SERVER);
  });

  test("preserves existing servers when adding new one", () => {
    using opts = testOptions({
      files: { "servers.json": { mcpServers: { existing: HTTP_SERVER } } },
    });

    addServerToConfig("user", "new-server", STDIO_SERVER);

    const config = readConfigFile(opts.USER_SERVERS_PATH);
    expect(config.mcpServers?.existing).toEqual(HTTP_SERVER);
    expect(config.mcpServers?.["new-server"]).toEqual(STDIO_SERVER);
  });
});

describe("removeServerFromConfig", () => {
  test("removes server and returns true", () => {
    using opts = testOptions({
      files: {
        "servers.json": { mcpServers: { keep: HTTP_SERVER, remove: SSE_SERVER } },
      },
    });

    const result = removeServerFromConfig("user", "remove");

    expect(result).toBe(true);
    const config = readConfigFile(opts.USER_SERVERS_PATH);
    expect(config.mcpServers?.keep).toEqual(HTTP_SERVER);
    expect(config.mcpServers?.remove).toBeUndefined();
  });

  test("returns false for nonexistent server", () => {
    using _opts = testOptions({
      files: { "servers.json": { mcpServers: {} } },
    });

    expect(removeServerFromConfig("user", "nope")).toBe(false);
  });

  test("returns false when config file is missing", () => {
    using _opts = testOptions();
    expect(removeServerFromConfig("user", "nope")).toBe(false);
  });
});
