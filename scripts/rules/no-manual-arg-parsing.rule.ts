/**
 * Rule: no-manual-arg-parsing
 *
 * Flag hand-rolled `args[++i]`, `args[i + 1]`, `allArgs[i + 1]`, and
 * `argv.shift()` patterns inside command files. These are the source of
 * the "next flag consumed as value" bug class (e.g. `--repo --all`
 * silently setting repo = "--all").
 *
 * Uses AST-based detection so comments, string literals, template
 * literals, and type annotations are never matched.
 *
 * The fix is to use `parseFlags(argv, specs)` from
 * `packages/command/src/flags.ts`, which centralizes bounds checks,
 * `-`-prefix rejection, `--flag=value`, numeric coercion, and
 * unknown-flag detection.
 */

import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const ARG_ARRAY_NAMES = new Set(["args", "allArgs", "argv"]);

const rule: CheckRule = {
  id: "no-manual-arg-parsing",
  kind: "check",
  scold: "manual args[++i] / args[i+1] / allArgs[...] / argv.shift() flag parsing — use parseFlags() instead",
  guidance: [
    "use parseFlags(argv, specs) from packages/command/src/flags.ts",
    "parseFlags handles bounds checks, rejects -prefixed values, supports --flag=value and numeric coercion",
    "for complex multi-value flags, consider the repeatable option in FlagSpec",
  ],
  documentation: "#2250",
  appliesToTests: false,
  check({ file, violated, ast }) {
    if (!file.relPath.startsWith("packages/command/src/commands/")) return;

    const lines = file.content.split("\n");

    for (const node of ast.find(ts.isElementAccessExpression)) {
      if (!ts.isIdentifier(node.expression)) continue;
      if (!ARG_ARRAY_NAMES.has(node.expression.text)) continue;

      const arg = node.argumentExpression;
      if (!arg) continue;

      const isPreIncrement = ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.PlusPlusToken;

      const isIndexPlusOne =
        ts.isBinaryExpression(arg) &&
        arg.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isIdentifier(arg.left) &&
        ts.isNumericLiteral(arg.right) &&
        arg.right.text === "1";

      if (isPreIncrement || isIndexPlusOne) {
        const pos = ast.positionOf(node);
        violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
      }
    }

    for (const node of ast.callsTo("shift")) {
      if (!ts.isPropertyAccessExpression(node.expression)) continue;
      if (!ts.isIdentifier(node.expression.expression)) continue;
      if (node.expression.expression.text !== "argv") continue;
      const pos = ast.positionOf(node);
      violated(pos.line, pos.column, lines[pos.line - 1]?.trim() ?? "");
    }
  },
};

export default rule;
