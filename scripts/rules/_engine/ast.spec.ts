import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { createAstHelper } from "./ast";
import type { FileMeta } from "./file-loader";

function makeMeta(content: string, path = "/fake/test.ts"): FileMeta {
  return { path, relPath: "packages/core/src/test.ts", content, pkg: "packages/core", isTest: false };
}

describe("createAstHelper", () => {
  it("caches the SourceFile across calls for the same FileMeta", () => {
    const file = makeMeta("const x = 1;");
    const a = createAstHelper(file);
    const b = createAstHelper(file);
    expect(a.sourceFile).toBe(b.sourceFile);
  });

  it("parses distinct SourceFiles for different FileMeta objects", () => {
    const f1 = makeMeta("const x = 1;", "/a.ts");
    const f2 = makeMeta("const x = 1;", "/b.ts");
    expect(createAstHelper(f1).sourceFile).not.toBe(createAstHelper(f2).sourceFile);
  });
});

describe("find()", () => {
  it("collects nodes matching a type guard", () => {
    const ast = createAstHelper(
      makeMeta(`
      const a = 1;
      let b = 2;
      const c = 3;
    `),
    );
    const decls = ast.find(ts.isVariableDeclaration);
    expect(decls.length).toBe(3);
    expect(decls.map((d) => d.name.getText(ast.sourceFile))).toEqual(["a", "b", "c"]);
  });
});

describe("findByKind()", () => {
  it("collects nodes with the given SyntaxKind", () => {
    const ast = createAstHelper(makeMeta(`const x = "hello"; const y = "world";`));
    const literals = ast.findByKind(ts.SyntaxKind.StringLiteral);
    expect(literals.length).toBe(2);
  });
});

describe("callsTo()", () => {
  it("finds direct function calls", () => {
    const ast = createAstHelper(
      makeMeta(`
      foo(1);
      bar(2);
      foo(3);
    `),
    );
    const calls = ast.callsTo("foo");
    expect(calls.length).toBe(2);
  });

  it("finds method calls via property access", () => {
    const ast = createAstHelper(
      makeMeta(`
      obj.doSomething();
      other.doSomething();
      obj.doElse();
    `),
    );
    expect(ast.callsTo("doSomething").length).toBe(2);
    expect(ast.callsTo("doElse").length).toBe(1);
  });

  it("returns empty for no matches", () => {
    const ast = createAstHelper(makeMeta("const x = 1;"));
    expect(ast.callsTo("nonexistent")).toEqual([]);
  });
});

describe("positionOf()", () => {
  it("returns 1-indexed line and column", () => {
    const ast = createAstHelper(makeMeta("const x = 1;\nconst y = 2;"));
    const decls = ast.find(ts.isVariableDeclaration);
    const second = decls[1];
    expect(second).toBeDefined();
    const pos = ast.positionOf(second as ts.VariableDeclaration);
    expect(pos.line).toBe(2);
    expect(pos.column).toBe(7);
  });
});

describe("stringLiterals()", () => {
  it("extracts string literal values from a subtree", () => {
    const ast = createAstHelper(makeMeta(`const arr = ["a", "b", "c"];`));
    const decls = ast.find(ts.isArrayLiteralExpression);
    const first = decls[0];
    expect(first).toBeDefined();
    expect(ast.stringLiterals(first as ts.ArrayLiteralExpression)).toEqual(["a", "b", "c"]);
  });

  it("extracts no-substitution template literals", () => {
    const ast = createAstHelper(makeMeta("const x = `hello`;"));
    const values = ast.stringLiterals(ast.sourceFile);
    expect(values).toContain("hello");
  });

  it("ignores non-string nodes", () => {
    const ast = createAstHelper(makeMeta(`const arr = [1, 2, "only"];`));
    const arrs = ast.find(ts.isArrayLiteralExpression);
    const first = arrs[0];
    expect(first).toBeDefined();
    expect(ast.stringLiterals(first as ts.ArrayLiteralExpression)).toEqual(["only"]);
  });
});

describe("TSX handling", () => {
  it("parses TSX content without errors", () => {
    const ast = createAstHelper(
      makeMeta(`
      const el = <div className="test">hello</div>;
    `),
    );
    expect(ast.sourceFile.parseDiagnostics.length).toBe(0);
  });
});
