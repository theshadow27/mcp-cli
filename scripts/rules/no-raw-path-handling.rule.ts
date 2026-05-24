/**
 * Rule: no-raw-path-handling
 *
 * Catches two patterns of ad-hoc path handling that produce silent
 * zero-match / cross-repo bugs when symlinks or subdir invocations
 * are involved:
 *
 * 1. `s.startsWith("/")` (or `"\\\\")` used as an absolute-path test
 *    instead of `path.isAbsolute(s)`.
 *
 * 2. (daemon only) `process.cwd()` compared with `===`/`!==` without
 *    going through `resolveRealpath`/`canonicalCwd` — symlinked CWDs
 *    silently fail the comparison.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const SLASH = "/";
const UNC_PREFIX = "\\\\";

const rule: CheckRule = {
  id: "no-raw-path-handling",
  kind: "check",
  scold: "raw path handling — use path.isAbsolute / pathEq / canonicalCwd instead",
  guidance: [
    'replace `s.startsWith("/")` with `path.isAbsolute(s)` (handles both Unix and Windows paths)',
    "replace `a === process.cwd()` with `pathEq(a, b)` or compare against `canonicalCwd()`",
    'import { pathEq, canonicalCwd } from "@mcp-cli/core" for realpath-normalized comparisons',
  ],
  documentation: "#2251",
  appliesToTests: false,
  check({ file, violated, ast }) {
    if (!file.relPath.startsWith("packages/")) return;

    const lines = file.content.split("\n");

    // Detection 1: .startsWith("/") or .startsWith("\\\\") as abs-path check
    for (const call of ast.callsTo("startsWith")) {
      if (call.arguments.length < 1) continue;
      const arg = call.arguments[0];
      if (!ts.isStringLiteral(arg)) continue;
      if (arg.text !== SLASH && arg.text !== UNC_PREFIX) continue;
      const pos = ast.positionOf(call);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }

    // Detection 2: process.cwd() in === / !== (daemon scope only)
    if (!file.relPath.startsWith("packages/daemon/src/")) return;

    for (const bin of ast.findByKind(ts.SyntaxKind.BinaryExpression) as ts.BinaryExpression[]) {
      const op = bin.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
      if (!containsProcessCwd(bin.left) && !containsProcessCwd(bin.right)) continue;
      const pos = ast.positionOf(bin);
      violated(pos.line, pos.column, (lines[pos.line - 1] ?? "").trim());
    }
  },
};

function containsProcessCwd(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "cwd"
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (containsProcessCwd(child)) found = true;
  });
  return found;
}

export default rule;
