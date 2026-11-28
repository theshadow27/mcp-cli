import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * Flag `expect(arr.filter(...)).toHaveLength(0)` and `.toEqual([])` in tests.
 *
 * Why this is a trap: filtering is *subtractive*. You delete rows from the collection before you
 * ever look at it, so anything the filter removed can no longer fail the assertion. A passing
 * `filter(...).toHaveLength(0)` tells you "the specific bad thing I searched for is absent": it
 * can never tell you "the output is correct". The unexpected, the malformed, the entries you did
 * not think to filter for: all silently pass. A predicate that matches nothing at all (a renamed
 * field, a typo) makes the test pass forever. Assert against the *whole* collection instead.
 *
 * Flagged: `expect(<anything containing .filter(...)>)` (also through `.resolves`/`.rejects`)
 * with `toHaveLength(0)`, `toEqual([])` or `toStrictEqual([])`; and `expect(<x>.filter(...).length)`
 * with `toBe(0)`. Deliberately not caught: `.not` forms (`.not.toHaveLength(0)` after a filter
 * asserts that something matched, which is the fix), `.some`/`.find`, a filter stored in a variable
 * first, and non-empty expectations such as `toHaveLength(2)`, which do pin the filter down.
 * Sources: #2085, #2099.
 */
const isEmptyArray = (node: TSESTree.Node | undefined): boolean =>
  node?.type === "ArrayExpression" && node.elements.length === 0;

const isZero = (node: TSESTree.Node | undefined): boolean => node?.type === "Literal" && node.value === 0;

const isFilterCall = (node: TSESTree.Node): boolean =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "filter";

function containsFilterCall(root: TSESTree.Node): boolean {
  let found = false;
  walk(root, (node) => {
    if (isFilterCall(node)) found = true;
  });
  return found;
}

/** Is `arg` a `.filter(...).length` read? */
const isFilteredLength = (arg: TSESTree.Node): boolean =>
  arg.type === "MemberExpression" &&
  arg.property.type === "Identifier" &&
  arg.property.name === "length" &&
  isFilterCall(arg.object);

function emptinessMatcher(matcher: string, argument: TSESTree.Node | undefined, arg: TSESTree.Node): boolean {
  if (matcher === "toHaveLength") return isZero(argument);
  if (matcher === "toEqual" || matcher === "toStrictEqual") return isEmptyArray(argument);
  return matcher === "toBe" && isZero(argument) && isFilteredLength(arg);
}

/** The `expect(...)` call at the root of a matcher chain, and whether the chain passed through `.not`. */
function expectOf(receiver: TSESTree.Node): { call: TSESTree.CallExpression; negated: boolean } | undefined {
  let negated = false;
  let node = receiver;
  for (;;) {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect") {
      return { call: node, negated };
    }
    if (node.type === "MemberExpression") {
      if (node.property.type === "Identifier" && node.property.name === "not") negated = true;
      node = node.object;
    } else if (node.type === "CallExpression") node = node.callee;
    else return undefined;
  }
}

export default {
  id: "test-filtered-assertion",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "expect(collection.filter(...)) hides unexpected items — assert the whole collection instead",
  guidance: [
    "filtering is subtractive: whatever the filter removed can never fail the test, so .filter(...).toHaveLength(0) proves only that the bad thing you searched for is absent — never that the output is correct. Assert against the whole collection so unexpected items fail too.",
    "examples of doing it right (not exhaustive): expect(arr).toEqual([]) when it should be empty; expect(arr).not.toContainEqual(expect.objectContaining({ field: V })) when it legitimately holds other items (the filter predicate you wrote is the matcher); for a filter(p).map(f).toEqual([]), assert per element — for (const e of arr) expect(p(e)).toBe(false).",
  ],
  documentation: "#2247",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const { object, property } = node.callee;
      if (property.type !== "Identifier") return;
      const root = expectOf(object);
      if (root === undefined || root.negated || root.call.arguments.length !== 1) return;
      const [arg] = root.call.arguments;
      if (arg === undefined || !containsFilterCall(arg)) return;
      if (!emptinessMatcher(property.name, node.arguments[0], arg)) return;
      const { line, column } = root.call.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
