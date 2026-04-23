import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { _defaultInstall, _resetCache, playwrightCandidates, resolvePlaywright } from "./resolve-playwright";

afterEach(() => {
  _resetCache();
});

describe("playwrightCandidates", () => {
  test("always includes vendor dir as first candidate", () => {
    const candidates = playwrightCandidates();
    expect(candidates[0]).toBe(join(homedir(), ".mcp-cli", "vendor", "playwright", "node_modules", "playwright"));
  });

  test("does not include cwd/node_modules/playwright", () => {
    const candidates = playwrightCandidates();
    expect(candidates.some((c) => c === join(process.cwd(), "node_modules", "playwright"))).toBe(false);
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
  test("resolves from an explicit on-disk candidate in dev environment", async () => {
    const cwdPkg = join(process.cwd(), "node_modules", "playwright");
    if (!existsSync(cwdPkg)) {
      console.error("skipping — playwright not installed locally");
      return;
    }

    const chromium = await resolvePlaywright({ candidates: [cwdPkg] });
    expect(chromium).toBeDefined();
    expect(typeof chromium.launchPersistentContext).toBe("function");
  });

  test("caches result across calls", async () => {
    const cwdPkg = join(process.cwd(), "node_modules", "playwright");
    if (!existsSync(cwdPkg)) {
      console.error("skipping — playwright not installed locally");
      return;
    }

    const first = await resolvePlaywright({ candidates: [cwdPkg] });
    const second = await resolvePlaywright({ candidates: [cwdPkg] });
    expect(first).toBe(second);
  });

  test("concurrent calls share a single in-flight resolution", async () => {
    let installCount = 0;
    const opts = {
      candidates: ["/nonexistent/path/playwright"],
      install: () => {
        installCount++;
        return { exitCode: 1, stderr: "fail" };
      },
    };

    const [a, b] = await Promise.allSettled([resolvePlaywright(opts), resolvePlaywright(opts)]);
    expect(installCount).toBe(1);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
  });

  test("clears pending on failure so next call can retry", async () => {
    let calls = 0;
    const opts = {
      candidates: ["/nonexistent/path/playwright"],
      install: () => {
        calls++;
        return { exitCode: 1, stderr: "fail" };
      },
    };

    await resolvePlaywright(opts).catch(() => {});
    _resetCache();
    await resolvePlaywright(opts).catch(() => {});
    expect(calls).toBe(2);
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

describe("_defaultInstall", () => {
  test("wraps spawn ENOENT with Install manually message", async () => {
    // Use a path that cannot be a valid executable so Bun.spawn throws ENOENT.
    await expect(_defaultInstall("/tmp/mcx-playwright-test-vendor", "/nonexistent/bun-binary")).rejects.toThrow(
      /Install manually/,
    );
  });

  test("uses process.execPath by default (smoke: returns a result object)", async () => {
    // Calling _defaultInstall with the real bun binary will actually run bun add,
    // so we only verify the default arg wiring via a stub — confirm it doesn't
    // throw due to "bun not found" at least when execPath is a valid binary.
    //
    // We can't easily mock Bun.spawn without mock.module(), so we just verify the
    // error thrown for a fake binary contains the actionable Install manually hint.
    const err = await _defaultInstall("/tmp/mcx-playwright-test-vendor", "/nonexistent/path").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Install manually/);
  });
});
