import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { _resetCache, playwrightCandidates, resolvePlaywright } from "./resolve-playwright";

afterEach(() => {
  _resetCache();
});

describe("playwrightCandidates", () => {
  test("always includes vendor dir as first candidate", () => {
    const candidates = playwrightCandidates();
    expect(candidates[0]).toBe(join(homedir(), ".mcp-cli", "vendor", "playwright", "node_modules", "playwright"));
  });

  test("includes cwd/node_modules/playwright", () => {
    const candidates = playwrightCandidates();
    expect(candidates).toContain(join(process.cwd(), "node_modules", "playwright"));
  });

  test("includes BUN_INSTALL path when env var is set", () => {
    const prev = process.env.BUN_INSTALL;
    try {
      process.env.BUN_INSTALL = "/fake/bun";
      const candidates = playwrightCandidates();
      expect(candidates).toContain(join("/fake/bun", "install", "global", "node_modules", "playwright"));
    } finally {
      if (prev === undefined) process.env.BUN_INSTALL = undefined;
      else process.env.BUN_INSTALL = prev;
    }
  });

  test("omits BUN_INSTALL path when env var is unset", () => {
    const prev = process.env.BUN_INSTALL;
    try {
      process.env.BUN_INSTALL = undefined;
      const candidates = playwrightCandidates();
      expect(candidates.some((c) => c.includes("install/global"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env.BUN_INSTALL = prev;
    }
  });
});

describe("resolvePlaywright", () => {
  test("resolves from cwd node_modules in dev environment", async () => {
    const cwdPkg = join(process.cwd(), "node_modules", "playwright");
    if (!existsSync(cwdPkg)) {
      console.log("skipping — playwright not installed locally");
      return;
    }

    const chromium = await resolvePlaywright();
    expect(chromium).toBeDefined();
    expect(typeof chromium.launchPersistentContext).toBe("function");
  });

  test("caches result across calls", async () => {
    const cwdPkg = join(process.cwd(), "node_modules", "playwright");
    if (!existsSync(cwdPkg)) {
      console.log("skipping — playwright not installed locally");
      return;
    }

    const first = await resolvePlaywright();
    const second = await resolvePlaywright();
    expect(first).toBe(second);
  });

  test("surfaces useful error when no candidates exist and install fails", async () => {
    const result = resolvePlaywright({
      candidates: ["/nonexistent/path/playwright"],
      install: () => ({ exitCode: 1, stderr: "network unreachable" }),
    });

    await expect(result).rejects.toThrow(/Failed to auto-install playwright/);
    await expect(result).rejects.toThrow(/network unreachable/);
    await expect(result).rejects.toThrow(/Install manually/);
  });

  test("surfaces useful error when install succeeds but package missing", async () => {
    const result = resolvePlaywright({
      candidates: ["/nonexistent/path/playwright"],
      install: () => ({ exitCode: 0, stderr: "" }),
    });

    await expect(result).rejects.toThrow(/package not found/);
    await expect(result).rejects.toThrow(/Install manually/);
  });
});
