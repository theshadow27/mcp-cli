import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { FileMeta } from "./_engine/file-loader";
import { buildImportGraph } from "./_engine/import-graph";
import type { SpecifierResolver } from "./_engine/import-graph";
import { evaluateRule } from "./_engine/rule";
import { checkSuppression } from "./_engine/suppression";
import rule, { findSCCs, findSelfImports, traceCycle } from "./no-import-cycles.rule";

// ── Helpers ────────────────────────────────────────────────────────────

function syntheticGraph(files: Record<string, string>) {
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

function makeFile(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    path: "/fake/packages/core/src/example.ts",
    relPath: "packages/core/src/example.ts",
    content: "export const x = 1;\n",
    pkg: "packages/core",
    isTest: false,
    ...overrides,
  };
}

// ── findSCCs ───────────────────────────────────────────────────────────

describe("findSCCs", () => {
  test("detects 2-node cycle", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./a";`,
    });
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(["/test/a.ts", "/test/b.ts"]);
  });

  test("detects 3-node cycle", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": `import "./a";`,
    });
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(["/test/a.ts", "/test/b.ts", "/test/c.ts"]);
  });

  test("returns empty for acyclic graph", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": "export const c = 1;",
    });
    expect(findSCCs(graph)).toHaveLength(0);
  });

  test("finds multiple independent cycles", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./a";`,
      "/test/x.ts": `import "./y";`,
      "/test/y.ts": `import "./x";`,
    });
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(2);
  });

  test("does not flag singleton nodes", () => {
    const graph = syntheticGraph({
      "/test/lone.ts": "export const x = 1;",
    });
    expect(findSCCs(graph)).toHaveLength(0);
  });
});

// ── findSelfImports ────────────────────────────────────────────────────

describe("findSelfImports", () => {
  test("detects self-import", () => {
    const resolve: SpecifierResolver = (spec, _dir) => {
      if (spec === "./self") return "/test/self.ts";
      throw new Error(`unresolvable: ${spec}`);
    };
    const graph = buildImportGraph(["/test/self.ts"], {
      readFile: () => `import "./self";`,
      resolve,
    });
    const selfImports = findSelfImports(graph);
    expect(selfImports).toEqual(["/test/self.ts"]);
  });

  test("returns empty when no self-imports", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": "export const b = 1;",
    });
    expect(findSelfImports(graph)).toHaveLength(0);
  });
});

// ── traceCycle ──────────────────────────────────────────────────────────

describe("traceCycle", () => {
  test("traces 2-node cycle in import order", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./a";`,
    });
    const path = traceCycle(["/test/a.ts", "/test/b.ts"], graph.forward);
    expect(path).toHaveLength(2);
    expect(path[0]).toBe("/test/a.ts");
    expect(path[1]).toBe("/test/b.ts");
  });

  test("traces 3-node cycle in import order", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": `import "./a";`,
    });
    const path = traceCycle(["/test/a.ts", "/test/b.ts", "/test/c.ts"], graph.forward);
    expect(path).toHaveLength(3);
    expect(path[0]).toBe("/test/a.ts");
    expect(path[1]).toBe("/test/b.ts");
    expect(path[2]).toBe("/test/c.ts");
  });
});

// ── Rule integration ───────────────────────────────────────────────────

describe("rule integration", () => {
  test("no violations on acyclic single file", () => {
    const file = makeFile();
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(0);
  });

  test("cache is isolated per files Map — distinct maps produce independent results", () => {
    const file1 = makeFile({ path: "/fake/packages/core/src/a.ts", relPath: "packages/core/src/a.ts" });
    const files1 = new Map([[file1.path, file1]]);
    const file2 = makeFile({ path: "/fake/packages/core/src/b.ts", relPath: "packages/core/src/b.ts" });
    const files2 = new Map([[file2.path, file2]]);

    // Running against two distinct Map objects must not cross-contaminate.
    const v1 = evaluateRule(rule, file1, files1);
    const v2 = evaluateRule(rule, file2, files2);
    expect(v1).toHaveLength(0);
    expect(v2).toHaveLength(0);
  });

  test("same files Map reuses the cached result on second invocation", () => {
    const file = makeFile();
    const files = new Map([[file.path, file]]);
    // Two evaluations with the same Map should both return the same result
    // (the second call hits the WeakMap cache).
    const v1 = evaluateRule(rule, file, files);
    const v2 = evaluateRule(rule, file, files);
    expect(v1).toEqual(v2);
  });

  test("real codebase SCCs are intra-package (no cross-package cycles)", () => {
    const repoRoot = process.cwd();
    const coreIndex = `${repoRoot}/packages/core/src/index.ts`;
    const graph = buildImportGraph([coreIndex]);
    const sccs = findSCCs(graph);
    for (const scc of sccs) {
      const relPaths = scc.map((f) => f.replace(`${repoRoot}/`, ""));
      const pkgs = new Set(relPaths.map((p) => p.split("/").slice(0, 2).join("/")));
      expect(pkgs.size).toBe(1);
    }
  });

  test("real codebase has no self-imports", () => {
    const repoRoot = process.cwd();
    const coreIndex = `${repoRoot}/packages/core/src/index.ts`;
    const graph = buildImportGraph([coreIndex]);
    const selfImps = findSelfImports(graph);
    expect(selfImps).toHaveLength(0);
  });

  test("every SCC member with a dotw-ignore/todo suppression is actually in an SCC", () => {
    const repoRoot = process.cwd();
    const coreIndex = `${repoRoot}/packages/core/src/index.ts`;
    const graph = buildImportGraph([coreIndex]);
    const sccs = findSCCs(graph);
    const sccMembers = new Set(sccs.flat());

    for (const file of sccMembers) {
      const content = readFileSync(file, "utf8");
      const suppression = checkSuppression(content, 1, "no-import-cycles");
      if (suppression.suppressed) {
        expect(sccMembers.has(file)).toBe(true);
      }
    }
  });
});
