import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpConfigFile } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import type { RegistryResponse } from "../registry/client";
import { type InstallDeps, cmdInstall, parseInstallArgs } from "./install";

describe("parseInstallArgs", () => {
  test("parses slug only", () => {
    const result = parseInstallArgs(["sentry"]);
    expect(result.slug).toBe("sentry");
    expect(result.name).toBeUndefined();
    expect(result.scope).toBe("user");
    expect(result.env).toEqual({});
    expect(result.json).toBe(false);
    expect(result.noCache).toBe(false);
  });

  test("parses --as flag", () => {
    const result = parseInstallArgs(["sentry", "--as", "my-sentry"]);
    expect(result.slug).toBe("sentry");
    expect(result.name).toBe("my-sentry");
  });

  test("parses --scope flag", () => {
    const result = parseInstallArgs(["sentry", "--scope", "project"]);
    expect(result.scope).toBe("project");
  });

  test("parses -s short flag", () => {
    const result = parseInstallArgs(["sentry", "-s", "project"]);
    expect(result.scope).toBe("project");
  });

  test("parses multiple --env flags", () => {
    const result = parseInstallArgs(["sentry", "--env", "API_KEY=abc", "--env", "MODE=prod"]);
    expect(result.env).toEqual({ API_KEY: "abc", MODE: "prod" });
  });

  test("parses -e short flag", () => {
    const result = parseInstallArgs(["sentry", "-e", "KEY=val"]);
    expect(result.env).toEqual({ KEY: "val" });
  });

  test("parses --json flag", () => {
    const result = parseInstallArgs(["sentry", "-j"]);
    expect(result.json).toBe(true);
  });

  test("parses --format json flag", () => {
    const result = parseInstallArgs(["sentry", "--format", "json"]);
    expect(result.json).toBe(true);
  });

  test("throws on missing slug", () => {
    expect(() => parseInstallArgs([])).toThrow("Server slug is required");
  });

  test("throws on invalid scope", () => {
    expect(() => parseInstallArgs(["sentry", "--scope", "global"])).toThrow('Invalid scope "global"');
  });

  test("throws on invalid env format", () => {
    expect(() => parseInstallArgs(["sentry", "--env", "NOEQUALS"])).toThrow('Invalid --env value "NOEQUALS"');
  });

  test("throws on --as without name", () => {
    expect(() => parseInstallArgs(["sentry", "--as"])).toThrow("--as requires a name");
  });

  test("throws on unknown flag", () => {
    expect(() => parseInstallArgs(["sentry", "--unknown"])).toThrow("Unknown flag: --unknown");
  });

  test("handles env value with equals signs", () => {
    const result = parseInstallArgs(["sentry", "--env", "URL=https://a.com?x=1"]);
    expect(result.env).toEqual({ URL: "https://a.com?x=1" });
  });

  test("parses --no-cache flag", () => {
    const result = parseInstallArgs(["sentry", "--no-cache"]);
    expect(result.noCache).toBe(true);
  });
});

// -- cmdInstall handler tests --

/** Build a fake registry response for a server with a streamable-http remote. */
function fakeRegistryResponse(slug: string, url: string): RegistryResponse {
  return {
    servers: [
      {
        server: {
          name: slug,
          title: slug,
          description: `The ${slug} server`,
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url }],
        },
        _meta: {
          "com.anthropic.api/mcp-registry": {
            slug,
            displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
            oneLiner: `${slug} integration`,
            isAuthless: true,
          },
        },
      },
    ],
    metadata: { count: 1 },
  };
}

function makeDeps(response: RegistryResponse): InstallDeps {
  return { searchRegistry: async () => response };
}

describe("cmdInstall", () => {
  test("installs http server from registry", async () => {
    using opts = testOptions();
    const deps = makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io"));

    await cmdInstall(["sentry"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.sentry).toEqual({ type: "http", url: "https://mcp.sentry.io" });
  });

  test("uses --as name for server key", async () => {
    using opts = testOptions();
    const deps = makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io"));

    await cmdInstall(["sentry", "--as", "my-sentry"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.["my-sentry"]).toEqual({ type: "http", url: "https://mcp.sentry.io" });
    expect(config.mcpServers?.sentry).toBeUndefined();
  });

  test("throws when slug not found in registry", async () => {
    using _opts = testOptions();
    const deps = makeDeps({ servers: [], metadata: { count: 0 } });

    await expect(cmdInstall(["nonexistent"], deps)).rejects.toThrow('Server "nonexistent" not found');
  });

  test("overwrites existing server", async () => {
    using opts = testOptions({
      files: { "servers.json": { mcpServers: { sentry: { command: "old" } } } },
    });
    const deps = makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io"));

    await cmdInstall(["sentry"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.sentry).toEqual({ type: "http", url: "https://mcp.sentry.io" });
  });

  test("installs stdio server from package", async () => {
    using opts = testOptions();
    const response: RegistryResponse = {
      servers: [
        {
          server: {
            name: "filesystem",
            title: "Filesystem",
            description: "File system access",
            version: "1.0.0",
            packages: [
              {
                registryType: "npm",
                identifier: "@modelcontextprotocol/server-filesystem",
                runtimeHint: "npx",
                transport: { type: "stdio" },
              },
            ],
          },
          _meta: {
            "com.anthropic.api/mcp-registry": {
              slug: "filesystem",
              displayName: "Filesystem",
              oneLiner: "File system access",
              isAuthless: true,
            },
          },
        },
      ],
      metadata: { count: 1 },
    };
    const deps = makeDeps(response);

    await cmdInstall(["filesystem"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });
  });

  test("exits with 1 on empty args", async () => {
    using _opts = testOptions();
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(cmdInstall([])).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("outputs JSON when --json flag is used", async () => {
    using _opts = testOptions();
    const logged: string[] = [];
    const deps: InstallDeps = {
      ...makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io")),
      log: (msg) => logged.push(msg),
    };

    await cmdInstall(["sentry", "--json"], deps);

    expect(logged).toHaveLength(1);
    const output = JSON.parse(logged[0]);
    expect(output.name).toBe("sentry");
    expect(output.config).toEqual({ type: "http", url: "https://mcp.sentry.io" });
  });
});
