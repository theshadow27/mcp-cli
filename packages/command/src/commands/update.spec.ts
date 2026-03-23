import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { McpConfigFile } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import type { RegistryResponse } from "../registry/client";
import { type UpdateDeps, cmdUpdate, parseUpdateArgs } from "./update";

describe("parseUpdateArgs", () => {
  test("parses slug only", () => {
    const result = parseUpdateArgs(["sentry"]);
    expect(result.slug).toBe("sentry");
    expect(result.all).toBe(false);
    expect(result.scope).toBe("user");
    expect(result.json).toBe(false);
    expect(result.noCache).toBe(false);
  });

  test("parses --all flag", () => {
    const result = parseUpdateArgs(["--all"]);
    expect(result.all).toBe(true);
    expect(result.slug).toBeUndefined();
  });

  test("parses -a short flag", () => {
    const result = parseUpdateArgs(["-a"]);
    expect(result.all).toBe(true);
  });

  test("parses --scope flag", () => {
    const result = parseUpdateArgs(["sentry", "--scope", "project"]);
    expect(result.scope).toBe("project");
  });

  test("parses --no-cache flag", () => {
    const result = parseUpdateArgs(["sentry", "--no-cache"]);
    expect(result.noCache).toBe(true);
  });

  test("parses --json flag", () => {
    const result = parseUpdateArgs(["sentry", "-j"]);
    expect(result.json).toBe(true);
  });

  test("throws on missing slug without --all", () => {
    expect(() => parseUpdateArgs([])).toThrow("Usage:");
  });

  test("throws on unknown flag", () => {
    expect(() => parseUpdateArgs(["sentry", "--unknown"])).toThrow("Unknown flag: --unknown");
  });
});

// -- cmdUpdate handler tests --

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

function makeDeps(response: RegistryResponse): UpdateDeps {
  return { searchRegistry: async () => response };
}

describe("cmdUpdate", () => {
  test("updates server when config differs", async () => {
    using opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: { sentry: { type: "http", url: "https://old.sentry.io" } },
        },
      },
    });
    const deps = makeDeps(fakeRegistryResponse("sentry", "https://new.sentry.io"));

    await cmdUpdate(["sentry"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.sentry).toEqual({ type: "http", url: "https://new.sentry.io" });
  });

  test("reports up-to-date when config matches", async () => {
    using _opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.io" } },
        },
      },
    });
    const errors: string[] = [];
    const deps: UpdateDeps = {
      ...makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io")),
      error: (msg) => errors.push(msg),
    };

    await cmdUpdate(["sentry"], deps);
    expect(errors.some((c) => c.includes("up to date"))).toBe(true);
  });

  test("throws when server not installed", async () => {
    using _opts = testOptions();
    const deps = makeDeps({ servers: [], metadata: { count: 0 } });

    await expect(cmdUpdate(["nonexistent"], deps)).rejects.toThrow("not found");
  });

  test("--all checks all installed servers", async () => {
    using opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: {
            sentry: { type: "http", url: "https://old.sentry.io" },
            other: { command: "some-command" },
          },
        },
      },
    });
    // Registry only knows about sentry
    const deps: UpdateDeps = {
      searchRegistry: async (query: string) => {
        if (query === "sentry") {
          return fakeRegistryResponse("sentry", "https://new.sentry.io");
        }
        return { servers: [], metadata: { count: 0 } };
      },
    };

    await cmdUpdate(["--all"], deps);

    const config = JSON.parse(readFileSync(opts.USER_SERVERS_PATH, "utf-8")) as McpConfigFile;
    expect(config.mcpServers?.sentry).toEqual({ type: "http", url: "https://new.sentry.io" });
    // "other" should be untouched
    expect(config.mcpServers?.other).toEqual({ command: "some-command" });
  });

  test("outputs JSON when --json flag is used", async () => {
    using _opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.io" } },
        },
      },
    });
    const logged: string[] = [];
    const deps: UpdateDeps = {
      ...makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io")),
      log: (msg) => logged.push(msg),
    };

    await cmdUpdate(["sentry", "--json"], deps);

    expect(logged).toHaveLength(1);
    const output = JSON.parse(logged[0]);
    expect(output.name).toBe("sentry");
    expect(output.status).toBe("up-to-date");
  });

  test("--all with --json returns array", async () => {
    using _opts = testOptions({
      files: {
        "servers.json": {
          mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.io" } },
        },
      },
    });
    const logged: string[] = [];
    const deps: UpdateDeps = {
      ...makeDeps(fakeRegistryResponse("sentry", "https://mcp.sentry.io")),
      log: (msg) => logged.push(msg),
    };

    await cmdUpdate(["--all", "--json"], deps);

    expect(logged).toHaveLength(1);
    const output = JSON.parse(logged[0]);
    expect(Array.isArray(output)).toBe(true);
    expect(output[0].name).toBe("sentry");
  });

  test("exits with 1 on empty args", async () => {
    using _opts = testOptions();
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(cmdUpdate([])).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
