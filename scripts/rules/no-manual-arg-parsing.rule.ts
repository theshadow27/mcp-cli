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

import type { Rule, TSESTree } from "am-i-done";
import { walk } from "am-i-done";

const ARG_ARRAY_NAMES = new Set(["args", "allArgs", "argv"]);

function isArgArray(node: TSESTree.Node): boolean {
  return node.type === "Identifier" && ARG_ARRAY_NAMES.has(node.name);
}

export default {
  id: "no-manual-arg-parsing",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold: "manual args[++i] / args[i+1] / allArgs[...] / argv.shift() flag parsing — use parseFlags() instead",
  guidance: [
    "use parseFlags(argv, specs) from packages/command/src/flags.ts",
    "parseFlags handles bounds checks, rejects -prefixed values, supports --flag=value and numeric coercion",
    "for complex multi-value flags, consider the repeatable option in FlagSpec",
  ],
  documentation: "#2250",
  check(ctx) {
    const { file } = ctx;
    if (!file.relativePath.startsWith("packages/command/src/commands/")) return ctx.skipped();

    const lines = file.content.split("\n");
    const report = (node: TSESTree.Node) => {
      const line = node.loc.start.line;
      ctx.violated(line, node.loc.start.column + 1, lines[line - 1]?.trim() ?? "");
    };

    walk(ctx.ast().program, (node) => {
      if (node.type === "MemberExpression" && node.computed && isArgArray(node.object)) {
        const arg = node.property;
        const isPreIncrement = arg.type === "UpdateExpression" && arg.operator === "++" && arg.prefix;
        const isIndexPlusOne =
          arg.type === "BinaryExpression" &&
          arg.operator === "+" &&
          arg.left.type === "Identifier" &&
          arg.right.type === "Literal" &&
          arg.right.value === 1;
        if (isPreIncrement || isIndexPlusOne) report(node);
      }

      if (node.type === "CallExpression") {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "shift" &&
          isArgArray(callee.object)
        ) {
          report(node);
        }
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
