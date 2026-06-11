import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCKFILE_VERSION,
  type Lockfile,
  canonicalJson,
  hashImportClosureSync,
  parseLockfile,
  serializeLockfile,
  sha256Hex,
} from "./manifest-lock";

const H = "a".repeat(64);
const H2 = "b".repeat(64);

describe("sha256Hex", () => {
  test("hashes a known string", () => {
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("canonicalJson", () => {
  test("sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("recurses into nested objects", () => {
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("hashImportClosureSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "closure-hash-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("changes when a transitive import is edited (#2656)", () => {
    writeFileSync(join(dir, "helper.ts"), "export const N = 1;\n");
    writeFileSync(join(dir, "entry.ts"), 'import { N } from "./helper";\nexport const X = N;\n');
    const before = hashImportClosureSync(join(dir, "entry.ts"), dir);

    // Edit the *transitive import*, not the entry — the bug was that this
    // left the hash unchanged.
    writeFileSync(join(dir, "helper.ts"), "export const N = 2;\n");
    const after = hashImportClosureSync(join(dir, "entry.ts"), dir);
    expect(after).not.toBe(before);
  });

  test("is stable when the entry and its imports are unchanged", () => {
    writeFileSync(join(dir, "helper.ts"), "export const N = 1;\n");
    writeFileSync(join(dir, "entry.ts"), 'import { N } from "./helper";\nexport const X = N;\n');
    const a = hashImportClosureSync(join(dir, "entry.ts"), dir);
    const b = hashImportClosureSync(join(dir, "entry.ts"), dir);
    expect(a).toBe(b);
  });

  test("ignores edits to a non-imported sibling", () => {
    writeFileSync(join(dir, "helper.ts"), "export const N = 1;\n");
    writeFileSync(join(dir, "entry.ts"), 'import { N } from "./helper";\nexport const X = N;\n');
    writeFileSync(join(dir, "unrelated.ts"), "export const U = 1;\n");
    const before = hashImportClosureSync(join(dir, "entry.ts"), dir);
    writeFileSync(join(dir, "unrelated.ts"), "export const U = 999;\n");
    expect(hashImportClosureSync(join(dir, "entry.ts"), dir)).toBe(before);
  });

  test("does not follow bare/package specifiers", () => {
    // "mcp-cli" and "@mcp-cli/core" are externalized by the bundler — a
    // closure hash must not depend on package contents.
    writeFileSync(join(dir, "entry.ts"), 'import { z } from "mcp-cli";\nimport { x } from "@scope/pkg";\n');
    // No throw, deterministic.
    expect(hashImportClosureSync(join(dir, "entry.ts"), dir)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is independent of repoRoot location for identical content", () => {
    const other = mkdtempSync(join(tmpdir(), "closure-hash2-"));
    try {
      for (const d of [dir, other]) {
        writeFileSync(join(d, "helper.ts"), "export const N = 1;\n");
        writeFileSync(join(d, "entry.ts"), 'import { N } from "./helper";\nexport const X = N;\n');
      }
      expect(hashImportClosureSync(join(dir, "entry.ts"), dir)).toBe(
        hashImportClosureSync(join(other, "entry.ts"), other),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("throws ENOENT when the entry file is missing", () => {
    expect(() => hashImportClosureSync(join(dir, "nope.ts"), dir)).toThrow();
  });
});

describe("serializeLockfile / parseLockfile", () => {
  const lock: Lockfile = {
    version: LOCKFILE_VERSION,
    manifestHash: H,
    phases: [
      { name: "review", resolvedPath: "scripts/review.ts", contentHash: H2, schemaHash: "" },
      { name: "implement", resolvedPath: "scripts/implement.ts", contentHash: H, schemaHash: H2 },
    ],
  };

  test("serializes phases sorted by name", () => {
    const s = serializeLockfile(lock);
    const implementIdx = s.indexOf("implement");
    const reviewIdx = s.indexOf("review");
    expect(implementIdx).toBeGreaterThan(0);
    expect(implementIdx).toBeLessThan(reviewIdx);
  });

  test("ends with a newline", () => {
    expect(serializeLockfile(lock).endsWith("\n")).toBe(true);
  });

  test("round-trips through parseLockfile", () => {
    const parsed = parseLockfile(serializeLockfile(lock));
    expect(parsed.manifestHash).toBe(H);
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[0].name).toBe("implement");
  });

  test("rejects bad hash format", () => {
    const bad = { ...lock, manifestHash: "not-hex" };
    expect(() => parseLockfile(JSON.stringify(bad))).toThrow();
  });

  test("rejects unknown version", () => {
    const bad = { ...lock, version: 2 };
    expect(() => parseLockfile(JSON.stringify(bad))).toThrow();
  });
});
