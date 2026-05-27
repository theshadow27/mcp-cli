import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { FileMeta } from "./_engine/file-loader";
import { getPackageForPath } from "./_engine/file-loader";
import { buildImportGraph } from "./_engine/import-graph";
import type { ImportEdge, ImportGraph } from "./_engine/import-graph";
import type { CheckRule } from "./_engine/rule";

// ── Types ──────────────────────────────────────────────────────────────

interface CycleInfo {
  cyclePath: string[];
  isCrossPackage: boolean;
  canonical: string;
}

// ── Tarjan's SCC ───────────────────────────────────────────────────────

export function findSCCs(graph: ImportGraph): string[][] {
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let idx = 0;

  function ll(node: string): number {
    return lowlink.get(node) ?? 0;
  }

  function strongconnect(v: string): void {
    indexMap.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    for (const edge of graph.forward.get(v) ?? []) {
      const w = edge.target;
      if (!graph.files.has(w)) continue;
      if (!indexMap.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(ll(v), ll(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(ll(v), indexMap.get(w) ?? 0));
      }
    }

    if (ll(v) === indexMap.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (!w) break;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const file of graph.files) {
    if (!indexMap.has(file)) strongconnect(file);
  }

  return sccs;
}

export function findSelfImports(graph: ImportGraph): string[] {
  const result: string[] = [];
  for (const file of graph.files) {
    if ((graph.forward.get(file) ?? []).some((e) => e.target === file)) {
      result.push(file);
    }
  }
  return result;
}

// ── Cycle path tracing ─────────────────────────────────────────────────

export function traceCycle(
  sccMembers: readonly string[],
  forward: ReadonlyMap<string, readonly ImportEdge[]>,
): string[] {
  const sccSet = new Set(sccMembers);
  const sorted = [...sccMembers].sort();
  const start = sorted[0];
  if (!start) return [];
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (visited.has(node)) {
      const idx = path.indexOf(node);
      if (idx >= 0) return path.slice(idx);
      return null;
    }
    visited.add(node);
    path.push(node);

    for (const edge of forward.get(node) ?? []) {
      if (!sccSet.has(edge.target)) continue;
      const cycle = dfs(edge.target);
      if (cycle) return cycle;
    }

    path.pop();
    visited.delete(node);
    return null;
  }

  return dfs(start) ?? sorted;
}

// ── Graph + cycle detection (cached per run) ───────────────────────────

let cachedFilesRef: Map<string, FileMeta> | null = null;
let cachedCycleMap: Map<string, CycleInfo> | null = null;

function deriveRepoRoot(files: Map<string, FileMeta>): string {
  for (const meta of files.values()) {
    if (meta.path.endsWith(meta.relPath)) {
      return meta.path.slice(0, meta.path.length - meta.relPath.length - 1);
    }
  }
  return process.cwd();
}

function computeCycles(files: Map<string, FileMeta>): Map<string, CycleInfo> {
  if (cachedFilesRef === files && cachedCycleMap) return cachedCycleMap;

  const repoRoot = deriveRepoRoot(files);
  const contentMap = new Map<string, string>();
  const roots: string[] = [];
  for (const [absPath, meta] of files) {
    if (meta.isTest) continue;
    contentMap.set(absPath, meta.content);
    roots.push(absPath);
  }

  const graph = buildImportGraph(roots, {
    readFile: (p) => contentMap.get(p) ?? readFileSync(p, "utf8"),
  });

  const result = new Map<string, CycleInfo>();

  for (const scc of findSCCs(graph)) {
    const cyclePath = traceCycle(scc, graph.forward);
    const sorted = [...scc].sort();
    const pkgs = new Set(sorted.map((f) => getPackageForPath(repoRoot, f)));
    const canonical = sorted.find((f) => files.has(f)) ?? sorted[0] ?? scc[0];
    const info: CycleInfo = {
      cyclePath,
      isCrossPackage: pkgs.size > 1,
      canonical,
    };
    for (const file of scc) result.set(file, info);
  }

  for (const file of findSelfImports(graph)) {
    if (result.has(file)) continue;
    result.set(file, {
      cyclePath: [file],
      isCrossPackage: false,
      canonical: file,
    });
  }

  cachedFilesRef = files;
  cachedCycleMap = result;
  return result;
}

// ── Rule ────────────────────────────────────────────────────────────────

const rule: CheckRule = {
  id: "no-import-cycles",
  kind: "check",
  scold: "Import cycle detected — the module graph must be a DAG",
  guidance: [
    "Cross-package cycles (e.g. core → daemon → core) are categorically banned.",
    "Intra-package file-level cycles are a design smell — break the cycle by extracting shared types into a leaf module.",
    "Type-only cycles (import type) still count — they indicate coupled design even without runtime edges.",
    "Add // dotw-ignore no-import-cycles: <reason> only for genuinely unavoidable cases.",
  ],
  documentation: "#2438",
  appliesToTests: false,
  check(ctx) {
    const cycles = computeCycles(ctx.files);
    const info = cycles.get(ctx.file.path);

    if (!info) {
      ctx.checked();
      return;
    }

    if (info.canonical !== ctx.file.path) {
      ctx.checked();
      return;
    }

    ctx.checked();

    const repoRoot = deriveRepoRoot(ctx.files);
    const relPaths = info.cyclePath.map((p) => relative(repoRoot, p));

    if (info.cyclePath.length === 1) {
      ctx.violated(1, 1, `self-import: ${relPaths[0]} imports itself`);
      return;
    }

    const label = info.isCrossPackage ? "cross-package cycle" : "intra-package cycle";
    const chain = [...relPaths, relPaths[0]].join(" → ");
    ctx.violated(1, 1, `${label} (${info.cyclePath.length} files): ${chain}`);
  },
};

export default rule;
