import ts from "typescript";
import type { FileMeta } from "./file-loader";

export interface AstHelper {
  /** The parsed SourceFile. Rules needing the full TS API start here. */
  readonly sourceFile: ts.SourceFile;

  /** Walk all descendants, collecting nodes that match a type guard. */
  find<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[];

  /** Walk all descendants, collecting nodes with the given SyntaxKind. */
  findByKind(kind: ts.SyntaxKind): ts.Node[];

  /** Find CallExpression nodes where the callee identifier matches `name`. */
  callsTo(name: string): ts.CallExpression[];

  /** Convert a node's start position to 1-indexed { line, column }. */
  positionOf(node: ts.Node): { line: number; column: number };

  /** Extract string-literal text values from all StringLiteral / NoSubstitutionTemplateLiteral descendants. */
  stringLiterals(node: ts.Node): string[];
}

const sourceFileCache = new WeakMap<FileMeta, ts.SourceFile>();

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function getSourceFile(file: FileMeta): ts.SourceFile {
  let sf = sourceFileCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKindFor(file.path));
    sourceFileCache.set(file, sf);
  }
  return sf;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function createAstHelper(file: FileMeta): AstHelper {
  const sourceFile = getSourceFile(file);

  return {
    get sourceFile() {
      return sourceFile;
    },

    find<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] {
      const results: T[] = [];
      walk(sourceFile, (n) => {
        if (guard(n)) results.push(n);
      });
      return results;
    },

    findByKind(kind: ts.SyntaxKind): ts.Node[] {
      const results: ts.Node[] = [];
      walk(sourceFile, (n) => {
        if (n.kind === kind) results.push(n);
      });
      return results;
    },

    callsTo(name: string): ts.CallExpression[] {
      const results: ts.CallExpression[] = [];
      walk(sourceFile, (n) => {
        if (!ts.isCallExpression(n)) return;
        const expr = n.expression;
        if (ts.isIdentifier(expr) && expr.text === name) {
          results.push(n);
        } else if (ts.isPropertyAccessExpression(expr) && expr.name.text === name) {
          results.push(n);
        }
      });
      return results;
    },

    positionOf(node: ts.Node): { line: number; column: number } {
      const lc = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return { line: lc.line + 1, column: lc.character + 1 };
    },

    stringLiterals(node: ts.Node): string[] {
      const values: string[] = [];
      walk(node, (n) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          values.push(n.text);
        }
      });
      return values;
    },
  };
}
