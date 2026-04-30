import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../manifest-lock";
import {
  defaultExtractEntitlements,
  defaultResignBinary,
  defaultSmokeTest,
  defaultVersionResolver,
  readCurrentPatchedMeta,
  resolveSourceClaudePath,
  updatePatchedClaude,
} from "./patcher";
import type { PatcherDeps } from "./patcher";

/** Unset an env var properly (assigning undefined would coerce to string "undefined"). */
function unsetEnv(key: string): void {
  delete process.env[key];
}

/** Restore an env var captured by `process.env.X` to its original state. */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) unsetEnv(key);
  else process.env[key] = prev;
}

const enc = new TextEncoder();

function makeFakeDeps(overrides: Partial<PatcherDeps> = {}): PatcherDeps {
  // Default fake deps that simulate a successful sign+smoke flow without
  // touching real codesign or spawning claude.
  return {
    versionResolver: async () => "2.1.121",
    extractEntitlements: async () => "<plist><dict/></plist>",
    resignBinary: async () => {},
    smokeTest: async () => {},
    readBytes: (path) => new Uint8Array(readFileSync(path)),
    writeBytesAtomic: (path, bytes) => {
      writeFileSync(path, bytes, { mode: 0o755 });
    },
    ...overrides,
  };
}

function makeFakeClaudeBinary(dir: string, version: string, hostOccurrences = 4): string {
  const path = join(dir, "fake-claude");
  // Synthetic binary with the target string at multiple sites, plus filler.
  const parts: string[] = [`#!fake-claude version=${version}\n`];
  for (let i = 0; i < hostOccurrences; i++) {
    parts.push(`...filler${i}...claude-staging.fedstart.com...filler${i}...`);
  }
  parts.push("end-of-file");
  writeFileSync(path, parts.join(""), { mode: 0o755 });
  return path;
}

describe("updatePatchedClaude", () => {
  let tmpDir: string;
  let storeDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "patcher-test-"));
    storeDir = join(tmpDir, "store");
  });

  afterAll(() => {
    // Best-effort cleanup. Tests use unique tmpdirs so this is mostly a courtesy.
  });

  test("noop strategy for old versions", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.119");
    const result = await updatePatchedClaude(
      { sourcePath, storeDir },
      makeFakeDeps({ versionResolver: async () => "2.1.119" }),
    );
    expect(result.status).toBe("noop");
    if (result.status !== "noop") throw new Error("typeguard");
    expect(result.strategyId).toBe("noop-pre-2.1.120");
    // Store dir should not contain a patched binary.
    expect(existsSync(join(storeDir, "current"))).toBe(false);
  });

  test("patches 2.1.121 binary end-to-end", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const result = await updatePatchedClaude({ sourcePath, storeDir }, makeFakeDeps());
    expect(result.status).toBe("patched");
    if (result.status !== "patched") throw new Error("typeguard");
    expect(result.strategyId).toBe("host-check-ipv6-loopback-v1");
    expect(existsSync(result.patchedPath)).toBe(true);
    expect(existsSync(result.currentLink)).toBe(true);

    const patched = new Uint8Array(readFileSync(result.patchedPath));
    const decoded = new TextDecoder().decode(patched);
    expect(decoded).not.toContain("claude-staging.fedstart.com");
    expect(decoded.split("[000:000:000:000:000:0:0:1]").length - 1).toBe(4);
  });

  test("idempotent — second call returns already-current", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const deps = makeFakeDeps();
    let signCount = 0;
    deps.resignBinary = async () => {
      signCount++;
    };
    await updatePatchedClaude({ sourcePath, storeDir }, deps);
    expect(signCount).toBe(1);

    const second = await updatePatchedClaude({ sourcePath, storeDir }, deps);
    expect(second.status).toBe("already-current");
    expect(signCount).toBe(1); // didn't re-sign
  });

  test("force re-patches even when cached", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const deps = makeFakeDeps();
    let signCount = 0;
    deps.resignBinary = async () => {
      signCount++;
    };
    await updatePatchedClaude({ sourcePath, storeDir }, deps);
    await updatePatchedClaude({ sourcePath, storeDir, force: true }, deps);
    expect(signCount).toBe(2);
  });

  test("source-hash change triggers re-patch", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const deps = makeFakeDeps();
    await updatePatchedClaude({ sourcePath, storeDir }, deps);

    // Simulate auto-update by rewriting the source binary.
    const newContent = `#!new-version\n${"claude-staging.fedstart.com\n".repeat(4)}different-filler-bytes-different-filler-bytes\n`;
    writeFileSync(sourcePath, newContent, { mode: 0o755 });

    let signCount = 0;
    deps.resignBinary = async () => {
      signCount++;
    };
    const second = await updatePatchedClaude({ sourcePath, storeDir }, deps);
    expect(second.status).toBe("patched");
    expect(signCount).toBe(1);
  });

  test("unsupported version returns unsupported outcome", async () => {
    // The built-in registry has no gaps (noop covers <2.1.120, ipv6-loopback
    // covers everything from 2.1.120 onward), so to exercise the "unsupported"
    // path we inject an empty strategy registry. This still validates the
    // patcher's failure mode for the real-world case where a future claude
    // release ships a check that no registered strategy can handle.
    const sourcePath = makeFakeClaudeBinary(tmpDir, "9.9.9");
    const result = await updatePatchedClaude(
      { sourcePath, storeDir },
      makeFakeDeps({ versionResolver: async () => "9.9.9", strategies: [] }),
    );
    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported") throw new Error("typeguard");
    expect(result.reason).toMatch(/No patch strategy/);
    expect(result.reason).toMatch(/9\.9\.9/);
  });

  test("validation failure aborts the patch", async () => {
    // Synthetic binary missing the source string — strategy will produce
    // 0 replacements, validation will reject.
    const sourcePath = join(tmpDir, "broken-claude");
    writeFileSync(sourcePath, "no target string here", { mode: 0o755 });
    const deps = makeFakeDeps({ versionResolver: async () => "2.1.121" });
    expect(updatePatchedClaude({ sourcePath, storeDir }, deps)).rejects.toThrow(/validation failed/);
  });

  test("never modifies the source binary", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const beforeBytes = readFileSync(sourcePath);
    const beforeHash = sha256Hex(new Uint8Array(beforeBytes));

    await updatePatchedClaude({ sourcePath, storeDir }, makeFakeDeps());

    const afterBytes = readFileSync(sourcePath);
    const afterHash = sha256Hex(new Uint8Array(afterBytes));
    expect(afterHash).toBe(beforeHash);
  });

  test("smoke test failure surfaces as error and does not publish", async () => {
    const sourcePath = makeFakeClaudeBinary(tmpDir, "2.1.121");
    const deps = makeFakeDeps({
      smokeTest: async () => {
        throw new Error("simulated smoke test failure");
      },
    });
    expect(updatePatchedClaude({ sourcePath, storeDir }, deps)).rejects.toThrow(/smoke/);
    // No metadata or current link should exist after a failed smoke.
    expect(existsSync(join(storeDir, "current"))).toBe(false);
    expect(existsSync(join(storeDir, "2.1.121.meta.json"))).toBe(false);
  });
});

describe("readCurrentPatchedMeta", () => {
  test("returns null when store is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-meta-test-"));
    expect(readCurrentPatchedMeta(join(tmp, "missing"))).toBeNull();
  });

  test("returns metadata after a successful update", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-meta-test-"));
    const sourcePath = makeFakeClaudeBinary(tmp, "2.1.121");
    const storeDir = join(tmp, "store");
    await updatePatchedClaude({ sourcePath, storeDir }, makeFakeDeps());
    const meta = readCurrentPatchedMeta(storeDir);
    expect(meta).not.toBeNull();
    expect(meta?.version).toBe("2.1.121");
    expect(meta?.strategyId).toBe("host-check-ipv6-loopback-v1");
    expect(meta?.sourcePath).toBe(sourcePath);
  });

  test("ignores malformed meta.json (returns null)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-meta-test-"));
    // Write a current symlink/pointer that targets a nonsense meta path.
    const link = join(tmp, "current");
    writeFileSync(link, join(tmp, "ghost.patched"), { mode: 0o644 });
    writeFileSync(join(tmp, "ghost.meta.json"), "{ not valid json", { mode: 0o644 });
    expect(readCurrentPatchedMeta(tmp)).toBeNull();
  });

  test("resolves a pointer-file fallback (non-symlink current)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-meta-test-"));
    // Write a pointer file (plain file) as `current` instead of a symlink.
    writeFileSync(join(tmp, "1.2.3.patched"), "stub", { mode: 0o755 });
    writeFileSync(
      join(tmp, "1.2.3.meta.json"),
      JSON.stringify({
        version: "1.2.3",
        strategyId: "test",
        sourcePath: "/dev/null",
        sourceHash: "deadbeef",
        signedAt: "2026-01-01T00:00:00Z",
      }),
      { mode: 0o644 },
    );
    writeFileSync(join(tmp, "current"), join(tmp, "1.2.3.patched"), { mode: 0o644 });
    const meta = readCurrentPatchedMeta(tmp);
    expect(meta?.version).toBe("1.2.3");
  });

  test("resolves a relative symlink target", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-meta-test-"));
    writeFileSync(join(tmp, "2.0.0.patched"), "stub", { mode: 0o755 });
    writeFileSync(
      join(tmp, "2.0.0.meta.json"),
      JSON.stringify({
        version: "2.0.0",
        strategyId: "rel",
        sourcePath: "/dev/null",
        sourceHash: "abc",
        signedAt: "2026-01-01T00:00:00Z",
      }),
      { mode: 0o644 },
    );
    symlinkSync("2.0.0.patched", join(tmp, "current"));
    expect(readCurrentPatchedMeta(tmp)?.version).toBe("2.0.0");
  });
});

// Default subprocess wrappers — exercised against `bun` (always present
// while these tests run) and `/usr/bin/false` (POSIX standard error binary).
describe("default subprocess wrappers", () => {
  test("defaultVersionResolver parses version from `bun --version`", async () => {
    const v = await defaultVersionResolver(process.execPath);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("defaultVersionResolver throws on non-zero exit", async () => {
    expect(defaultVersionResolver("/usr/bin/false")).rejects.toThrow();
  });

  test("defaultVersionResolver throws on unparseable output", async () => {
    // /bin/sh -c 'echo hello' exits 0 but emits no version.
    const tmp = mkdtempSync(join(tmpdir(), "patcher-ver-test-"));
    const stub = join(tmp, "stub");
    writeFileSync(stub, "#!/bin/sh\necho 'hello world'\n", { mode: 0o755 });
    expect(defaultVersionResolver(stub)).rejects.toThrow(/parse version/);
  });

  test("defaultSmokeTest passes for healthy binary", async () => {
    await defaultSmokeTest(process.execPath);
  });

  test("defaultSmokeTest throws on non-zero exit", async () => {
    expect(defaultSmokeTest("/usr/bin/false")).rejects.toThrow(/smoke test/);
  });

  test("resolveSourceClaudePath returns string or null", () => {
    // Either claude is on PATH (returns abs path) or it's not (returns null).
    // Both branches are valid; we only care that the function runs without throwing
    // and returns one of the two expected shapes.
    const prev = process.env.MCX_CLAUDE_BINARY;
    unsetEnv("MCX_CLAUDE_BINARY");
    try {
      const result = resolveSourceClaudePath();
      expect(result === null || (typeof result === "string" && result.length > 0)).toBe(true);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath honors MCX_CLAUDE_BINARY when the file exists", () => {
    // Use bun's own binary as the override target — guaranteed to exist on the
    // path running this test, and is an executable file so the existsSync check
    // passes.
    const prev = process.env.MCX_CLAUDE_BINARY;
    process.env.MCX_CLAUDE_BINARY = process.execPath;
    try {
      expect(resolveSourceClaudePath()).toBe(process.execPath);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath throws when MCX_CLAUDE_BINARY points at a missing file", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    process.env.MCX_CLAUDE_BINARY = "/nonexistent/path/to/claude";
    try {
      expect(() => resolveSourceClaudePath()).toThrow(/does not exist/);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath ignores empty MCX_CLAUDE_BINARY and falls back to PATH", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    process.env.MCX_CLAUDE_BINARY = "   ";
    try {
      const result = resolveSourceClaudePath();
      expect(result === null || (typeof result === "string" && result.length > 0)).toBe(true);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath honors claudeBinary from the config file when env is unset", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    unsetEnv("MCX_CLAUDE_BINARY");
    const cfgPath = join(mkdtempSync(join(tmpdir(), "rsc-cfg-")), "config.json");
    writeFileSync(cfgPath, JSON.stringify({ claudeBinary: process.execPath }));
    try {
      expect(resolveSourceClaudePath(cfgPath)).toBe(process.execPath);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath: env wins over config file", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    process.env.MCX_CLAUDE_BINARY = process.execPath;
    const cfgPath = join(mkdtempSync(join(tmpdir(), "rsc-cfg-")), "config.json");
    writeFileSync(cfgPath, JSON.stringify({ claudeBinary: "/this/should/be/ignored" }));
    try {
      // env wins → returns process.execPath, not the (nonexistent) config path
      expect(resolveSourceClaudePath(cfgPath)).toBe(process.execPath);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath throws when config claudeBinary points at a missing file", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    unsetEnv("MCX_CLAUDE_BINARY");
    const cfgPath = join(mkdtempSync(join(tmpdir(), "rsc-cfg-")), "config.json");
    writeFileSync(cfgPath, JSON.stringify({ claudeBinary: "/nonexistent/path/to/claude" }));
    try {
      expect(() => resolveSourceClaudePath(cfgPath)).toThrow(/does not exist/);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });

  test("resolveSourceClaudePath silently falls through when config file is missing or malformed", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    unsetEnv("MCX_CLAUDE_BINARY");
    const dir = mkdtempSync(join(tmpdir(), "rsc-cfg-"));
    const missingPath = join(dir, "this-file-does-not-exist.json");
    const malformedPath = join(dir, "malformed-cfg.json");
    writeFileSync(malformedPath, "{ not valid json");
    try {
      // Both paths must not throw — they fall through to PATH lookup,
      // which returns either a path or null depending on the test env.
      const r1 = resolveSourceClaudePath(missingPath);
      const r2 = resolveSourceClaudePath(malformedPath);
      expect(r1 === null || typeof r1 === "string").toBe(true);
      expect(r2 === null || typeof r2 === "string").toBe(true);
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
  });
});

// codesign-dependent tests run only on macOS (where codesign exists and bun is signed).
const isDarwin = process.platform === "darwin";
const macOnly = isDarwin ? describe : describe.skip;

macOnly("codesign integration (macOS only)", () => {
  test("defaultExtractEntitlements returns a plist or empty string", async () => {
    // Bun (the binary running this test) is codesigned on macOS distribution.
    const ent = await defaultExtractEntitlements(process.execPath);
    // Empty string is acceptable (bun may not declare entitlements); a plist is also fine.
    expect(typeof ent).toBe("string");
  });

  test("defaultResignBinary signs a copy of bun successfully", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "patcher-codesign-test-"));
    const copy = join(tmp, "bun-copy");
    copyFileSync(process.execPath, copy);
    const entPath = join(tmp, "entitlements.plist");
    writeFileSync(entPath, '<plist version="1.0"><dict/></plist>', { mode: 0o600 });
    await defaultResignBinary(copy, entPath);
    // Verify the resigned copy still runs.
    const r = spawnSync(copy, ["--version"], { encoding: "utf-8", timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});
