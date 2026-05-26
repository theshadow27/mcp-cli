import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";

export interface ImportEdge {
  /** Resolved absolute path of the imported module. */
  target: string;
  /** True when the source has `export * from "target"`. */
  isBarrelReExport: boolean;
}

export interface ImportGraph {
  /** Forward edges: file → set of files it imports. */
  forward: ReadonlyMap<string, readonly ImportEdge[]>;
  /** Reverse edges: file → set of files that import it. */
  reverse: ReadonlyMap<string, ReadonlySet<string>>;
  /** All files in the graph. */
  files: ReadonlySet<string>;
  /** Compute the transitive import closure of a file (all files it depends on, transitively). */
  closureOf(file: string): ReadonlySet<string>;
  /** Compute the reverse closure (all files that transitively depend on a given file). */
  dependentsOf(file: string): ReadonlySet<string>;
}

interface MutableEdges {
  forward: Map<string, ImportEdge[]>;
  reverse: Map<string, Set<string>>;
}

function isTerminal(resolved: string): boolean {
  return resolved.startsWith("bun:") || resolved.startsWith("node:") || resolved.includes("/node_modules/");
}

export type SpecifierResolver = (specifier: string, fromDir: string) => string;

function defaultResolve(specifier: string, fromDir: string): string {
  return Bun.resolveSync(specifier, fromDir);
}

/**
 * Parse a source file's AST and return the raw module specifiers (before
 * resolution). Exported for test introspection.
 */
export function parseSpecifiers(
  sourceText: string,
  filePath: string,
): { specifier: string; isBarrelReExport: boolean }[] {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const raw: { specifier: string; isBarrelReExport: boolean }[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        raw.push({ specifier: spec.text, isBarrelReExport: false });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const isStar = !node.exportClause;
        raw.push({ specifier: node.moduleSpecifier.text, isBarrelReExport: isStar });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        raw.push({ specifier: arg.text, isBarrelReExport: false });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return raw;
}

/**
 * Extract import and export edges from a TypeScript source file.
 * Handles: import declarations, export declarations (named + star),
 * and dynamic import() expressions.
 *
 * `resolve` is injectable for testing; defaults to `Bun.resolveSync`.
 */
export function extractEdges(
  sourceText: string,
  filePath: string,
  resolve: SpecifierResolver = defaultResolve,
): ImportEdge[] {
  const raw = parseSpecifiers(sourceText, filePath);
  const edges: ImportEdge[] = [];
  const dir = dirname(filePath);
  for (const { specifier, isBarrelReExport } of raw) {
    try {
      const resolved = resolve(specifier, dir);
      if (!isTerminal(resolved)) {
        edges.push({ target: resolved, isBarrelReExport });
      }
    } catch {
      // Unresolvable (missing devDep, conditional import, etc.) — terminal node.
    }
  }
  return edges;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

export interface BuildGraphOptions {
  readFile?: (path: string) => string;
  resolve?: SpecifierResolver;
}

/**
 * Build a complete import graph from a set of source file paths.
 *
 * Starting from `rootFiles`, parses each file for imports/exports, resolves
 * specifiers via `Bun.resolveSync`, and recursively discovers transitive
 * dependencies. The graph includes all reachable non-terminal files.
 *
 * `readFile` and `resolve` are injectable for testing.
 */
export function buildImportGraph(
  rootFiles: readonly string[],
  opts?: BuildGraphOptions | ((path: string) => string),
): ImportGraph {
  const readFile = typeof opts === "function" ? opts : (opts?.readFile ?? ((p: string) => readFileSync(p, "utf8")));
  const resolve = (typeof opts === "object" && opts !== null ? opts?.resolve : undefined) ?? defaultResolve;
  const edges: MutableEdges = {
    forward: new Map(),
    reverse: new Map(),
  };
  const allFiles = new Set<string>();
  const queue = [...rootFiles];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    allFiles.add(file);

    let content: string;
    try {
      content = readFile(file);
    } catch {
      continue;
    }

    const fileEdges = extractEdges(content, file, resolve);
    edges.forward.set(file, fileEdges);

    for (const edge of fileEdges) {
      allFiles.add(edge.target);
      let rev = edges.reverse.get(edge.target);
      if (!rev) {
        rev = new Set();
        edges.reverse.set(edge.target, rev);
      }
      rev.add(file);

      if (!visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  // Expand barrel re-exports: if A has `export * from B`, every consumer
  // of A also transitively depends on everything B exports. We propagate
  // barrel edges by adding direct forward edges from barrel sources to
  // their star-exported targets' own dependencies (transitively).
  // This is handled naturally by the transitive closure — if A → B is
  // in the forward graph, closureOf(A) already includes closureOf(B).
  // The `isBarrelReExport` flag is preserved for rule consumers that
  // want to distinguish barrel re-exports from direct imports.

  return createGraph(edges, allFiles);
}

function createGraph(edges: MutableEdges, allFiles: Set<string>): ImportGraph {
  const closureCache = new Map<string, ReadonlySet<string>>();
  const reverseClosureCache = new Map<string, ReadonlySet<string>>();

  function closureOf(file: string): ReadonlySet<string> {
    const cached = closureCache.get(file);
    if (cached) return cached;

    const result = new Set<string>();
    const stack = [file];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const fwd = edges.forward.get(current);
      if (!fwd) continue;
      for (const edge of fwd) {
        result.add(edge.target);
        if (!seen.has(edge.target)) stack.push(edge.target);
      }
    }

    closureCache.set(file, result);
    return result;
  }

  function dependentsOf(file: string): ReadonlySet<string> {
    const cached = reverseClosureCache.get(file);
    if (cached) return cached;

    const result = new Set<string>();
    const stack = [file];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const rev = edges.reverse.get(current);
      if (!rev) continue;
      for (const dep of rev) {
        result.add(dep);
        if (!seen.has(dep)) stack.push(dep);
      }
    }

    reverseClosureCache.set(file, result);
    return result;
  }

  return {
    forward: edges.forward,
    reverse: edges.reverse,
    files: allFiles,
    closureOf,
    dependentsOf,
  };
}
