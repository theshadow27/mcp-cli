import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { domainMatches, getSite, getSiteForDomain, listSites, validateSiteName, writeSiteConfig } from "./config";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `mcp-cli-site-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  options.SITES_DIR = join(tmp, "sites");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _restoreOptions();
});

describe("validateSiteName", () => {
  test("accepts plain alphanumerics and hyphens/underscores", () => {
    expect(() => validateSiteName("teams")).not.toThrow();
    expect(() => validateSiteName("my-site_2")).not.toThrow();
  });

  test("rejects path traversal and separators", () => {
    expect(() => validateSiteName("..")).toThrow(/Invalid site name/);
    expect(() => validateSiteName("../etc")).toThrow(/Invalid site name/);
    expect(() => validateSiteName("a/b")).toThrow(/Invalid site name/);
    expect(() => validateSiteName("a\\b")).toThrow(/Invalid site name/);
  });

  test("rejects empty or leading punctuation", () => {
    expect(() => validateSiteName("")).toThrow();
    expect(() => validateSiteName("-leading")).toThrow(/Invalid site name/);
    expect(() => validateSiteName("_leading")).toThrow(/Invalid site name/);
  });

  test("rejects names over 64 chars", () => {
    expect(() => validateSiteName("a".repeat(65))).toThrow(/Invalid site name/);
  });
});

describe("writeSiteConfig validates name", () => {
  test("rejects path-traversal names before touching disk", () => {
    expect(() => writeSiteConfig("../escape", { url: "https://x" })).toThrow(/Invalid site name/);
  });
});

describe("domainMatches", () => {
  test("exact match", () => {
    expect(domainMatches("foo.com", "foo.com")).toBe(true);
  });
  test("wildcard prefix", () => {
    expect(domainMatches("a.b.foo.com", "*.foo.com")).toBe(true);
    expect(domainMatches("foo.com", "*.foo.com")).toBe(true);
    expect(domainMatches("notfoo.com", "*.foo.com")).toBe(false);
  });
});

describe("writeSiteConfig + getSite", () => {
  test("round-trips a user-only site", () => {
    writeSiteConfig("example", { url: "https://example.com", domains: ["example.com"], enabled: true });
    const site = getSite("example");
    expect(site?.url).toBe("https://example.com");
    expect(site?.enabled).toBe(true);
    expect(site?.browser?.engine).toBe("playwright");
    expect(site?.browser?.chromeProfile).toBe("default");
  });

  test("returns null for unknown site", () => {
    expect(getSite("nope")).toBeNull();
  });

  test("listSites returns sorted unique set", () => {
    writeSiteConfig("z-site", { url: "https://z.example", domains: ["z.example"] });
    writeSiteConfig("a-site", { url: "https://a.example", domains: ["a.example"] });
    const names = listSites().map((s) => s.name);
    expect(names).toContain("a-site");
    expect(names).toContain("z-site");
    expect(names.indexOf("a-site")).toBeLessThan(names.indexOf("z-site"));
  });

  test("user config overrides browser.engine", () => {
    writeSiteConfig("wv", { url: "https://wv.example", domains: ["wv.example"], browser: { engine: "webview" } });
    expect(getSite("wv")?.browser?.engine).toBe("webview");
  });

  test("getSiteForDomain matches enabled site only", () => {
    writeSiteConfig("on", { url: "https://on.example", domains: ["*.on.example"], enabled: true });
    writeSiteConfig("off", { url: "https://off.example", domains: ["*.off.example"], enabled: false });
    expect(getSiteForDomain("a.on.example")).toBe("on");
    expect(getSiteForDomain("a.off.example")).toBeNull();
  });
});
