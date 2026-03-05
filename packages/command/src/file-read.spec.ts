import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileWithLimit } from "./file-read";

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
});
