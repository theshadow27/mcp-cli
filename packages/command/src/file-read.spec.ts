import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readFileWithLimit, resolveAtPath } from "./file-read";

const TMP = join(import.meta.dir, "__tmp_file_read_test__");

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
    const buf = Buffer.alloc(11 * 1024 * 1024, 0x41);
    writeFileSync(p, buf);
    expect(() => readFileWithLimit(p)).toThrow(/exceeds 10MB limit/);
  });

  test("rejects binary files (null bytes in first 8KB)", () => {
    const p = join(TMP, "binary.bin");
    const buf = Buffer.alloc(1024, 0x41);
    buf[512] = 0x00;
    writeFileSync(p, buf);
    expect(() => readFileWithLimit(p)).toThrow(/appears to be binary/);
  });

  test("throws on non-existent files", () => {
    expect(() => readFileWithLimit(join(TMP, "nope.txt"))).toThrow();
  });

  test("rejects ~/path with clear message", () => {
    expect(() => readFileWithLimit("~/some-file.txt")).toThrow(/~\/ paths are not supported/);
  });
});

describe("path containment guard", () => {
  test("allows files under cwd", () => {
    const p = join(TMP, "cwd-ok.txt");
    writeFileSync(p, "allowed");
    expect(readFileWithLimit(p)).toBe("allowed");
  });

  test("allows relative paths that resolve inside cwd", () => {
    const p = join(TMP, "rel-ok.txt");
    writeFileSync(p, "relative-allowed");
    const rel = relative(process.cwd(), p);
    expect(readFileWithLimit(rel)).toBe("relative-allowed");
  });

  test("rejects absolute path outside cwd", () => {
    expect(() => readFileWithLimit("/etc/passwd")).toThrow(/outside the allowed directory/);
  });

  test("rejects traversal via ../", () => {
    const depth = process.cwd().split("/").length;
    const traversal = `${"../".repeat(depth)}etc/passwd`;
    expect(() => readFileWithLimit(traversal)).toThrow(/outside the allowed directory/);
  });

  test("rejects /dev paths", () => {
    expect(() => readFileWithLimit("/dev/null")).toThrow(/outside the allowed directory/);
  });

  test("rejects symlink that escapes cwd", () => {
    const link = join(TMP, "escape-link");
    try {
      rmSync(link);
    } catch {
      /* may not exist */
    }
    symlinkSync("/etc/hosts", link);
    expect(() => readFileWithLimit(link)).toThrow(/outside the allowed directory/);
  });

  test("error message includes both original and resolved paths", () => {
    try {
      readFileWithLimit("/etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("/etc/passwd");
      expect(msg).toContain("outside the allowed directory");
    }
  });

  test("non-existent path outside allowed dirs is caught before ENOENT", () => {
    expect(() => readFileWithLimit("/nonexistent/path/file.txt")).toThrow(/outside the allowed directory/);
  });
});

describe("dotfiles inside cwd are allowed (no denylist)", () => {
  test("allows .env inside cwd", () => {
    const p = join(TMP, ".env");
    writeFileSync(p, "SECRET=hunter2");
    expect(readFileWithLimit(p)).toBe("SECRET=hunter2");
  });

  test("allows .npmrc inside cwd", () => {
    const p = join(TMP, ".npmrc");
    writeFileSync(p, "//registry.npmjs.org/:_authToken=xxx");
    expect(readFileWithLimit(p)).toBe("//registry.npmjs.org/:_authToken=xxx");
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

  test("throws a helpful error for bare @", () => {
    expect(() => resolveAtPath("@", read)).toThrow("'@' requires a path");
  });

  test("@@ escapes to a literal @ string", () => {
    expect(resolveAtPath("@@mention", read)).toBe("@mention");
    expect(resolveAtPath("@@/not/a/path", read)).toBe("@/not/a/path");
  });
});
