import ts from "typescript";
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "derive-union-from-const",
  kind: "check",
  scold: "string-literal union duplicates values from an `as const` array — derive with `(typeof X)[number]`",
  guidance: [
    'replace `type Foo = "a" | "b" | "c"` with `type Foo = (typeof FOO_VALUES)[number]`',
    "this keeps the runtime array and the type in sync — adding a value to the array automatically extends the type",
    "if the union intentionally differs from the array, suppress with `// dotw-ignore derive-union-from-const: <reason>`",
  ],
  documentation: "#2261",
  appliesToTests: false,
  check(ctx) {
    const { ast } = ctx;
    const constArrays = collectConstArrays(ast);
    if (constArrays.length === 0) return;

    for (const alias of ast.find(ts.isTypeAliasDeclaration)) {
      if (!ts.isUnionTypeNode(alias.type)) continue;

      const unionValues = extractStringUnionMembers(alias.type);
      if (!unionValues || unionValues.length < 2) continue;

      const unionSet = new Set(unionValues);
      for (const arr of constArrays) {
        if (unionSet.size > arr.values.size) continue;
        let isSubset = true;
        for (const v of unionValues) {
          if (!arr.values.has(v)) {
            isSubset = false;
            break;
          }
        }
        if (isSubset) {
          const pos = ast.positionOf(alias);
          const line = ctx.file.content.split("\n")[pos.line - 1] ?? "";
          ctx.violated(pos.line, pos.column, line.trim());
          break;
        }
      }
    }
  },
};

interface ConstArray {
  values: Set<string>;
}

function extractStringUnionMembers(union: ts.UnionTypeNode): string[] | undefined {
  const values: string[] = [];
  for (const member of union.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
      values.push(member.literal.text);
    } else {
      return undefined;
    }
  }
  return values;
}

function isAsConstInitializer(init: ts.Expression, sf: ts.SourceFile): ts.ArrayLiteralExpression | undefined {
  if (
    ts.isAsExpression(init) &&
    init.getText(sf).endsWith("as const") &&
    ts.isArrayLiteralExpression(init.expression)
  ) {
    return init.expression;
  }
  return undefined;
}

function collectConstArrays(ast: import("./_engine/ast").AstHelper): ConstArray[] {
  const results: ConstArray[] = [];
  for (const decl of ast.find(ts.isVariableDeclaration)) {
    if (!decl.initializer) continue;
    const arr = isAsConstInitializer(decl.initializer, ast.sourceFile);
    if (!arr) continue;
    const values = new Set<string>();
    for (const el of arr.elements) {
      if (ts.isStringLiteral(el)) values.add(el.text);
    }
    if (values.size > 0) results.push({ values });
  }
  return results;
}

export default rule;
