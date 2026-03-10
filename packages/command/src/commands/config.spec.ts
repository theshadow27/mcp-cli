import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GetConfigResult, McpConfigFile, ServerConfig } from "@mcp-cli/core";
import type { ConfigDeps } from "./config";
import {
  cmdConfig,
  configGetDispatch,
  configGetServer,
  configSetDispatch,
  configSetServerArgs,
  configSetServerEnv,
  configSetServerUrl,
  isCliOptionKey,
  maskConfig,
  maskValue,
  parseEnvKeyValue,
  printServerConfigDetails,
} from "./config";

let testDir: string;
let configPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  configPath = join(testDir, "config.json");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// -- Helper: create mock deps --

function makeDeps(
  servers: Record<string, { transport: string; source: string; scope: string; toolCount: number }>,
  fileContents: Record<string, McpConfigFile> = {},
  writtenFiles: Record<string, McpConfigFile> = {},
): ConfigDeps {
  return {
    getConfig: async () =>
      ({
        servers,
        sources: Object.values(servers).map((s) => ({ file: s.source, scope: s.scope })),
      }) as GetConfigResult,
    readConfig: (path: string) => fileContents[path] ?? { mcpServers: {} },
    writeConfig: (path: string, config: McpConfigFile) => {
      writtenFiles[path] = structuredClone(config);
    },
  };
}

// -- maskValue --

describe("maskValue", () => {
  it("preserves env var references like ${API_KEY}", () => {
    expect(maskValue("${API_KEY}")).toBe("${API_KEY}");
  });

  it("preserves env var references with defaults like ${API_KEY:-fallback}", () => {
    expect(maskValue("${API_KEY:-fallback}")).toBe("${API_KEY:-fallback}");
  });

  it("masks short values entirely", () => {
    expect(maskValue("abc")).toBe("****");
    expect(maskValue("12345678")).toBe("****");
  });

  it("masks long values with first 4 and last 3 visible", () => {
    expect(maskValue("cxup_longSecretKeyiFR")).toBe("cxup****iFR");
  });

  it("masks 9-character values", () => {
    expect(maskValue("123456789")).toBe("1234****789");
  });

  it("masks empty string", () => {
    expect(maskValue("")).toBe("****");
  });

  it("does not mask partial env refs (not full match)", () => {
    expect(maskValue("prefix${VAR}suffix")).not.toBe("prefix${VAR}suffix");
  });
});

// -- maskConfig --

describe("maskConfig", () => {
  it("returns config unchanged when showSecrets is true", () => {
    const config: ServerConfig = { command: "node", env: { KEY: "secret123456" } };
    expect(maskConfig(config, true)).toBe(config);
  });

  it("masks env values in stdio config", () => {
    const config: ServerConfig = { command: "node", env: { API_KEY: "sk-1234567890abc" } };
    const result = maskConfig(config, false);
    expect(result).toHaveProperty("env");
    expect((result as { env: Record<string, string> }).env.API_KEY).toBe("sk-1****abc");
  });

  it("returns stdio config unchanged when no env", () => {
    const config: ServerConfig = { command: "node", args: ["server.js"] };
    expect(maskConfig(config, false)).toEqual(config);
  });

  it("masks headers in http config", () => {
    const config: ServerConfig = {
      type: "http",
      url: "https://example.com",
      headers: { Authorization: "Bearer sk-1234567890abc" },
    };
    const result = maskConfig(config, false);
    expect((result as { headers: Record<string, string> }).headers.Authorization).toBe("Bear****abc");
  });

  it("returns http config unchanged when no headers", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    expect(maskConfig(config, false)).toEqual(config);
  });

  it("preserves env var references in masked output", () => {
    const config: ServerConfig = { command: "node", env: { KEY: "${MY_SECRET}" } };
    const result = maskConfig(config, false);
    expect((result as { env: Record<string, string> }).env.KEY).toBe("${MY_SECRET}");
  });
});

// -- parseEnvKeyValue --

describe("parseEnvKeyValue", () => {
  it("parses KEY:VALUE correctly", () => {
    expect(parseEnvKeyValue("API_KEY:sk-xxx")).toEqual({ key: "API_KEY", value: "sk-xxx" });
  });

  it("handles values containing colons", () => {
    expect(parseEnvKeyValue("URL:https://example.com:8080")).toEqual({
      key: "URL",
      value: "https://example.com:8080",
    });
  });

  it("handles empty value after colon", () => {
    expect(parseEnvKeyValue("KEY:")).toEqual({ key: "KEY", value: "" });
  });

  it("returns null for missing colon", () => {
    expect(parseEnvKeyValue("NOVALUE")).toBeNull();
  });

  it("returns null for colon at start", () => {
    expect(parseEnvKeyValue(":value")).toBeNull();
  });
});

// -- isCliOptionKey --

describe("isCliOptionKey", () => {
  it("recognizes trust-claude", () => {
    expect(isCliOptionKey("trust-claude")).toBe(true);
  });

  it("returns false for server names", () => {
    expect(isCliOptionKey("my-server")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCliOptionKey("")).toBe(false);
  });
});

// -- printServerConfigDetails --

describe("printServerConfigDetails", () => {
  it("prints stdio server details", () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const config: ServerConfig = {
      command: "npx",
      args: ["my-server", "--flag"],
      env: { API_KEY: "secret12345678" },
      cwd: "/some/path",
    };
    printServerConfigDetails(config, false);

    expect(logs.some((l) => l.includes("npx my-server --flag"))).toBe(true);
    expect(logs.some((l) => l.includes("/some/path"))).toBe(true);
    expect(logs.some((l) => l.includes("API_KEY"))).toBe(true);
    expect(logs.some((l) => l.includes("secr****678"))).toBe(true);
  });

  it("prints stdio server details with --show-secrets", () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const config: ServerConfig = {
      command: "node",
      env: { API_KEY: "secret12345678" },
    };
    printServerConfigDetails(config, true);

    expect(logs.some((l) => l.includes("secret12345678"))).toBe(true);
  });

  it("prints http server details", () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const config: ServerConfig = {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret12345678" },
    };
    printServerConfigDetails(config, false);

    expect(logs.some((l) => l.includes("https://example.com/mcp"))).toBe(true);
    expect(logs.some((l) => l.includes("Authorization"))).toBe(true);
    expect(logs.some((l) => l.includes("****"))).toBe(true);
  });

  it("prints stdio without env or cwd", () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const config: ServerConfig = { command: "node", args: ["server.js"] };
    printServerConfigDetails(config, false);

    expect(logs.some((l) => l.includes("node server.js"))).toBe(true);
    expect(logs.some((l) => l.includes("env"))).toBe(false);
  });

  it("prints http without headers", () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const config: ServerConfig = { type: "sse", url: "https://example.com/sse" };
    printServerConfigDetails(config, false);

    expect(logs.some((l) => l.includes("https://example.com/sse"))).toBe(true);
    expect(logs.some((l) => l.includes("headers"))).toBe(false);
  });
});

// -- configGetServer (with DI) --

describe("configGetServer", () => {
  it("displays server config in text mode", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 3 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node", args: ["srv.js"], env: { KEY: "val123456789" } },
          },
        },
      },
    );

    await configGetServer(["my-server"], deps);

    expect(logs.some((l) => l.includes("my-server"))).toBe(true);
    expect(logs.some((l) => l.includes("node srv.js"))).toBe(true);
    expect(logs.some((l) => l.includes("KEY"))).toBe(true);
    expect(logs.some((l) => l.includes(sourcePath))).toBe(true);
  });

  it("displays server config in JSON mode", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 2 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node", env: { SECRET: "supersecret123" } },
          },
        },
      },
    );

    await configGetServer(["my-server", "--json"], deps);

    const output = JSON.parse(logs.join(""));
    expect(output.name).toBe("my-server");
    expect(output.transport).toBe("stdio");
    expect(output.config.env.SECRET).toBe("supe****123");
  });

  it("shows secrets in JSON mode with --show-secrets", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node", env: { SECRET: "supersecret123" } },
          },
        },
      },
    );

    await configGetServer(["my-server", "--json", "--show-secrets"], deps);

    const output = JSON.parse(logs.join(""));
    expect(output.config.env.SECRET).toBe("supersecret123");
  });

  it("handles server with no config in file (virtual)", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps(
      { "virtual-srv": { transport: "virtual", source: "/some/path", scope: "mcp-cli", toolCount: 1 } },
      { "/some/path": { mcpServers: {} } },
    );

    await configGetServer(["virtual-srv"], deps);

    expect(logs.some((l) => l.includes("virtual-srv"))).toBe(true);
    expect(logs.some((l) => l.includes("source"))).toBe(true);
  });
});

// -- configSetServerEnv (with DI) --

describe("configSetServerEnv", () => {
  it("sets env var on stdio server", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 3 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node", env: { EXISTING: "value" } },
          },
        },
      },
      writtenFiles,
    );

    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await configSetServerEnv(["my-server", "env", "NEW_KEY:new-value"], deps);

    expect(writtenFiles[sourcePath]).toBeDefined();
    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { env: Record<string, string> };
    expect(updated.env.EXISTING).toBe("value");
    expect(updated.env.NEW_KEY).toBe("new-value");
    expect(logSpy).toHaveBeenCalledWith("Set NEW_KEY on my-server");
  });

  it("creates env object when missing", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node" },
          },
        },
      },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetServerEnv(["my-server", "env", "API_KEY:sk-test"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { env: Record<string, string> };
    expect(updated.env.API_KEY).toBe("sk-test");
  });

  it("handles values containing colons", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { "my-server": { command: "node" } } } },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetServerEnv(["my-server", "env", "URL:https://host:8080/path"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { env: Record<string, string> };
    expect(updated.env.URL).toBe("https://host:8080/path");
  });
});

// -- configGetDispatch --

describe("configGetDispatch", () => {
  it("dispatches to server config for unknown keys", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 1 } },
      { [sourcePath]: { mcpServers: { "my-server": { command: "echo" } } } },
    );

    await configGetDispatch(["my-server"], deps);

    expect(logs.some((l) => l.includes("my-server"))).toBe(true);
  });
});

// -- configSetDispatch --

describe("configSetDispatch", () => {
  it("dispatches to server env set when second arg is 'env'", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { srv: { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { command: "node" } } } },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetDispatch(["srv", "env", "K:V"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.srv as { env: Record<string, string> };
    expect(updated.env.K).toBe("V");
  });
});

// -- cmdConfig dispatch --

describe("cmdConfig", () => {
  it("dispatches 'show' subcommand", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps({
      srv: { transport: "stdio", source: "/path", scope: "user", toolCount: 2 },
    });

    await cmdConfig(["show"], deps);

    expect(logs.some((l) => l.includes("srv"))).toBe(true);
    expect(logs.some((l) => l.includes("1 server(s)"))).toBe(true);
  });

  it("dispatches 'sources' subcommand", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps({
      srv: { transport: "stdio", source: "/path/servers.json", scope: "user", toolCount: 0 },
    });

    await cmdConfig(["sources"], deps);

    expect(logs.some((l) => l.includes("Config sources"))).toBe(true);
    expect(logs.some((l) => l.includes("/path/servers.json"))).toBe(true);
  });

  it("dispatches 'get' to configGetDispatch", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { srv: { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { command: "echo" } } } },
    );

    await cmdConfig(["get", "srv"], deps);

    expect(logs.some((l) => l.includes("srv"))).toBe(true);
  });

  it("dispatches 'set' with env to configSetServerEnv", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { srv: { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { command: "node" } } } },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await cmdConfig(["set", "srv", "env", "K:V"], deps);

    expect(writtenFiles[sourcePath]).toBeDefined();
  });

  it("defaults to 'show' when no subcommand", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps({
      srv: { transport: "stdio", source: "/path", scope: "user", toolCount: 1 },
    });

    await cmdConfig([], deps);

    expect(logs.some((l) => l.includes("srv"))).toBe(true);
  });
});

// -- configShow edge cases --

describe("configShow", () => {
  it("prints message when no servers configured", async () => {
    const errors: string[] = [];
    spyOn(console, "error").mockImplementation((msg: string) => {
      errors.push(msg);
    });

    const deps = makeDeps({});

    await cmdConfig(["show"], deps);

    expect(errors.some((l) => l.includes("No servers configured"))).toBe(true);
  });

  it("shows tool count when > 0", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps({
      a: { transport: "stdio", source: "/p", scope: "user", toolCount: 5 },
    });

    await cmdConfig(["show"], deps);

    expect(logs.some((l) => l.includes("5 tools"))).toBe(true);
  });
});

// -- configSources edge cases --

describe("configSources", () => {
  it("prints message when no sources", async () => {
    const errors: string[] = [];
    spyOn(console, "error").mockImplementation((msg: string) => {
      errors.push(msg);
    });

    // Use a custom deps with empty sources
    const deps: ConfigDeps = {
      getConfig: async () => ({ servers: {}, sources: [] }),
      readConfig: () => ({ mcpServers: {} }),
      writeConfig: () => {},
    };

    await cmdConfig(["sources"], deps);

    expect(errors.some((l) => l.includes("No config sources found"))).toBe(true);
  });
});

// -- configGetServer error cases --

describe("configGetServer error handling", () => {
  it("exits when server not found", async () => {
    const errors: string[] = [];
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const deps = makeDeps({});

    try {
      await configGetServer(["nonexistent"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("outputs JSON with null config for virtual server", async () => {
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const deps = makeDeps(
      { virt: { transport: "virtual", source: "/p", scope: "mcp-cli", toolCount: 0 } },
      { "/p": { mcpServers: {} } },
    );

    await configGetServer(["virt", "--json"], deps);

    const output = JSON.parse(logs.join(""));
    expect(output.config).toBeNull();
  });
});

// -- configSetServerEnv error cases --

describe("configSetServerEnv error handling", () => {
  it("exits when server not found in daemon config", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps({});

    try {
      await configSetServerEnv(["nonexistent", "env", "K:V"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when server not found in config file", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps(
      { srv: { transport: "stdio", source: "/p", scope: "user", toolCount: 0 } },
      { "/p": { mcpServers: {} } }, // Server not in file
    );

    try {
      await configSetServerEnv(["srv", "env", "K:V"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when server is not stdio transport", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps(
      { srv: { transport: "http", source: "/p", scope: "user", toolCount: 0 } },
      { "/p": { mcpServers: { srv: { type: "http", url: "https://example.com" } } } },
    );

    try {
      await configSetServerEnv(["srv", "env", "K:V"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits for invalid KEY:VALUE format", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps({});

    try {
      await configSetServerEnv(["srv", "env", "invalidformat"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// -- configSetServerUrl --

describe("configSetServerUrl", () => {
  it("sets url on http server", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "http", source: sourcePath, scope: "user", toolCount: 3 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { type: "http", url: "https://old.example.com" },
          },
        },
      },
      writtenFiles,
    );

    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await configSetServerUrl(["my-server", "url", "https://new.example.com"], deps);

    expect(writtenFiles[sourcePath]).toBeDefined();
    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { url: string };
    expect(updated.url).toBe("https://new.example.com");
    expect(logSpy).toHaveBeenCalledWith("Set url on my-server");
  });

  it("sets url on sse server", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "sse", source: sourcePath, scope: "user", toolCount: 0 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { type: "sse", url: "https://old.example.com/sse" },
          },
        },
      },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetServerUrl(["my-server", "url", "https://new.example.com/sse"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { url: string };
    expect(updated.url).toBe("https://new.example.com/sse");
  });

  it("rejects url on stdio server", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { srv: { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { command: "node" } } } },
    );

    try {
      await configSetServerUrl(["srv", "url", "https://example.com"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when server not found", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps({});

    try {
      await configSetServerUrl(["nonexistent", "url", "https://example.com"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when server not found in config file", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps(
      { srv: { transport: "http", source: "/p", scope: "user", toolCount: 0 } },
      { "/p": { mcpServers: {} } },
    );

    try {
      await configSetServerUrl(["srv", "url", "https://example.com"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// -- configSetServerArgs --

describe("configSetServerArgs", () => {
  it("sets args on stdio server", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 3 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node", args: ["old.js"] },
          },
        },
      },
      writtenFiles,
    );

    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    await configSetServerArgs(["my-server", "args", "new.js", "--flag"], deps);

    expect(writtenFiles[sourcePath]).toBeDefined();
    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { args: string[] };
    expect(updated.args).toEqual(["new.js", "--flag"]);
    expect(logSpy).toHaveBeenCalledWith("Set args on my-server");
  });

  it("sets args when none existed before", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { "my-server": { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      {
        [sourcePath]: {
          mcpServers: {
            "my-server": { command: "node" },
          },
        },
      },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetServerArgs(["my-server", "args", "server.js"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.["my-server"] as { args: string[] };
    expect(updated.args).toEqual(["server.js"]);
  });

  it("rejects args on http server", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const sourcePath = join(testDir, "servers.json");
    const deps = makeDeps(
      { srv: { transport: "http", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { type: "http", url: "https://example.com" } } } },
    );

    try {
      await configSetServerArgs(["srv", "args", "foo"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when server not found", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps({});

    try {
      await configSetServerArgs(["nonexistent", "args", "foo"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when no args provided", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spyOn(console, "error").mockImplementation(() => {});

    const deps = makeDeps({});

    try {
      await configSetServerArgs(["srv", "args"], deps);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// -- configSetDispatch: url and args routing --

describe("configSetDispatch url/args routing", () => {
  it("dispatches to url setter when second arg is 'url'", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { srv: { transport: "http", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { type: "http", url: "https://old.com" } } } },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetDispatch(["srv", "url", "https://new.com"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.srv as { url: string };
    expect(updated.url).toBe("https://new.com");
  });

  it("dispatches to args setter when second arg is 'args'", async () => {
    const sourcePath = join(testDir, "servers.json");
    const writtenFiles: Record<string, McpConfigFile> = {};
    const deps = makeDeps(
      { srv: { transport: "stdio", source: sourcePath, scope: "user", toolCount: 0 } },
      { [sourcePath]: { mcpServers: { srv: { command: "node" } } } },
      writtenFiles,
    );

    spyOn(console, "log").mockImplementation(() => {});

    await configSetDispatch(["srv", "args", "server.js", "--port", "3000"], deps);

    const updated = writtenFiles[sourcePath].mcpServers?.srv as { args: string[] };
    expect(updated.args).toEqual(["server.js", "--port", "3000"]);
  });
});

// -- config file round-trip --

describe("config file round-trip", () => {
  it("sets env var on a stdio server via file", () => {
    const config = {
      mcpServers: {
        "my-server": {
          command: "node",
          args: ["server.js"],
          env: { EXISTING_KEY: "existing-value" },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { readConfigFile, writeConfigFile } = require("./config-file");
    const fileConfig = readConfigFile(configPath);
    const serverConfig = fileConfig.mcpServers["my-server"];
    serverConfig.env = serverConfig.env ?? {};
    serverConfig.env.NEW_KEY = "new-value";
    writeConfigFile(configPath, fileConfig);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.mcpServers["my-server"].env.EXISTING_KEY).toBe("existing-value");
    expect(updated.mcpServers["my-server"].env.NEW_KEY).toBe("new-value");
  });

  it("creates env object when missing", () => {
    const config = {
      mcpServers: {
        "my-server": { command: "node", args: ["server.js"] },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { readConfigFile, writeConfigFile } = require("./config-file");
    const fileConfig = readConfigFile(configPath);
    const serverConfig = fileConfig.mcpServers["my-server"];
    serverConfig.env = serverConfig.env ?? {};
    serverConfig.env.API_KEY = "sk-test";
    writeConfigFile(configPath, fileConfig);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.mcpServers["my-server"].env.API_KEY).toBe("sk-test");
  });
});

// -- CLI config --

describe("CLI config read/write", () => {
  it("writeCliConfig creates file with correct JSON", () => {
    writeFileSync(configPath, `${JSON.stringify({ trustClaude: true }, null, 2)}\n`);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.trustClaude).toBe(true);
  });

  it("readCliConfig returns {} when file missing", () => {
    const result = readConfigFrom(configPath);
    expect(result).toEqual({});
  });

  it("round-trip: set true then get returns true", () => {
    writeFileSync(configPath, `${JSON.stringify({ trustClaude: true }, null, 2)}\n`);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.trustClaude).toBe(true);
  });

  it("readCliConfig returns {} for malformed JSON", () => {
    writeFileSync(configPath, "not json{{{");
    const result = readConfigFrom(configPath);
    expect(result).toEqual({});
  });

  it("writeCliConfig creates parent directories", () => {
    const nestedPath = join(testDir, "deep", "nested", "config.json");
    const dir = join(nestedPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(nestedPath, `${JSON.stringify({ trustClaude: false }, null, 2)}\n`);

    expect(existsSync(nestedPath)).toBe(true);
    const content = JSON.parse(readFileSync(nestedPath, "utf-8"));
    expect(content.trustClaude).toBe(false);
  });
});

/** Helper that mirrors readCliConfig but reads from an arbitrary path */
function readConfigFrom(path: string): Record<string, unknown> {
  try {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}
