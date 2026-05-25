import ts from "typescript";

import type { AstHelper } from "./_engine/ast";
import { createAstHelper } from "./_engine/ast";
import type { FileMeta } from "./_engine/file-loader";
import type { CheckRule, RuleContext } from "./_engine/rule";

const MAIN_REL = "packages/command/src/main.ts";
const COMPLETIONS_REL = "packages/command/src/commands/completions.ts";
const COMMANDS_DIR = "packages/command/src/commands/";

interface NamedLocation {
  name: string;
  line: number;
  col: number;
}

// ── SUBCOMMANDS helpers ──────────────────────────────────────────────────

function collectSwitchCases(ctx: RuleContext): NamedLocation[] {
  const results: NamedLocation[] = [];
  const switches = ctx.ast.find(ts.isSwitchStatement);
  for (const sw of switches) {
    if (!ts.isIdentifier(sw.expression) || sw.expression.text !== "command") continue;
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

function extractSubcommandsWithPositions(ast: AstHelper): NamedLocation[] | null {
  const decls = ast.find(ts.isVariableDeclaration);
  for (const decl of decls) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== "SUBCOMMANDS") continue;
    if (!decl.initializer) continue;
    const init = ts.isAsExpression(decl.initializer) ? decl.initializer.expression : decl.initializer;
    if (!ts.isArrayLiteralExpression(init)) continue;
    const result: NamedLocation[] = [];
    for (const elem of init.elements) {
      if (ts.isStringLiteral(elem)) {
        const pos = ast.positionOf(elem);
        result.push({ name: elem.text, line: pos.line, col: pos.column });
      }
    }
    return result;
  }
  return null;
}

function extractSubcommandsFromAst(ast: AstHelper): Set<string> | null {
  const entries = extractSubcommandsWithPositions(ast);
  return entries ? new Set(entries.map((e) => e.name)) : null;
}

function findSubcommands(ctx: RuleContext): Set<string> | null {
  const local = extractSubcommandsFromAst(ctx.ast);
  if (local !== null) return local;
  for (const meta of ctx.files.values()) {
    if (meta.relPath === COMPLETIONS_REL) {
      return extractSubcommandsFromAst(createAstHelper(meta));
    }
  }
  return null;
}

/** Collect all command names dispatched by main.ts — switch cases + pre-switch args[0] checks. */
function collectDispatchedCommands(ast: AstHelper): Set<string> {
  const result = new Set<string>();

  const switches = ast.find(ts.isSwitchStatement);
  for (const sw of switches) {
    if (!ts.isIdentifier(sw.expression) || sw.expression.text !== "command") continue;
    const isNested = ts.findAncestor(sw.parent, ts.isSwitchStatement) !== undefined;
    if (isNested) continue;
    for (const clause of sw.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      if (!ts.isStringLiteral(clause.expression)) continue;
      result.add(clause.expression.text);
    }
  }

  for (const bin of ast.find(ts.isBinaryExpression)) {
    if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue;
    const strSide = ts.isStringLiteral(bin.left) ? bin.left : ts.isStringLiteral(bin.right) ? bin.right : undefined;
    if (!strSide || strSide.text.startsWith("-")) continue;
    const other = strSide === bin.left ? bin.right : bin.left;
    if (
      ts.isElementAccessExpression(other) &&
      ts.isIdentifier(other.expression) &&
      other.expression.text === "args" &&
      ts.isNumericLiteral(other.argumentExpression) &&
      other.argumentExpression.text === "0"
    ) {
      result.add(strSide.text);
    }
  }

  return result;
}

// ── KNOWN_FLAGS helpers ──────────────────────────────────────────────────

function extractKnownFlags(ast: AstHelper): { flags: Set<string>; entries: NamedLocation[] } | null {
  const decls = ast.find(ts.isVariableDeclaration);
  for (const decl of decls) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== "KNOWN_FLAGS") continue;
    if (!decl.initializer) continue;

    let arrayExpr: ts.ArrayLiteralExpression | undefined;

    if (ts.isNewExpression(decl.initializer)) {
      const arg = decl.initializer.arguments?.[0];
      if (arg && ts.isArrayLiteralExpression(arg)) arrayExpr = arg;
    } else if (ts.isArrayLiteralExpression(decl.initializer)) {
      arrayExpr = decl.initializer;
    } else if (ts.isAsExpression(decl.initializer) && ts.isArrayLiteralExpression(decl.initializer.expression)) {
      arrayExpr = decl.initializer.expression;
    }

    if (!arrayExpr) continue;

    const flags = new Set<string>();
    const entries: NamedLocation[] = [];
    for (const elem of arrayExpr.elements) {
      if (ts.isStringLiteral(elem)) {
        flags.add(elem.text);
        const pos = ast.positionOf(elem);
        entries.push({ name: elem.text, line: pos.line, col: pos.column });
      }
    }
    return { flags, entries };
  }
  return null;
}

const HELP_FLAGS = new Set(["--help", "-h"]);

function collectParsedFlags(ast: AstHelper): Map<string, { line: number; col: number }> {
  const result = new Map<string, { line: number; col: number }>();

  function addFlag(text: string, node: ts.Node) {
    // Accept both long (`--foo`) and short (`-h`) flag literals so the two
    // directions of the check are symmetric — the reverse direction iterates
    // every KNOWN_FLAGS entry, and excluding short flags here would mean a
    // KNOWN_FLAGS entry like `-h` could never be matched as "parsed".
    if (!text.startsWith("-")) return;
    if (HELP_FLAGS.has(text)) return;
    if (result.has(text)) return;
    const pos = ast.positionOf(node);
    result.set(text, { line: pos.line, col: pos.column });
  }

  for (const clause of ast.find(ts.isCaseClause)) {
    if (ts.isStringLiteral(clause.expression)) addFlag(clause.expression.text, clause.expression);
  }

  for (const bin of ast.find(ts.isBinaryExpression)) {
    if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue;
    if (ts.isStringLiteral(bin.left)) addFlag(bin.left.text, bin.left);
    if (ts.isStringLiteral(bin.right)) addFlag(bin.right.text, bin.right);
  }

  for (const call of [...ast.callsTo("indexOf"), ...ast.callsTo("includes")]) {
    const arg = call.arguments[0];
    if (arg && ts.isStringLiteral(arg)) addFlag(arg.text, arg);
  }

  return result;
}

// ── Rule ─────────────────────────────────────────────────────────────────

const rule: CheckRule = {
  id: "cli-surface-registered",
  kind: "check",
  scold: "CLI surface registration mismatch — command or flag set out of sync with its anchor",
  guidance: [
    "dispatch case without SUBCOMMANDS entry → add to SUBCOMMANDS in completions.ts",
    "SUBCOMMANDS entry without dispatch case → remove from SUBCOMMANDS or add case in main.ts",
    "parsed --flag missing from KNOWN_FLAGS → add to the KNOWN_FLAGS set in the same file",
    "KNOWN_FLAGS entry not parsed anywhere → remove from KNOWN_FLAGS or add code that handles it",
  ],
  documentation: "#2246, #2314, #2327",
  appliesToTests: false,
  check(ctx) {
    if (ctx.file.relPath === MAIN_REL) {
      checkDispatchToSubcommands(ctx);
    }

    if (ctx.file.relPath === COMPLETIONS_REL) {
      checkSubcommandsToDispatch(ctx);
    }

    if (ctx.file.relPath.startsWith(COMMANDS_DIR)) {
      checkFlagKnownFlags(ctx);
    }
  },
};

function checkDispatchToSubcommands(ctx: RuleContext): void {
  const cases = collectSwitchCases(ctx);
  if (cases.length === 0) return;

  const subcommands = findSubcommands(ctx);
  if (!subcommands) {
    ctx.violated(1, 1, `SUBCOMMANDS anchor not found — is ${COMPLETIONS_REL} missing or renamed?`);
    return;
  }

  for (const { name, line, col } of cases) {
    if (!subcommands.has(name)) {
      ctx.violated(line, col, `case "${name}"`);
    }
  }
}

function checkSubcommandsToDispatch(ctx: RuleContext): void {
  const entries = extractSubcommandsWithPositions(ctx.ast);
  if (!entries) return;

  let mainMeta: FileMeta | undefined;
  for (const meta of ctx.files.values()) {
    if (meta.relPath === MAIN_REL) {
      mainMeta = meta;
      break;
    }
  }
  if (!mainMeta) return;

  const mainAst = createAstHelper(mainMeta);
  const dispatched = collectDispatchedCommands(mainAst);

  for (const { name, line, col } of entries) {
    if (!dispatched.has(name)) {
      ctx.violated(line, col, `SUBCOMMANDS entry "${name}" has no dispatch case`);
    }
  }
}

function checkFlagKnownFlags(ctx: RuleContext): void {
  const known = extractKnownFlags(ctx.ast);
  if (!known) return;

  const parsed = collectParsedFlags(ctx.ast);

  for (const [flag, { line, col }] of parsed) {
    if (!known.flags.has(flag)) {
      ctx.violated(line, col, `flag "${flag}" parsed but not in KNOWN_FLAGS`);
    }
  }

  for (const { name, line, col } of known.entries) {
    // Skip help flags in the reverse direction too — they're handled centrally
    // (not per-command parse) and would otherwise be unmatchable when listed
    // in a per-command KNOWN_FLAGS for documentation/completion purposes.
    if (HELP_FLAGS.has(name)) continue;
    if (!parsed.has(name)) {
      ctx.violated(line, col, `KNOWN_FLAGS entry "${name}" not parsed anywhere`);
    }
  }
}

export default rule;
