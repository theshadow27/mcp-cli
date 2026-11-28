import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * A union of string literals written out beside an exported `as const` array of the same strings
 * is two lists that must be edited together. They are not: someone adds a value to the array, the
 * type keeps the old members, and the compiler reports nothing until a caller trips on it. Derive
 * one from the other: `type Kind = (typeof KINDS)[number]`.
 *
 * Scope: `packages/<pkg>/src/**` only. Only *exported* arrays count as the source of truth;
 * a non-exported array is a local helper (#2261).
 *
 * Flagged, within one file (a type alias, or a union written as the type of a field, parameter,
 * return or variable): a union of two or more strings that all appear in an exported array, and a
 * union that contains every string of an exported array (suggest `(typeof KINDS)[number] | "extra"`).
 * Strings in an array that also holds other things are still the array's strings. Deliberately not
 * caught: a union and array in different files, since matching them needs the import graph; a
 * union that is only partly in the array. A union nested in another type (a generic argument,
 * `("a" | "b")[]`) is not checked. `as const satisfies T` counts as `as const`.
 */
const PACKAGE_SRC_RE = /^packages\/[^/]+\/src\//;

/** `[...] as const`, as written in the source. */
function asConstArray(node: TSESTree.Expression): TSESTree.ArrayExpression | undefined {
  if (node.type === "TSSatisfiesExpression") return asConstArray(node.expression);
  if (node.type !== "TSAsExpression" || node.expression.type !== "ArrayExpression") return undefined;
  const type = node.typeAnnotation;
  const isConst =
    type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeName.name === "const";
  return isConst ? node.expression : undefined;
}

/** The strings of a list made only of string literals, or undefined if anything else is in it. */
function stringsOf(nodes: ReadonlyArray<TSESTree.Node | null>): Set<string> | undefined {
  const strings = new Set<string>();
  for (const node of nodes) {
    if (node?.type !== "Literal" || typeof node.value !== "string") return undefined;
    strings.add(node.value);
  }
  return strings.size > 0 ? strings : undefined;
}

/** The string literals among an array's elements, ignoring any other element. */
function stringsAmong(nodes: ReadonlyArray<TSESTree.Node | null>): Set<string> | undefined {
  const strings = new Set<string>();
  for (const node of nodes) if (node?.type === "Literal" && typeof node.value === "string") strings.add(node.value);
  return strings.size > 0 ? strings : undefined;
}

/** A union that is the whole body of a type alias, or the whole type of a field, parameter or variable. */
function isDeclaredType(node: TSESTree.TSUnionType): boolean {
  const parent = node.parent;
  return parent?.type === "TSTypeAliasDeclaration" || parent?.type === "TSTypeAnnotation";
}

/** `export const X = ...`: the declarator's statement is wrapped in an export. */
function isExported(declarator: TSESTree.VariableDeclarator): boolean {
  return declarator.parent?.parent?.type === "ExportNamedDeclaration";
}

export default {
  id: "derive-union-from-const",
  type: "check",
  category: "conventions",
  ast: true,
  tests: "exclude",
  scold: "string-literal union duplicates values from an `as const` array — derive with `(typeof X)[number]`",
  guidance: [
    'replace `type Foo = "a" | "b" | "c"` with `type Foo = (typeof FOO_VALUES)[number]`',
    "this keeps the runtime array and the type in sync — adding a value to the array automatically extends the type",
    'if the union adds members the array lacks, write `(typeof FOO_VALUES)[number] | "extra"`; for a subset, `Extract<Foo, "a" | "b">`',
    "only *exported* `as const` arrays are considered the source of truth — non-exported arrays are local helpers",
    "if the union intentionally differs from the array, suppress with `// doing-it-wrong-ignore derive-union-from-const: <reason> (#issue)`",
  ],
  documentation: "#2261",
  check(ctx) {
    if (!PACKAGE_SRC_RE.test(ctx.file.relativePath)) return ctx.skipped();
    const lines = ctx.file.content.split("\n");
    const arrays: Array<Set<string>> = [];
    const unions: Array<{ union: TSESTree.TSUnionType; strings: Set<string> }> = [];
    walk(ctx.ast().program, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
        const array = isExported(node) ? asConstArray(node.init) : undefined;
        const strings = array && stringsAmong(array.elements);
        if (strings) arrays.push(strings);
      } else if (node.type === "TSUnionType" && isDeclaredType(node)) {
        const members = node.types.map((member) => (member.type === "TSLiteralType" ? member.literal : null));
        const strings = stringsOf(members);
        if (strings) unions.push({ union: node, strings });
      }
    });
    for (const { union, strings } of unions) {
      const repeats = arrays.some((array) => {
        const inArray = [...strings].every((value) => array.has(value));
        const holdsAll = [...array].every((value) => strings.has(value));
        return (inArray && strings.size >= 2) || (holdsAll && array.size >= 2);
      });
      if (!repeats) continue;
      const { line, column } = union.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    }
    return ctx.checked();
  },
} satisfies Rule;
