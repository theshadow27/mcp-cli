import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  _defaultInstall,
  _resetCache,
  _resolveBunBinary,
  playwrightCandidates,
  resolvePlaywright,
} from "./resolve-playwright";

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
      // Force the post-install existence check to fail regardless of whether
      // playwright is already installed in the real vendor dir on this machine.
      vendorPkg: "/nonexistent/vendor/playwright",
    });

    await expect(result).rejects.toThrow(/package not found/);
    await expect(result).rejects.toThrow(/Install manually/);
  });
});

describe("_resolveBunBinary", () => {
  const vendorDir = join(tmpdir(), "mcx-playwright-test-vendor");

  test("finds bun on PATH in test environment", () => {
    // bun is executing these tests, so Bun.which must resolve it
    const bin = _resolveBunBinary(vendorDir);
    expect(bin).toBeTruthy();
    expect(existsSync(bin)).toBe(true);
  });

  test("falls back to BUN_INSTALL/bin/bun when PATH returns nothing", () => {
    // Provide the real bun location via BUN_INSTALL so we can verify the fallback
    // without touching process.env.PATH (which could break other tests).
    const realBin = Bun.which("bun");
    if (!realBin) return; // skip if bun truly isn't on PATH
    const bunInstallDir = join(realBin, "..", ".."); // .../bin/bun → ...
    const bin = _resolveBunBinary(vendorDir, {
      which: () => null,
      bunInstallEnv: bunInstallDir,
      homeDir: "/nonexistent/home",
    });
    expect(existsSync(bin)).toBe(true);
  });

  test("falls back to ~/.bun/bin/bun when PATH and BUN_INSTALL are absent", () => {
    const realBin = Bun.which("bun");
    if (!realBin) return;
    // Treat the directory two levels above the real bun as the fake home so
    // ~/.bun/bin/bun resolves to the actual binary.
    const fakeHome = join(realBin, "..", "..", "..");
    const bin = _resolveBunBinary(vendorDir, {
      which: () => null,
      bunInstallEnv: undefined,
      homeDir: fakeHome,
    });
    expect(existsSync(bin)).toBe(true);
  });

  test("throws Install bun message when nothing found", () => {
    expect(() =>
      _resolveBunBinary(vendorDir, {
        which: () => null,
        bunInstallEnv: undefined,
        homeDir: "/nonexistent/home",
      }),
    ).toThrow(/Install bun/);
    expect(() =>
      _resolveBunBinary(vendorDir, {
        which: () => null,
        bunInstallEnv: undefined,
        homeDir: "/nonexistent/home",
      }),
    ).toThrow("https://bun.sh");
  });
});

describe("_defaultInstall", () => {
  const vendorDir = join(tmpdir(), "mcx-playwright-test-vendor");

  test("wraps spawn ENOENT with Install manually message and preserves cause", async () => {
    // Use a path that cannot be a valid executable so Bun.spawn throws ENOENT.
    const err = await _defaultInstall(vendorDir, "/nonexistent/bun-binary").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Install manually/);
    expect((err as Error & { cause: unknown }).cause).toBeInstanceOf(Error);
  });
});
