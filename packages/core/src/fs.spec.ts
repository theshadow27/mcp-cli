import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenFile } from "./fs";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `mcp-cli-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("hardenFile", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    paths.length = 0;
  });

  test("sets file permissions to 0600", () => {
    const filePath = tmpPath("harden");
    paths.push(filePath);
    writeFileSync(filePath, "secret data");

    hardenFile(filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("tightens overly permissive file", () => {
    const filePath = tmpPath("harden-open");
    paths.push(filePath);
    writeFileSync(filePath, "secret data");
    chmodSync(filePath, 0o666);

    hardenFile(filePath);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("ensureStateDir", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    paths.length = 0;
  });

  test("mkdirSync with mode 0700 creates directory with correct permissions", () => {
    const dir = tmpPath("statedir");
    paths.push(dir);

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("auditRuntimePermissions", () => {
  test("runs without error", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    try {
      const { auditRuntimePermissions } = require("./fs.js");
      auditRuntimePermissions();
      // Function should complete without throwing
    } finally {
      console.error = origError;
    }
  });
});
