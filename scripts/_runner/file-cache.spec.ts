import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildImportGraph } from "../rules/_engine/import-graph";
import type { ImportGraph, SpecifierResolver } from "../rules/_engine/import-graph";
import {
  computeClosureHash,
  filterByClosureCache,
  lookupFileVerdict,
  readFileCache,
  storeFileVerdicts,
  writeFileCache,
} from "./file-cache";

function tmpRoot(): string {
  const dir = join(tmpdir(), `file-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "build"), { recursive: true });
  return dir;
}

function syntheticGraph(files: Record<string, string>): ImportGraph {
  const resolve: SpecifierResolver = (spec, _dir) => {
    const target = spec.replace("./", "/test/").concat(".ts");
    if (target in files) return target;
    throw new Error(`unresolvable: ${spec}`);
  };
  return buildImportGraph(Object.keys(files), {
    readFile: (p) => files[p] ?? "",
    resolve,
  });
}

describe("computeClosureHash", () => {
  test("returns deterministic hash for same content", () => {
    const files: Record<string, string> = {
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": "export const b = 1;",
    };
    const graph = syntheticGraph(files);
    const read = (p: string) => files[p] ?? "";

    const hash1 = computeClosureHash("/test/a.ts", graph, read);
    const hash2 = computeClosureHash("/test/a.ts", graph, read);
    expect(hash1).toBe(hash2);
  });

  test("hash changes when dependency content changes", () => {
    const files1: Record<string, string> = {
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": "export const b = 1;",
    };
    const files2: Record<string, string> = {
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": "export const b = 2;",
    };
    const graph = syntheticGraph(files1);
    const hash1 = computeClosureHash("/test/a.ts", graph, (p) => files1[p] ?? "");
    const hash2 = computeClosureHash("/test/a.ts", graph, (p) => files2[p] ?? "");
    expect(hash1).not.toBe(hash2);
  });

  test("hash changes when test file content changes", () => {
    const files1: Record<string, string> = {
      "/test/a.ts": "export const a = 1;",
    };
    const files2: Record<string, string> = {
      "/test/a.ts": "export const a = 2;",
    };
    const graph = syntheticGraph(files1);
    const hash1 = computeClosureHash("/test/a.ts", graph, (p) => files1[p] ?? "");
    const hash2 = computeClosureHash("/test/a.ts", graph, (p) => files2[p] ?? "");
    expect(hash1).not.toBe(hash2);
  });

  test("leaf file with no deps gets a stable hash", () => {
    const files: Record<string, string> = {
      "/test/leaf.ts": "export const x = 1;",
    };
    const graph = syntheticGraph(files);
    const hash = computeClosureHash("/test/leaf.ts", graph, (p) => files[p] ?? "");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe("readFileCache / writeFileCache", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  test("returns empty cache when no file exists", () => {
    const root = tmpRoot();
    roots.push(root);
    const cache = readFileCache(root);
    expect(cache.bunVersion).toBe(Bun.version);
    expect(Object.keys(cache.entries)).toHaveLength(0);
  });

  test("round-trips cache data", () => {
    const root = tmpRoot();
    roots.push(root);
    const cache = readFileCache(root);
    cache.entries["test.spec.ts"] = { closureHash: "abc", passed: true, ts: new Date().toISOString() };
    writeFileCache(root, cache);

    const loaded = readFileCache(root);
    expect(loaded.entries["test.spec.ts"]?.closureHash).toBe("abc");
    expect(loaded.entries["test.spec.ts"]?.passed).toBe(true);
  });

  test("invalidates cache on Bun version change", () => {
    const root = tmpRoot();
    roots.push(root);
    const cachePath = join(root, "build/.file-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({ bunVersion: "0.0.0-old", entries: { "a.spec.ts": { closureHash: "x", passed: true, ts: "" } } }),
    );

    const loaded = readFileCache(root);
    expect(Object.keys(loaded.entries)).toHaveLength(0);
  });

  test("handles corrupt cache file gracefully", () => {
    const root = tmpRoot();
    roots.push(root);
    writeFileSync(join(root, "build/.file-cache.json"), "not json{{");
    const loaded = readFileCache(root);
    expect(Object.keys(loaded.entries)).toHaveLength(0);
  });
});

describe("lookupFileVerdict", () => {
  test("returns true for matching hash + passed", () => {
    const cache = {
      bunVersion: Bun.version,
      entries: { "a.spec.ts": { closureHash: "abc", passed: true, ts: "" } },
    };
    expect(lookupFileVerdict(cache, "a.spec.ts", "abc")).toBe(true);
  });

  test("returns false when hash differs", () => {
    const cache = {
      bunVersion: Bun.version,
      entries: { "a.spec.ts": { closureHash: "abc", passed: true, ts: "" } },
    };
    expect(lookupFileVerdict(cache, "a.spec.ts", "xyz")).toBe(false);
  });

  test("returns false when previous run failed", () => {
    const cache = {
      bunVersion: Bun.version,
      entries: { "a.spec.ts": { closureHash: "abc", passed: false, ts: "" } },
    };
    expect(lookupFileVerdict(cache, "a.spec.ts", "abc")).toBe(false);
  });

  test("returns false for unknown file", () => {
    const cache = { bunVersion: Bun.version, entries: {} };
    expect(lookupFileVerdict(cache, "unknown.spec.ts", "abc")).toBe(false);
  });
});

describe("storeFileVerdicts", () => {
  test("stores verdicts for multiple files", () => {
    const cache = {
      bunVersion: Bun.version,
      entries: {} as Record<string, { closureHash: string; passed: boolean; ts: string }>,
    };
    storeFileVerdicts(cache, [
      { relPath: "a.spec.ts", closureHash: "h1", passed: true },
      { relPath: "b.spec.ts", closureHash: "h2", passed: false },
    ]);
    expect(cache.entries["a.spec.ts"]?.passed).toBe(true);
    expect(cache.entries["b.spec.ts"]?.passed).toBe(false);
  });

  test("evicts oldest entries when exceeding max", () => {
    const cache = {
      bunVersion: Bun.version,
      entries: {} as Record<string, { closureHash: string; passed: boolean; ts: string }>,
    };
    const verdicts = [];
    for (let i = 0; i < 510; i++) {
      verdicts.push({
        relPath: `file-${i.toString().padStart(4, "0")}.spec.ts`,
        closureHash: `h${i}`,
        passed: true,
      });
    }
    storeFileVerdicts(cache, verdicts);
    expect(Object.keys(cache.entries).length).toBeLessThanOrEqual(500);
  });
});

describe("filterByClosureCache", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  test("skips files with matching green cache entries", () => {
    const root = tmpRoot();
    roots.push(root);

    const aPath = join(root, "src/a.spec.ts");
    const bPath = join(root, "src/b.spec.ts");
    const files: Record<string, string> = {
      [aPath]: "test('a', () => {});",
      [bPath]: "test('b', () => {});",
    };
    const resolve: SpecifierResolver = () => {
      throw new Error("no deps");
    };
    const graph = buildImportGraph(Object.keys(files), {
      readFile: (p) => files[p] ?? "",
      resolve,
    });
    const read = (p: string) => files[p] ?? "";

    // Pre-populate cache with a green entry for a.spec.ts
    const cache = readFileCache(root);
    const hashA = computeClosureHash(aPath, graph, read);
    storeFileVerdicts(cache, [{ relPath: "src/a.spec.ts", closureHash: hashA, passed: true }]);
    writeFileCache(root, cache);

    const result = filterByClosureCache({
      testFiles: [aPath, bPath],
      repoRoot: root,
      graph,
      readFile: read,
    });

    expect(result.skipped).toContain(aPath);
    expect(result.toRun).toContain(bPath);
    expect(result.toRun).not.toContain(aPath);
  });

  test("runs all files when cache is empty", () => {
    const root = tmpRoot();
    roots.push(root);

    const aPath = join(root, "src/a.spec.ts");
    const files: Record<string, string> = {
      [aPath]: "test('a', () => {});",
    };
    const resolve: SpecifierResolver = () => {
      throw new Error("no deps");
    };
    const graph = buildImportGraph(Object.keys(files), {
      readFile: (p) => files[p] ?? "",
      resolve,
    });

    const result = filterByClosureCache({
      testFiles: [aPath],
      repoRoot: root,
      graph,
      readFile: (p) => files[p] ?? "",
    });

    expect(result.toRun).toContain(aPath);
    expect(result.skipped).toHaveLength(0);
  });
});
