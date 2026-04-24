import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _restoreOptions, options } from "@mcp-cli/core";
import { loadCatalog } from "./catalog";
import { getBuiltinWiggleSource, getSite, listSites } from "./config";
import { BUILTIN_SEEDS } from "./seeds";

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

describe("embedded seed data (compiled-binary support)", () => {
  test("BUILTIN_SEEDS contains teams and owa", () => {
    expect(Object.keys(BUILTIN_SEEDS).sort()).toEqual(["owa", "teams"]);
  });

  test("teams seed has config, catalog, searchTemplate, and wiggleSrc", () => {
    const teams = BUILTIN_SEEDS.teams;
    expect(teams.config.url).toBe("https://teams.cloud.microsoft/v2/");
    expect(Object.keys(teams.catalog).length).toBeGreaterThan(0);
    expect(teams.searchTemplate).toBeDefined();
    expect(teams.wiggleSrc).toContain("AUTOSUGGEST_INPUT");
  });

  test("owa seed has config, catalog, and wiggleSrc", () => {
    const owa = BUILTIN_SEEDS.owa;
    expect(owa.config.url).toBe("https://outlook.cloud.microsoft/mail/");
    expect(Object.keys(owa.catalog).length).toBeGreaterThan(0);
    expect(owa.wiggleSrc).toContain("New mail");
  });

  test("getBuiltinWiggleSource returns source for known seeds", () => {
    expect(getBuiltinWiggleSource("teams")).toContain("module.exports");
    expect(getBuiltinWiggleSource("owa")).toContain("module.exports");
  });

  test("getBuiltinWiggleSource returns null for unknown seeds", () => {
    expect(getBuiltinWiggleSource("nonexistent")).toBeNull();
  });

  test("search_teams body_default is inlined from searchTemplate", () => {
    const catalog = loadCatalog("teams", "teams");
    const searchTeams = catalog.search_teams;
    expect(searchTeams.body_default).toBeTruthy();
    expect(searchTeams.body_default).toHaveProperty("EntityRequests");
  });

  test("embedded wiggle sources evaluate to callable async functions via new Function wrapper", async () => {
    // Verifies the CJS eval path in playwright.ts actually produces a runnable wiggle function.
    // Uses a zero-hit mock page so all locator branches are skipped and the function returns [].
    const mockLocator: Record<string, unknown> = {
      count: async () => 0,
      click: async () => {},
      fill: async () => {},
      press: async () => {},
      hover: async () => {},
    };
    mockLocator.first = () => mockLocator;
    const mockPage = {
      locator: () => mockLocator,
      goto: async () => {
        throw new Error("no browser");
      },
      waitForTimeout: async () => {},
    };

    for (const [seedName, seed] of Object.entries(BUILTIN_SEEDS)) {
      if (!seed.wiggleSrc) continue;
      const mod = { exports: {} as Record<string, unknown> };
      new Function("module", "exports", "process", seed.wiggleSrc)(mod, mod.exports, process);
      expect(typeof mod.exports).toBe("function"); // fails if module.exports was never assigned
      const result = await (mod.exports as unknown as (page: unknown) => Promise<string[]>)(mockPage);
      expect(Array.isArray(result)).toBe(true); // fails if wiggle throws or returns wrong type
      void seedName; // referenced in test name only
    }
  });
});
