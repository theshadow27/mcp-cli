import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testOptions } from "../../../test/test-options";
import { options } from "./constants";
import { auditRuntimePermissions, ensureStateDir, hardenFile } from "./fs";

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

    const errors: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      auditRuntimePermissions();
      expect(errors.filter((e) => e.includes("[security]"))).toHaveLength(0);
    } finally {
      console.error = origError;
    }
  });

  test("warns when directory has group/other bits set", () => {
    using opts = testOptions();
    mkdirSync(opts.MCP_CLI_DIR, { recursive: true });
    chmodSync(opts.MCP_CLI_DIR, 0o777);

    const errors: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      auditRuntimePermissions();
      const warnings = errors.filter((e) => e.includes("[security]"));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain("0777");
      expect(warnings[0]).toContain("expected 0700");
    } finally {
      console.error = origError;
    }
  });

  test("warns when file has group/other bits set", () => {
    using opts = testOptions();
    mkdirSync(opts.MCP_CLI_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(opts.DB_PATH, "db");
    chmodSync(opts.DB_PATH, 0o644);

    const errors: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      auditRuntimePermissions();
      const warnings = errors.filter((e) => e.includes("[security]"));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.includes("0644"))).toBe(true);
      expect(warnings.some((w) => w.includes("expected 0600"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("does not warn for nonexistent dir or files", () => {
    using opts = testOptions();
    // testOptions sets MCP_CLI_DIR to temp dir, but no DB_PATH or SOCKET_PATH files exist
    // Remove the MCP_CLI_DIR so even the directory stat fails
    const { rmSync } = require("node:fs");
    rmSync(opts.MCP_CLI_DIR, { recursive: true, force: true });

    const errors: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      auditRuntimePermissions();
      expect(errors.filter((e) => e.includes("[security]"))).toHaveLength(0);
    } finally {
      console.error = origError;
    }
  });
});
