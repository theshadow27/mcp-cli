/**
 * Rule: no-raw-path-handling
 *
 * Catches two patterns of ad-hoc path handling that produce silent
 * zero-match / cross-repo bugs when symlinks or subdir invocations
 * are involved:
 *
 * 1. `s.startsWith("/")` or `s.startsWith("\\\\")` used as an
 *    absolute-path test instead of `path.isAbsolute(s)`.
 *
 * 2. (daemon only) `process.cwd()` compared with `===`/`!==` without
 *    going through `resolveRealpath`/`canonicalCwd` — symlinked CWDs
 *    silently fail the comparison.
 *
 * 3. (daemon only) `process.cwd()` passed as the *key* (first argument)
 *    to Map-like methods (`.get`, `.set`, `.has`, `.delete`) — raw CWD
 *    as a lookup key silently misses under symlinks. Only argument 0
 *    is checked; `.set(key, process.cwd())` (value position) is fine.
 *
 * 4. (daemon only) `const` variable bound to `process.cwd()` then used
 *    in `===`/`!==` comparison — same bug class as Detection 2 but one
 *    step removed. Resolution uses scope-aware name lookup, not raw
 *    identifier text matching, so parameters/locals that shadow an
 *    outer const are not falsely flagged.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const SLASH = "/";
const UNC_PREFIX = "\\\\";
const MAP_METHODS = new Set(["get", "set", "has", "delete"]);

const rule: CheckRule = {
  id: "no-raw-path-handling",
  kind: "check",
  scold: "raw path handling — use path.isAbsolute / pathEq / canonicalCwd instead",
  guidance: [
    'replace `s.startsWith("/")` with `path.isAbsolute(s)` (handles both Unix and Windows paths)',
    "replace `a === process.cwd()` with `pathEq(a, canonicalCwd())`",
    'import { pathEq, canonicalCwd } from "@mcp-cli/core" for realpath-normalized comparisons',
    "variable-bound form (`const dir = process.cwd(); dir === x`) is caught — use `canonicalCwd()` at the assignment site",
    "Map lookups with raw CWD as key (`cache.get(process.cwd())`) are caught — normalize with `canonicalCwd()` first",
  ],
  documentation: "#2251",
  appliesToTests: false,
  check({ file, violated, ast }) {
    if (!file.relPath.startsWith("packages/")) return;

    const lines = file.content.split("\n");

    // Detection 1: .startsWith("/") or .startsWith("\\\\") as abs-path check.
    // callsTo("startsWith") matches by method name only, not receiver type — any
    // object method named startsWith with a "/" arg will be flagged. In practice
    // all such calls in this codebase are string operations, but use dotw-ignore
    // with a reason if you have a legitimate non-path startsWith("/") call.
    for (const call of ast.callsTo("startsWith")) {
      if (call.arguments.length < 1) continue;
      const arg = call.arguments[0];
      if (!ts.isStringLiteral(arg)) continue;
      if (arg.text !== SLASH && arg.text !== UNC_PREFIX) continue;
      const pos = ast.positionOf(call);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }

    // Detections 2–4 are daemon-scoped only.
    if (!file.relPath.startsWith("packages/daemon/src/")) return;

    // Detection 2: process.cwd() as direct operand of === / !==
    for (const bin of ast.findByKind(ts.SyntaxKind.BinaryExpression) as ts.BinaryExpression[]) {
      const op = bin.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
      if (!isProcessCwd(bin.left) && !isProcessCwd(bin.right)) continue;
      const pos = ast.positionOf(bin);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }

    // Detection 3: process.cwd() as the *key* argument (position 0) to Map-like
    // method calls. Only position 0 matters — `.set(key, process.cwd())` puts
    // the cwd in the value position and is not a lookup-key normalization bug.
    for (const call of ast.findByKind(ts.SyntaxKind.CallExpression) as ts.CallExpression[]) {
      if (!ts.isPropertyAccessExpression(call.expression)) continue;
      if (!MAP_METHODS.has(call.expression.name.text)) continue;
      if (call.arguments.length === 0) continue;
      if (!isProcessCwd(call.arguments[0])) continue;
      const pos = ast.positionOf(call);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }

    // Detection 4: identifier compared with === / !== that resolves (by JS
    // scope rules) to a `const` declaration bound to `process.cwd()`. Walks
    // up from each comparison identifier through enclosing scopes so a
    // shadowing parameter or local of the same name is *not* falsely flagged.
    for (const bin of ast.findByKind(ts.SyntaxKind.BinaryExpression) as ts.BinaryExpression[]) {
      const op = bin.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
      const leftHit = ts.isIdentifier(bin.left) && resolvesToCwdConst(bin.left);
      const rightHit = ts.isIdentifier(bin.right) && resolvesToCwdConst(bin.right);
      if (!leftHit && !rightHit) continue;
      const pos = ast.positionOf(bin);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }
  },
};

/** Match `process.cwd()` optionally wrapped in parentheses — no recursive descent. */
function isProcessCwd(node: ts.Node): boolean {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return (
    ts.isCallExpression(n) &&
    n.arguments.length === 0 &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "process" &&
    n.expression.name.text === "cwd"
  );
}

/**
 * Resolve an identifier to the nearest enclosing declaration (parameter or
 * const variable) using JS scope rules, then report whether it's a `const`
 * bound to `process.cwd()`. Parameters and shadowing inner locals correctly
 * short-circuit the walk — they're the binding the identifier refers to, so
 * the outer `const cwd = process.cwd()` is not consulted.
 */
function resolvesToCwdConst(id: ts.Identifier): boolean {
  const decl = lookupName(id.text, id);
  if (!decl || !ts.isVariableDeclaration(decl)) return false;
  const declList = decl.parent;
  if (!ts.isVariableDeclarationList(declList)) return false;
  if (!(declList.flags & ts.NodeFlags.Const)) return false;
  return !!decl.initializer && isProcessCwd(decl.initializer);
}

function lookupName(name: string, from: ts.Node): ts.Declaration | undefined {
  let current: ts.Node = from;
  while (current.parent) {
    const parent: ts.Node = current.parent;

    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent)
    ) {
      for (const p of parent.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
    }

    // for-loop bindings (`for (const x = ...; ...)`, `for (const x of ...)`) are
    // block-scoped to the loop including its body, so check them when ascending
    // out of the body but before the enclosing function/block scope.
    if (ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      const init = parent.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        for (const decl of init.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
        }
      }
    }

    if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent)) {
      const found = findConstDeclInScope(parent, name);
      if (found) return found;
    }

    current = parent;
  }
  return undefined;
}

/**
 * Look up a `const`/`let`/`var` declaration of `name` in the *direct* statement
 * list of `scope`. Walking all descendants would leak nested-block bindings
 * (e.g. `if (cond) { const x = ... }`) into outer scopes, violating JS lexical
 * scope and producing both false positives and false negatives.
 */
function findConstDeclInScope(
  scope: ts.Block | ts.SourceFile | ts.ModuleBlock,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const stmt of scope.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
    }
  }
  return undefined;
}

export default rule;
