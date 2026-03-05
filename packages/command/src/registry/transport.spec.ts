import { describe, expect, test } from "bun:test";
import type { RegistryEntry } from "./client";
import { buildConfigFromSelection, selectTransport } from "./transport";

function makeEntry(overrides: Partial<RegistryEntry["server"]> = {}): RegistryEntry {
  return {
    server: {
      name: "test",
      title: "Test",
      description: "Test server",
      version: "1.0.0",
      ...overrides,
    },
    _meta: {
      "com.anthropic.api/mcp-registry": {
        slug: "test",
        displayName: "Test",
        oneLiner: "A test",
        isAuthless: true,
      },
    },
  };
}

describe("selectTransport", () => {
  test("prefers streamable-http over sse", () => {
    const entry = makeEntry({
      remotes: [
        { type: "sse", url: "https://sse.example.com" },
        { type: "streamable-http", url: "https://http.example.com" },
      ],
    });
    const result = selectTransport(entry);
    expect(result).toEqual({ kind: "remote", transport: "http", url: "https://http.example.com" });
  });

  test("falls back to sse when no http", () => {
    const entry = makeEntry({
      remotes: [{ type: "sse", url: "https://sse.example.com" }],
    });
    const result = selectTransport(entry);
    expect(result).toEqual({ kind: "remote", transport: "sse", url: "https://sse.example.com" });
  });

  test("falls back to package when no remotes", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "npm",
          identifier: "@example/mcp",
          runtimeHint: "npx",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.kind).toBe("package");
    expect(result?.transport).toBe("stdio");
    expect(result?.command).toBe("npx");
    expect(result?.commandArgs).toEqual(["-y", "@example/mcp"]);
  });

  test("skips templated URLs in favor of packages", () => {
    const entry = makeEntry({
      remotes: [{ type: "streamable-http", url: "https://{{host}}/mcp" }],
      packages: [
        {
          registryType: "npm",
          identifier: "some-pkg",
          runtimeHint: "npx",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.kind).toBe("package");
  });

  test("returns kind: templated when only option", () => {
    const entry = makeEntry({
      remotes: [{ type: "streamable-http", url: "https://{{host}}/mcp" }],
    });
    const result = selectTransport(entry);
    expect(result?.kind).toBe("templated");
    expect(result?.url).toBe("https://{{host}}/mcp");
  });

  test("returns null when no transport available", () => {
    const entry = makeEntry({});
    const result = selectTransport(entry);
    expect(result).toBeNull();
  });

  test("skips package without runtimeHint", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "npm",
          identifier: "some-pkg",
          runtimeHint: "",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result).toBeNull();
  });

  test("templated sse remote gets transport sse", () => {
    const entry = makeEntry({
      remotes: [{ type: "sse", url: "https://{{org}}.example.com/sse" }],
    });
    const result = selectTransport(entry);
    expect(result?.kind).toBe("templated");
    expect(result?.transport).toBe("sse");
  });

  test("npx gets -y flag", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "npm",
          identifier: "my-pkg",
          runtimeHint: "npx",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.command).toBe("npx");
    expect(result?.commandArgs).toEqual(["-y", "my-pkg"]);
  });

  test("uvx does not get -y flag", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "pypi",
          identifier: "my-pkg",
          runtimeHint: "uvx",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.command).toBe("uvx");
    expect(result?.commandArgs).toEqual(["my-pkg"]);
  });

  test("other runtimeHint uses hint as command", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "other",
          identifier: "my-pkg",
          runtimeHint: "docker",
          transport: { type: "stdio" },
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.command).toBe("docker");
    expect(result?.commandArgs).toEqual(["my-pkg"]);
  });

  test("passes envVars from package", () => {
    const entry = makeEntry({
      packages: [
        {
          registryType: "npm",
          identifier: "my-pkg",
          runtimeHint: "npx",
          transport: { type: "stdio" },
          environmentVariables: [{ name: "API_KEY", isRequired: true, isSecret: true, description: "Your API key" }],
        },
      ],
    });
    const result = selectTransport(entry);
    expect(result?.envVars).toEqual([
      { name: "API_KEY", isRequired: true, isSecret: true, description: "Your API key" },
    ]);
  });
});

describe("buildConfigFromSelection", () => {
  test("builds http config from remote", () => {
    const config = buildConfigFromSelection({
      kind: "remote",
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(config).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  test("builds sse config from remote", () => {
    const config = buildConfigFromSelection({
      kind: "remote",
      transport: "sse",
      url: "https://example.com/sse",
    });
    expect(config).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  test("builds stdio config from package", () => {
    const config = buildConfigFromSelection({
      kind: "package",
      transport: "stdio",
      command: "npx",
      commandArgs: ["-y", "my-pkg"],
    });
    expect(config).toEqual({ command: "npx", args: ["-y", "my-pkg"] });
  });

  test("merges env overrides into required vars", () => {
    const config = buildConfigFromSelection(
      {
        kind: "package",
        transport: "stdio",
        command: "npx",
        commandArgs: ["-y", "my-pkg"],
        envVars: [
          { name: "API_KEY", isRequired: true, isSecret: true },
          { name: "OPTIONAL", isRequired: false, isSecret: false },
        ],
      },
      { API_KEY: "my-key", EXTRA: "val" },
    );
    expect((config as { env?: Record<string, string> }).env).toEqual({
      API_KEY: "my-key",
      EXTRA: "val",
    });
  });

  test("sets empty placeholder for required vars without override", () => {
    const config = buildConfigFromSelection({
      kind: "package",
      transport: "stdio",
      command: "cmd",
      commandArgs: [],
      envVars: [{ name: "TOKEN", isRequired: true, isSecret: true }],
    });
    expect((config as { env?: Record<string, string> }).env).toEqual({ TOKEN: "" });
  });

  test("throws for templated selection", () => {
    expect(() =>
      buildConfigFromSelection({
        kind: "templated",
        transport: "http",
        url: "https://{{host}}/mcp",
      }),
    ).toThrow("Cannot auto-configure a server with templated URLs");
  });
});
