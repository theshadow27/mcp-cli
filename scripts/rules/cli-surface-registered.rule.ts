import ts from "typescript";

import type { AstHelper } from "./_engine/ast";
import { createAstHelper } from "./_engine/ast";
import type { CheckRule, RuleContext } from "./_engine/rule";

const MAIN_REL = "packages/command/src/main.ts";
const COMPLETIONS_REL = "packages/command/src/commands/completions.ts";

function collectSwitchCases(ctx: RuleContext): Array<{ name: string; line: number; col: number }> {
  const results: Array<{ name: string; line: number; col: number }> = [];
  const switches = ctx.ast.find(ts.isSwitchStatement);
  for (const sw of switches) {
    // Only the top-level `switch (command)` dispatch — skip helper-function switches
    // that happen to use a different variable (e.g. `switch (transport)`).
    if (!ts.isIdentifier(sw.expression) || sw.expression.text !== "command") continue;
    // Defense-in-depth: also skip any switch nested inside another switch.
    const isNested = ts.findAncestor(sw.parent, ts.isSwitchStatement) !== undefined;
    if (isNested) continue;
    for (const clause of sw.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      if (!ts.isStringLiteral(clause.expression)) continue;
      const pos = ctx.ast.positionOf(clause);
      results.push({ name: clause.expression.text, line: pos.line, col: pos.column });
    }
  }
  return results;
}

function extractSubcommandsFromAst(ast: AstHelper): Set<string> | null {
  const decls = ast.find(ts.isVariableDeclaration);
  for (const decl of decls) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== "SUBCOMMANDS") continue;
    if (!decl.initializer) continue;
    // Unwrap `as const` — the initializer is an AsExpression wrapping the real array.
    const init = ts.isAsExpression(decl.initializer) ? decl.initializer.expression : decl.initializer;
    if (!ts.isArrayLiteralExpression(init)) continue;
    const result = new Set<string>();
    for (const elem of init.elements) {
      if (ts.isStringLiteral(elem)) result.add(elem.text);
    }
    return result;
  }
  return null;
}

function findSubcommands(ctx: RuleContext): Set<string> | null {
  // Fixtures inline SUBCOMMANDS in the same file — check the local AST first.
  const local = extractSubcommandsFromAst(ctx.ast);
  if (local !== null) return local;
  // Cross-file: exact path match to avoid colliding with test fixtures.
  for (const meta of ctx.files.values()) {
    if (meta.relPath === COMPLETIONS_REL) {
      return extractSubcommandsFromAst(createAstHelper(meta));
    }
  }
  return null;
}

const rule: CheckRule = {
  id: "cli-surface-registered",
  kind: "check",
  scold: "CLI subcommand in dispatch but not registered in SUBCOMMANDS (completions.ts)",
  guidance: [
    "Add the command to the SUBCOMMANDS array in packages/command/src/commands/completions.ts",
    "Also add it to printUsage() in packages/command/src/main.ts if user-facing",
    "Until a centralized COMMANDS registry exists, every dispatch case must appear in SUBCOMMANDS",
  ],
  documentation: "#2246",
  appliesToTests: false,
  check(ctx) {
    if (ctx.file.relPath !== MAIN_REL) return;

    const cases = collectSwitchCases(ctx);
    if (cases.length === 0) return;

    const subcommands = findSubcommands(ctx);
    if (!subcommands) {
      // Hard-error: completions.ts is missing from the file set (renamed? moved?).
      // Silently skipping here would give false confidence that the invariant is enforced.
      ctx.violated(1, 1, `SUBCOMMANDS anchor not found — is ${COMPLETIONS_REL} missing or renamed?`);
      return;
    }

    for (const { name, line, col } of cases) {
      if (!subcommands.has(name)) {
        ctx.violated(line, col, `case "${name}"`);
      }
    }
  },
};

export default rule;
