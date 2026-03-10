import { describe, expect, test } from "bun:test";
import { matchFilePath } from "./file-matcher";

describe("matchFilePath", () => {
  test("matches exact file", () => {
    expect(matchFilePath("src/index.ts", "src/index.ts")).toBe(true);
  });

  test("matches glob with extension", () => {
    expect(matchFilePath("src/index.ts", "**/*.ts")).toBe(true);
    expect(matchFilePath("src/deep/nested/file.ts", "**/*.ts")).toBe(true);
  });

  test("rejects non-matching extension", () => {
    expect(matchFilePath("src/index.js", "**/*.ts")).toBe(false);
  });

  test("matches directory glob", () => {
    expect(matchFilePath("packages/core/src/index.ts", "packages/**")).toBe(true);
    expect(matchFilePath("src/index.ts", "packages/**")).toBe(false);
  });

  test("matches nested directory glob", () => {
    expect(matchFilePath("src/components/Button.tsx", "src/**/*.tsx")).toBe(true);
    expect(matchFilePath("test/components/Button.tsx", "src/**/*.tsx")).toBe(false);
  });

  test("matches star glob for single directory level", () => {
    expect(matchFilePath("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchFilePath("src/deep/index.ts", "src/*.ts")).toBe(false);
  });

  test("matches multiple extensions", () => {
    expect(matchFilePath("file.ts", "*.{ts,tsx}")).toBe(true);
    expect(matchFilePath("file.tsx", "*.{ts,tsx}")).toBe(true);
    expect(matchFilePath("file.js", "*.{ts,tsx}")).toBe(false);
  });

  test("rejects directory traversal with ..", () => {
    // "src/../../etc/passwd" normalizes to "../etc/passwd", not under "src/"
    expect(matchFilePath("src/../../etc/passwd", "src/**")).toBe(false);
    expect(matchFilePath("src/../../../etc/shadow", "src/**")).toBe(false);
  });

  test("normalizes redundant segments", () => {
    // "src/./index.ts" normalizes to "src/index.ts"
    expect(matchFilePath("src/./index.ts", "src/**")).toBe(true);
    expect(matchFilePath("src/./index.ts", "src/*.ts")).toBe(true);
  });

  test("normalizes parent traversal that stays within pattern scope", () => {
    // "src/deep/../index.ts" normalizes to "src/index.ts" — still under src/
    expect(matchFilePath("src/deep/../index.ts", "src/**")).toBe(true);
    expect(matchFilePath("src/deep/../index.ts", "src/*.ts")).toBe(true);
  });

  test("rejects traversal escaping absolute path patterns", () => {
    // "/home/user/../../../etc/passwd" normalizes to "/etc/passwd"
    expect(matchFilePath("/home/user/../../../etc/passwd", "/home/user/**")).toBe(false);
  });
});
