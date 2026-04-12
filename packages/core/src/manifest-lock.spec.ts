import { describe, expect, test } from "bun:test";
import {
  LOCKFILE_VERSION,
  type Lockfile,
  canonicalJson,
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
