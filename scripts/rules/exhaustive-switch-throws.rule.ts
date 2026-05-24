/**
 * Rule: exhaustive-switch-throws
 *
 * `satisfies never` proves exhaustiveness over the declared union at
 * compile time, but does nothing at runtime. A default branch that
 * only uses `satisfies never` silently no-ops when an unexpected value
 * arrives from a dynamic source (a JSON config, an IPC payload, a loaded
 * module). The fix is to pair it with a runtime `throw` or an
 * `assertNever()` helper that itself throws.
 *
 * Harvested from review comments on PRs #2192 and #2080.
 *
 * Uses the TypeScript AST (ctx.ast) so structural scope — object-literal
 * `default:` keys, `throw` inside string literals, block boundaries,
 * nested-function isolation — is handled correctly without regex windows.
 */

import ts from "typescript";

import type { CheckRule } from "./_engine/rule";

/** Helper names whose call sites are treated as runtime exhaustiveness guards. */
const EXHAUSTIVENESS_HELPERS = new Set(["assertNever", "exhaustive", "unreachable", "exhaust"]);

/** True when the Block is the terminal (non-else-if) else branch of an IfStatement. */
function isTerminalElseBlock(node: ts.Node): node is ts.Block {
  if (!ts.isBlock(node)) return false;
  return ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
}

/**
 * True when the branch body (DefaultClause or Block) contains a ThrowStatement
 * or a call to a known exhaustiveness helper at the branch's own scope depth.
 * Does not descend into nested function bodies — a throw inside an arrow or
 * function expression only executes if that function is invoked, which the
 * rule cannot verify, so it doesn't count as a branch-level guard.
 */
function branchHasRuntimeGuard(branch: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && EXHAUSTIVENESS_HELPERS.has(n.expression.text)) {
      found = true;
      return;
    }
    // Mirror the parent-chain walk: stop at function boundaries so a throw
    // inside a nested arrow/function expression doesn't satisfy the guard.
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(branch, visit);
  return found;
}

const rule: CheckRule = {
  id: "exhaustive-switch-throws",
  kind: "check",
  scold: "`satisfies never` in a default/else branch has no runtime throw — silently no-ops on unexpected values",
  guidance: [
    "pair the compile-time check with a runtime throw:",
    "  default: { action satisfies never; throw new Error(`unhandled: ${JSON.stringify(action)}`); }",
    "or use assertNever(action) — a helper that narrows the type AND throws",
    "or inline: assertNever(action satisfies never) — the call site proves both compile-time and runtime exhaustiveness",
  ],
  documentation: "#2252",
  check({ file, ast, violated }) {
    const { sourceFile } = ast;
    const lines = sourceFile.text.split("\n");

    for (const node of ast.find(ts.isSatisfiesExpression)) {
      // Only care about `x satisfies never` (type argument is `never`).
      if (node.type.kind !== ts.SyntaxKind.NeverKeyword) continue;

      // Walk up the parent chain to find the nearest DefaultClause or
      // terminal-else Block. Stop at function boundaries to avoid crossing
      // into a separate scope (e.g. a satisfies-never inside an inline
      // helper defined within the default branch).
      const branch = ts.findAncestor(node.parent, (ancestor) => {
        if (ts.isFunctionLike(ancestor)) return "quit";
        if (ts.isDefaultClause(ancestor)) return true;
        if (isTerminalElseBlock(ancestor)) return true;
        return false;
      });

      if (!branch) continue;
      if (branchHasRuntimeGuard(branch)) continue;

      const { line, column } = ast.positionOf(node);
      violated(line, column, (lines[line - 1] ?? "").trim());
    }
  },
};

export default rule;
