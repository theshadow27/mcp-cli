import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { siteBrowserProfileDir } from "./paths";

beforeEach(() => {
  const tmp = join(tmpdir(), `mcp-cli-paths-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  options.SITES_DIR = join(tmp, "sites");
});

afterEach(() => {
  _restoreOptions();
});

describe("siteBrowserProfileDir", () => {
  test("accepts a simple profile name", () => {
    expect(() => siteBrowserProfileDir("mysite", "default")).not.toThrow();
    expect(() => siteBrowserProfileDir("mysite", "work")).not.toThrow();
    expect(() => siteBrowserProfileDir("mysite", "profile-1")).not.toThrow();
  });

  test("returns a path under the site chromium directory", () => {
    const dir = siteBrowserProfileDir("mysite", "default");
    expect(dir).toMatch(/mysite[\\/]chromium[\\/]default/);
  });

  test("rejects profile containing forward slash", () => {
    expect(() => siteBrowserProfileDir("mysite", "../../default")).toThrow(/Invalid chromeProfile/);
    expect(() => siteBrowserProfileDir("mysite", "foo/bar")).toThrow(/Invalid chromeProfile/);
  });

  test("rejects profile containing backslash", () => {
    expect(() => siteBrowserProfileDir("mysite", "foo\\bar")).toThrow(/Invalid chromeProfile/);
  });

  test("rejects profile that is '..' alone", () => {
    expect(() => siteBrowserProfileDir("mysite", "..")).toThrow(/Invalid chromeProfile/);
  });

  test("error message mentions path separators and '..' segments", () => {
    expect(() => siteBrowserProfileDir("mysite", "../../default")).toThrow(/no path separators or '\.\.'/);
  });
});
