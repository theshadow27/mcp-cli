import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { loadCatalog } from "./catalog";
import { getSite, listSites } from "./config";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `mcp-cli-site-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  options.SITES_DIR = join(tmp, "sites");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _restoreOptions();
});

describe("built-in teams seed", () => {
  test("listSites includes teams with merged seed config", () => {
    const names = listSites().map((s) => s.name);
    expect(names).toContain("teams");
    const teams = getSite("teams");
    expect(teams?.url).toBe("https://teams.cloud.microsoft/v2/");
    expect(teams?.domains).toContain("*.teams.microsoft.com");
    expect(teams?.blockProtocols).toContain("msteams://");
    expect(teams?.browser?.engine).toBe("playwright");
    expect(teams?.browser?.chromeProfile).toBe("default");
  });

  test("loadCatalog seeds teams catalog on first read", () => {
    const catalog = loadCatalog("teams", "teams");
    const names = Object.keys(catalog);
    expect(names.length).toBeGreaterThan(0);
    for (const call of Object.values(catalog)) {
      expect(call.name).toBeTruthy();
      expect(call.url).toMatch(/^https?:\/\//);
      expect(call.method).toBeTruthy();
    }
  });
});

describe("built-in owa seed", () => {
  test("listSites includes owa with merged seed config", () => {
    const names = listSites().map((s) => s.name);
    expect(names).toContain("owa");
    const owa = getSite("owa");
    expect(owa?.url).toBe("https://outlook.cloud.microsoft/mail/");
    expect(owa?.domains).toContain("*.outlook.cloud.microsoft");
    expect(owa?.domains).toContain("substrate.office.com");
    expect(owa?.browser?.engine).toBe("playwright");
  });

  test("loadCatalog seeds owa catalog on first read", () => {
    const catalog = loadCatalog("owa", "owa");
    const names = Object.keys(catalog);
    expect(names).toContain("inbox");
    expect(names).toContain("read_mail");
    for (const call of Object.values(catalog)) {
      expect(call.name).toBeTruthy();
      expect(call.url).toMatch(/^https?:\/\//);
      expect(call.method).toBe("POST");
    }
  });

  test("all owa calls declare fetchFilter and jq transforms", () => {
    const catalog = loadCatalog("owa", "owa");
    for (const call of Object.values(catalog)) {
      expect(call.fetchFilter).toBe("owa-urlpostdata");
      expect(call.jq_input).toBeTruthy();
      expect(call.jq_output).toBeTruthy();
    }
  });
});
