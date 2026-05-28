import { describe, expect, test } from "bun:test";
import { buildImportGraph, extractEdges, parseSpecifiers } from "./import-graph";
import type { SpecifierResolver } from "./import-graph";

describe("parseSpecifiers", () => {
  test("extracts static imports", () => {
    const src = `import { foo } from "./foo";`;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toEqual([{ specifier: "./foo", isBarrelReExport: false }]);
  });

  test("extracts type-only imports", () => {
    const src = `import type { Foo } from "./foo";`;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toEqual([{ specifier: "./foo", isBarrelReExport: false }]);
  });

  test("extracts export star as barrel re-export", () => {
    const src = `export * from "./model";`;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toEqual([{ specifier: "./model", isBarrelReExport: true }]);
  });

  test("extracts named re-exports as non-barrel", () => {
    const src = `export { foo } from "./foo";`;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toEqual([{ specifier: "./foo", isBarrelReExport: false }]);
  });

  test("extracts dynamic imports", () => {
    const src = `const m = import("./lazy");`;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toEqual([{ specifier: "./lazy", isBarrelReExport: false }]);
  });

  test("extracts multiple mixed specifiers", () => {
    const src = `
      import { a } from "./a";
      export * from "./b";
      export { c } from "./c";
      const d = import("./d");
    `;
    const specs = parseSpecifiers(src, "/test.ts");
    expect(specs).toHaveLength(4);
    expect(specs[0]).toEqual({ specifier: "./a", isBarrelReExport: false });
    expect(specs[1]).toEqual({ specifier: "./b", isBarrelReExport: true });
    expect(specs[2]).toEqual({ specifier: "./c", isBarrelReExport: false });
    expect(specs[3]).toEqual({ specifier: "./d", isBarrelReExport: false });
  });

  test("handles TSX files", () => {
    const src = `import React from "react"; const x = <div/>;`;
    const specs = parseSpecifiers(src, "/test.tsx");
    expect(specs).toEqual([{ specifier: "react", isBarrelReExport: false }]);
  });
});

describe("extractEdges", () => {
  const mockResolve: SpecifierResolver = (spec, _dir) => {
    if (spec.startsWith("bun:") || spec.startsWith("node:")) return spec;
    if (spec === "zod") return "/node_modules/zod/index.js";
    return `/resolved${spec.replace(".", "")}.ts`;
  };

  test("resolves specifiers and filters terminals", () => {
    const src = `
      import { foo } from "./foo";
      import { test } from "bun:test";
      import { join } from "node:path";
      import { z } from "zod";
    `;
    const edges = extractEdges(src, "/test.ts", mockResolve);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target).toBe("/resolved/foo.ts");
  });

  test("marks barrel re-exports correctly", () => {
    const src = `export * from "./model";`;
    const edges = extractEdges(src, "/test.ts", mockResolve);
    expect(edges[0]?.isBarrelReExport).toBe(true);
  });

  test("handles unresolvable specifiers gracefully", () => {
    const throwing: SpecifierResolver = () => {
      throw new Error("not found");
    };
    const src = `import { x } from "./nonexistent";`;
    const edges = extractEdges(src, "/test.ts", throwing);
    expect(edges).toHaveLength(0);
  });

  test("droppedEdges counts unresolvable specifiers in buildImportGraph", () => {
    const resolve: SpecifierResolver = (spec) => {
      if (spec === "./good") return "/test/good.ts";
      throw new Error("not found");
    };
    const graph = buildImportGraph(["/test/root.ts"], {
      readFile: (p) => {
        if (p === "/test/root.ts") return `import "./good"; import "./missing";`;
        return "";
      },
      resolve,
    });
    expect(graph.droppedEdges).toBe(1);
  });

  test("droppedEdges is zero when all specifiers resolve", () => {
    const resolve: SpecifierResolver = (spec, _dir) => {
      const target = spec.replace("./", "/test/").concat(".ts");
      return target;
    };
    const graph = buildImportGraph(["/test/a.ts"], {
      readFile: (p) => {
        if (p === "/test/a.ts") return `import "./b";`;
        return "";
      },
      resolve,
    });
    expect(graph.droppedEdges).toBe(0);
  });

  test("onUnresolvable callback is called for each dropped edge", () => {
    const dropped: { specifier: string; fromFile: string }[] = [];
    const resolve: SpecifierResolver = (spec) => {
      if (spec === "./good") return "/test/good.ts";
      throw new Error("not found");
    };
    buildImportGraph(["/test/root.ts"], {
      readFile: (p) => {
        if (p === "/test/root.ts") return `import "./good"; import "./bad1"; import "./bad2";`;
        return "";
      },
      resolve,
      onUnresolvable: (specifier, fromFile) => dropped.push({ specifier, fromFile }),
    });
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toEqual({ specifier: "./bad1", fromFile: "/test/root.ts" });
    expect(dropped[1]).toEqual({ specifier: "./bad2", fromFile: "/test/root.ts" });
  });

  test("works with real Bun.resolveSync on actual files", () => {
    const repoRoot = process.cwd();
    const src = `import { IpcMethod } from "./ipc";`;
    const edges = extractEdges(src, `${repoRoot}/packages/core/src/test.ts`);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0]?.target).toBe(`${repoRoot}/packages/core/src/ipc.ts`);
  });
});

describe("buildImportGraph — synthetic", () => {
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

  test("builds forward and reverse edges", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import { b } from "./b";`,
      "/test/b.ts": "export const b = 1;",
    });
    expect(graph.forward.get("/test/a.ts")?.length).toBe(1);
    expect(graph.reverse.get("/test/b.ts")?.has("/test/a.ts")).toBe(true);
  });

  test("computes transitive closure through chains", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": "export const c = 1;",
    });
    const closure = graph.closureOf("/test/a.ts");
    expect(closure.has("/test/b.ts")).toBe(true);
    expect(closure.has("/test/c.ts")).toBe(true);
  });

  test("handles circular imports without infinite loop", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./a";`,
    });
    const closure = graph.closureOf("/test/a.ts");
    expect(closure.has("/test/b.ts")).toBe(true);
    expect(closure.has("/test/a.ts")).toBe(false);
  });

  test("closureOf excludes self in longer cycles", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": `import "./a";`,
    });
    const closureA = graph.closureOf("/test/a.ts");
    expect(closureA.has("/test/b.ts")).toBe(true);
    expect(closureA.has("/test/c.ts")).toBe(true);
    expect(closureA.has("/test/a.ts")).toBe(false);

    const closureB = graph.closureOf("/test/b.ts");
    expect(closureB.has("/test/a.ts")).toBe(true);
    expect(closureB.has("/test/c.ts")).toBe(true);
    expect(closureB.has("/test/b.ts")).toBe(false);
  });

  test("dependentsOf excludes self in cycles", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./a";`,
    });
    const depsA = graph.dependentsOf("/test/a.ts");
    expect(depsA.has("/test/b.ts")).toBe(true);
    expect(depsA.has("/test/a.ts")).toBe(false);
  });

  test("closureOf returns empty set for leaf with no imports", () => {
    const graph = syntheticGraph({
      "/test/leaf.ts": "export const x = 1;",
    });
    expect(graph.closureOf("/test/leaf.ts").size).toBe(0);
  });

  test("barrel re-exports are included in transitive closure", () => {
    const graph = syntheticGraph({
      "/test/consumer.ts": `import "./barrel";`,
      "/test/barrel.ts": `export * from "./inner";`,
      "/test/inner.ts": "export const x = 1;",
    });
    const closure = graph.closureOf("/test/consumer.ts");
    expect(closure.has("/test/barrel.ts")).toBe(true);
    expect(closure.has("/test/inner.ts")).toBe(true);
  });

  test("dependentsOf computes reverse transitive closure", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": "export const c = 1;",
    });
    const deps = graph.dependentsOf("/test/c.ts");
    expect(deps.has("/test/b.ts")).toBe(true);
    expect(deps.has("/test/a.ts")).toBe(true);
  });

  test("dependentsOf handles diamond dependencies", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./c";`,
      "/test/b.ts": `import "./c";`,
      "/test/c.ts": "export const c = 1;",
    });
    const deps = graph.dependentsOf("/test/c.ts");
    expect(deps.has("/test/a.ts")).toBe(true);
    expect(deps.has("/test/b.ts")).toBe(true);
  });

  test("files set includes all discovered files", () => {
    const graph = syntheticGraph({
      "/test/a.ts": `import "./b";`,
      "/test/b.ts": "export const b = 1;",
    });
    expect(graph.files.has("/test/a.ts")).toBe(true);
    expect(graph.files.has("/test/b.ts")).toBe(true);
  });
});

describe("buildImportGraph — real codebase", () => {
  test("builds graph from core barrel with real Bun.resolveSync", () => {
    const repoRoot = process.cwd();
    const coreIndex = `${repoRoot}/packages/core/src/index.ts`;
    const graph = buildImportGraph([coreIndex]);

    const closure = graph.closureOf(coreIndex);
    expect(closure.size).toBeGreaterThan(10);
    expect(closure.has(`${repoRoot}/packages/core/src/ipc.ts`)).toBe(true);
    expect(closure.has(`${repoRoot}/packages/core/src/config.ts`)).toBe(true);
  });

  test("real spec file includes transitive deps in closure", () => {
    const repoRoot = process.cwd();
    const specFile = `${repoRoot}/packages/core/src/ipc.spec.ts`;
    const graph = buildImportGraph([specFile]);

    expect(graph.files.has(specFile)).toBe(true);
    const closure = graph.closureOf(specFile);
    expect(closure.size).toBeGreaterThan(0);
  });

  test("terminal nodes are excluded from the graph", () => {
    const repoRoot = process.cwd();
    const specFile = `${repoRoot}/packages/core/src/ipc.spec.ts`;
    const graph = buildImportGraph([specFile]);

    for (const file of graph.files) {
      expect(file.startsWith("bun:")).toBe(false);
      expect(file.startsWith("node:")).toBe(false);
      expect(file.includes("/node_modules/")).toBe(false);
    }
  });

  test("barrel re-exports propagate through real core barrel", () => {
    const repoRoot = process.cwd();
    const coreIndex = `${repoRoot}/packages/core/src/index.ts`;
    const graph = buildImportGraph([coreIndex]);

    const fwd = graph.forward.get(coreIndex) ?? [];
    const barrels = fwd.filter((e) => e.isBarrelReExport);
    expect(barrels.length).toBeGreaterThan(20);
  });
});
