import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { options } from "./constants";
import { auditRuntimePermissions, ensureStateDir, hardenFile, resolveRealpath } from "./fs";
import { capturingLogger } from "./logger";

describe("resolveRealpath", () => {
  test("returns real path for existing file", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-fs-test-"));
    try {
      const file = join(base, "real.txt");
      writeFileSync(file, "x");
      // realpathSync resolves any symlinks in tmpdir itself (e.g. /var → /private/var on macOS)
      expect(resolveRealpath(file)).toBe(realpathSync(file));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("resolves symlink to its real path", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-fs-test-"));
    try {
      const real = join(base, "real-dir");
      mkdirSync(real);
      const link = join(base, "link-dir");
      symlinkSync(real, link);
      expect(resolveRealpath(link)).toBe(realpathSync(real));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("handles non-existent path by walking to existing ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-fs-test-"));
    try {
      const realBase = realpathSync(base);
      const missing = join(base, "does-not-exist", "nested");
      const result = resolveRealpath(missing);
      expect(result).toBe(join(realBase, "does-not-exist", "nested"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("resolves symlink ancestor for non-existent tail", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-fs-test-"));
    try {
      const real = join(base, "real-dir");
      mkdirSync(real);
      const link = join(base, "link-dir");
      symlinkSync(real, link);
      const missing = join(link, "not-yet-created");
      const result = resolveRealpath(missing);
      expect(result).toBe(join(realpathSync(real), "not-yet-created"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("hardenFile", () => {
  test("sets file permissions to 0600", () => {
    using opts = testOptions();
    const filePath = join(opts.dir, "secret.txt");
    writeFileSync(filePath, "secret data");

    hardenFile(filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("tightens overly permissive file", () => {
    using opts = testOptions();
    const filePath = join(opts.dir, "open.txt");
    writeFileSync(filePath, "secret data");
    chmodSync(filePath, 0o666);

    hardenFile(filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("ensureStateDir", () => {
  test("creates directory with mode 0700", () => {
    using opts = testOptions();
    const subDir = join(opts.dir, "nested", "state");
    options.MCP_CLI_DIR = subDir;

    ensureStateDir();

    const mode = statSync(subDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("is idempotent on existing directory", () => {
    using _opts = testOptions();

    ensureStateDir();
    ensureStateDir(); // should not throw

    expect(statSync(options.MCP_CLI_DIR).isDirectory()).toBe(true);
  });
});

describe("auditRuntimePermissions", () => {
  test("emits no warnings for properly permissioned dir", () => {
    using opts = testOptions();
    mkdirSync(opts.MCP_CLI_DIR, { recursive: true, mode: 0o700 });

    const { logger, texts } = capturingLogger();
    auditRuntimePermissions(logger);
    expect(texts.filter((t) => t.includes("[security]"))).toHaveLength(0);
  });

  test("warns when directory has group/other bits set", () => {
    using opts = testOptions();
    mkdirSync(opts.MCP_CLI_DIR, { recursive: true });
    chmodSync(opts.MCP_CLI_DIR, 0o777);

    const { logger, messages, texts } = capturingLogger();
    auditRuntimePermissions(logger);
    const warnings = texts.filter((t) => t.includes("[security]"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("0777");
    expect(warnings[0]).toContain("expected 0700");
    // Security warnings should be at warn level
    expect(messages.filter((m) => m.level === "warn").length).toBeGreaterThanOrEqual(1);
  });

  test("warns when file has group/other bits set", () => {
    using opts = testOptions();
    mkdirSync(opts.MCP_CLI_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(opts.DB_PATH, "db");
    chmodSync(opts.DB_PATH, 0o644);

    const { logger, messages, texts } = capturingLogger();
    auditRuntimePermissions(logger);
    const warnings = texts.filter((t) => t.includes("[security]"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes("0644"))).toBe(true);
    expect(warnings.some((w) => w.includes("expected 0600"))).toBe(true);
    expect(messages.filter((m) => m.level === "warn").length).toBeGreaterThanOrEqual(1);
  });

  test("does not warn for nonexistent dir or files", () => {
    using opts = testOptions();
    const { rmSync } = require("node:fs");
    rmSync(opts.MCP_CLI_DIR, { recursive: true, force: true });

    const { logger, texts } = capturingLogger();
    auditRuntimePermissions(logger);
    expect(texts.filter((t) => t.includes("[security]"))).toHaveLength(0);
  });
});
