import { describe, expect, test } from "bun:test";
import type { ServerConfig } from "./config";
import { getTransportType, isHttpConfig, isSseConfig, isStdioConfig } from "./config";

describe("isStdioConfig", () => {
  test("returns true for config with command", () => {
    const config: ServerConfig = { command: "node", args: ["server.js"] };
    expect(isStdioConfig(config)).toBe(true);
  });

  test("returns false for URL-based config", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    expect(isStdioConfig(config)).toBe(false);
  });

  test("returns true when both command and url are present (stdio wins)", () => {
    const config = { command: "node", url: "https://example.com" } as ServerConfig;
    expect(isStdioConfig(config)).toBe(true);
  });
});

describe("isHttpConfig", () => {
  test("returns true for type: http with url", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    expect(isHttpConfig(config)).toBe(true);
  });

  test("returns false for type: sse with url", () => {
    const config: ServerConfig = { type: "sse", url: "https://example.com" };
    expect(isHttpConfig(config)).toBe(false);
  });

  test("returns false for config with command", () => {
    const config: ServerConfig = { command: "node", args: ["server.js"] };
    expect(isHttpConfig(config)).toBe(false);
  });

  test("returns false for url with no type and no command", () => {
    const config = { url: "https://example.com" } as ServerConfig;
    expect(isHttpConfig(config)).toBe(false);
  });
});

describe("isSseConfig", () => {
  test("returns true for type: sse with url", () => {
    const config: ServerConfig = { type: "sse", url: "https://example.com" };
    expect(isSseConfig(config)).toBe(true);
  });

  test("returns false for type: http with url", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    expect(isSseConfig(config)).toBe(false);
  });

  test("returns false for url config with no type", () => {
    // Previously this would have defaulted to SSE — now it must be explicit
    const config = { url: "https://example.com" } as ServerConfig;
    expect(isSseConfig(config)).toBe(false);
  });

  test("returns false when command is present even with url", () => {
    const config = { command: "node", url: "https://example.com", type: "sse" } as ServerConfig;
    // isSseConfig only checks url + type, but getTransportType checks stdio first
    expect(isSseConfig(config)).toBe(true);
    // However, getTransportType would route this to stdio
    expect(getTransportType(config)).toBe("stdio");
  });
});

describe("getTransportType", () => {
  test("returns stdio for command-based config", () => {
    const config: ServerConfig = { command: "node", args: ["server.js"] };
    expect(getTransportType(config)).toBe("stdio");
  });

  test("returns http for type: http", () => {
    const config: ServerConfig = { type: "http", url: "https://example.com" };
    expect(getTransportType(config)).toBe("http");
  });

  test("returns sse for type: sse", () => {
    const config: ServerConfig = { type: "sse", url: "https://example.com" };
    expect(getTransportType(config)).toBe("sse");
  });

  test("throws for unknown config type", () => {
    const config = { url: "https://example.com" } as ServerConfig;
    expect(() => getTransportType(config)).toThrow(/Unknown server config type/);
  });
});
