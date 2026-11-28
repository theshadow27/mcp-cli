import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Flags `.message.startsWith(...)` / `.includes` / `.endsWith` / `.indexOf` / `.match` /
 * `.matchAll` / `.search` (and `re.test(x.message)`) when the call sits anywhere inside the
 * condition of an `if`, `while`, `do`, `? :`, `for`, or the subject of a `switch` / `case`.
 *
 * Why: error message text is prose, not a stable contract. The moment a message is reworded the
 * branch silently stops firing. The alternative is `instanceof TypedError` or a structured `code`
 * field for branching, and `getErrorMessage(err)` from `packages/core` for human-facing display.
 *
 * The walk distinguishes control-flow conditions from display paths:
 *   - flagged: `if (err.message.includes("timeout")) { ... }`
 *   - clean:   `log(getErrorMessage(err))` / `console.error(err.message)`
 * Deliberately not caught: a message copied into a variable first, a sniff stored as a value
 * (`const has = err instanceof Error && err.message.includes("x")`), and an exact comparison
 * (`err.message === "x"`): following them needs data flow that a syntax rule does not have.
 */
const SNIFF_METHODS = new Set(["startsWith", "includes", "endsWith", "indexOf", "match", "matchAll", "search"]);

/** Strips the wrappers that change nothing at runtime: `(x as Error)`, `x!`, optional chains. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  return node.type === "TSAsExpression" || node.type === "TSNonNullExpression" || node.type === "ChainExpression"
    ? unwrap(node.expression)
    : node;
}

const propertyName = (member: TSESTree.MemberExpression): string | undefined =>
  !member.computed && member.property.type === "Identifier" ? member.property.name : undefined;

/** `x.message`, whatever `x` is. */
function isMessage(node: TSESTree.Node): boolean {
  const inner = unwrap(node);
  return inner.type === "MemberExpression" && propertyName(inner) === "message";
}

/** `err.message.includes(x)`, `err.message.match(re)` or `re.test(err.message)`. */
function sniffsMessage(call: TSESTree.CallExpression): boolean {
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") return false;
  const method = propertyName(callee) ?? "";
  if (method === "test") return call.arguments[0] !== undefined && isMessage(call.arguments[0]);
  return SNIFF_METHODS.has(method) && isMessage(callee.object);
}

/** Whether `child` occupies the condition slot of `parent`. */
function isConditionSlot(parent: TSESTree.Node, child: TSESTree.Node): boolean {
  switch (parent.type) {
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ConditionalExpression":
    case "ForStatement":
    case "SwitchCase":
      return parent.test === child;
    case "SwitchStatement":
      return parent.discriminant === child;
    default:
      return false;
  }
}

function inCondition(node: TSESTree.Node): boolean {
  for (let child = node, parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (isConditionSlot(parent, child)) return true;
  }
  return false;
}

export default {
  id: "no-error-message-sniffing",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold: "error message sniffed for control flow — use instanceof or a structured code field instead",
  guidance: [
    "branch on `instanceof TypedError` or check a typed `code` field — not on message text",
    "message prose is not a stable contract; it silently breaks when the text is reworded",
    "use `getErrorMessage(err)` from packages/core for human-facing display only",
    "rethrow with `{ cause: err }` to preserve the stack",
  ],
  documentation: "#2264",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || !sniffsMessage(node) || !inCondition(node)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
