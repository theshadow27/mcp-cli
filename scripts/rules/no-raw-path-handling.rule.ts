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
    "replace `a === process.cwd()` with `pathEq(a, canonicalCwd())`",
    'import { pathEq, canonicalCwd } from "@mcp-cli/core" for realpath-normalized comparisons',
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

    // Detection 2: process.cwd() as direct operand of === / !== (daemon scope only)
    if (!file.relPath.startsWith("packages/daemon/src/")) return;

    for (const bin of ast.findByKind(ts.SyntaxKind.BinaryExpression) as ts.BinaryExpression[]) {
      const op = bin.operatorToken.kind;
      if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
      if (!isProcessCwd(bin.left) && !isProcessCwd(bin.right)) continue;
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

export default rule;
