import { describe, expect, test } from "bun:test";
import { parseInstallArgs } from "./install.js";

describe("parseInstallArgs", () => {
  test("parses slug only", () => {
    const result = parseInstallArgs(["sentry"]);
    expect(result.slug).toBe("sentry");
    expect(result.name).toBeUndefined();
    expect(result.scope).toBe("user");
    expect(result.env).toEqual({});
    expect(result.json).toBe(false);
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
});
