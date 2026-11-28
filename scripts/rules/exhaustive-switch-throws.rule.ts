import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * `satisfies never` proves exhaustiveness over the declared union at compile time, and does
 * nothing at runtime. A `default:` clause or a terminal `else` block that only uses `satisfies
 * never` silently no-ops when an unexpected value arrives from a dynamic source (a JSON config, an
 * IPC payload, a loaded module). The fix is to pair it with a runtime `throw` or an
 * `assertNever()` helper that itself throws. Harvested from review comments on PRs #2192 and #2080.
 *
 * The proof is `x satisfies never` (the `const _: never = x` spelling is not recognized). The runtime half is a `throw`, or a
 * call to a known helper (`assertNever`, `exhaustive`, `unreachable`, `exhaust`, bare or as a
 * method: `expect.unreachable(x)`), at the branch's own depth: a function declared inside the
 * branch is not run by it, so a throw there does not count, while a throw in a nested switch of
 * the branch does. Object-literal `default:` keys are not switch defaults.
 */

/** Helper names whose call sites are treated as runtime exhaustiveness guards. */
const EXHAUSTIVENESS_HELPERS = new Set(["assertNever", "exhaustive", "unreachable", "exhaust"]);

const isFunction = (node: TSESTree.Node): boolean =>
  node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";

/** `x satisfies never`. */
const provesExhaustive = (node: TSESTree.Node): boolean =>
  node.type === "TSSatisfiesExpression" && node.typeAnnotation.type === "TSNeverKeyword";

/** `default:` clause, or the block of a terminal (non-`else if`) `else`. */
const isBranch = (node: TSESTree.Node): boolean =>
  (node.type === "SwitchCase" && node.test === null) ||
  (node.type === "BlockStatement" && node.parent?.type === "IfStatement" && node.parent.alternate === node);

/** The nearest branch around `node`, not looking past a function boundary. */
function branchOf(node: TSESTree.Node): TSESTree.Node | undefined {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (isFunction(up)) return undefined;
    if (isBranch(up)) return up;
  }
  return undefined;
}

const calleeName = (callee: TSESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
};

/** Whether `node` runs when `branch` does: not inside a function declared within it. */
function runsWithBranch(node: TSESTree.Node, branch: TSESTree.Node): boolean {
  for (let up = node.parent; up !== undefined && up !== branch; up = up.parent) if (isFunction(up)) return false;
  return true;
}

function hasRuntimeGuard(branch: TSESTree.Node): boolean {
  let found = false;
  walk(branch, (node) => {
    if (found || node === branch || !runsWithBranch(node, branch)) return;
    if (node.type === "ThrowStatement") found = true;
    else if (node.type === "CallExpression") {
      const name = calleeName(node.callee);
      if (name !== undefined && EXHAUSTIVENESS_HELPERS.has(name)) found = true;
    }
  });
  return found;
}

export default {
  id: "exhaustive-switch-throws",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold: "`satisfies never` in a default/else branch has no runtime throw — silently no-ops on unexpected values",
  guidance: [
    "pair the compile-time check with a runtime throw:",
    "  default: { action satisfies never; throw new Error(`unhandled: ${JSON.stringify(action)}`); }",
    "or use assertNever(action) — a helper that narrows the type AND throws",
    "or inline: assertNever(action satisfies never) — the call site proves both compile-time and runtime exhaustiveness",
  ],
  documentation: "#2252",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (!provesExhaustive(node)) return;
      const branch = branchOf(node);
      if (branch === undefined || hasRuntimeGuard(branch)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
