import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readFileWithLimit, resolveAtPath } from "./file-read";

const TMP = join(import.meta.dir, "__tmp_file_read_test__");

// Set up temp directory
mkdirSync(TMP, { recursive: true });

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readFileWithLimit", () => {
  test("reads a normal file", () => {
    const p = join(TMP, "normal.json");
    writeFileSync(p, '{"hello":"world"}');
    expect(readFileWithLimit(p)).toBe('{"hello":"world"}');
  });

  test("rejects files over 10MB", () => {
    const p = join(TMP, "huge.bin");
    // Create an 11MB file
    const buf = Buffer.alloc(11 * 1024 * 1024, 0x41);
    writeFileSync(p, buf);
    expect(() => readFileWithLimit(p)).toThrow(/exceeds 10MB limit/);
  });

  test("throws on non-existent files", () => {
    expect(() => readFileWithLimit(join(TMP, "nope.txt"))).toThrow();
  });

  test("expands ~ to home directory", () => {
    const p = join(TMP, "tilde-test.json");
    writeFileSync(p, '{"tilde":true}');
    const relFromHome = relative(homedir(), p);
    expect(readFileWithLimit(`~/${relFromHome}`)).toBe('{"tilde":true}');
  });
});

describe("resolveAtPath", () => {
  const read = (path: string) => `content of ${path}`;

  test("returns value as-is when not an @-reference", () => {
    expect(resolveAtPath("inline prompt", read)).toBe("inline prompt");
  });

  test("strips @ and calls read with the path", () => {
    expect(resolveAtPath("@/tmp/spec.md", read)).toBe("content of /tmp/spec.md");
  });

  test("returns empty string for @file that reads empty", () => {
    expect(resolveAtPath("@/tmp/empty.md", () => "")).toBe("");
  });

  test("propagates errors from read", () => {
    const failRead = () => {
      throw new Error("file not found");
    };
    expect(() => resolveAtPath("@/tmp/missing.md", failRead)).toThrow("file not found");
  });

  test("does not treat lone @ as a file reference", () => {
    // A bare "@" has an empty path — the read function is called with ""
    const trackPath: string[] = [];
    resolveAtPath("@", (p) => {
      trackPath.push(p);
      return "result";
    });
    expect(trackPath).toEqual([""]);
  });
});
