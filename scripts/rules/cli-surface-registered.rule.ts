import ts from "typescript";

import type { CheckRule, RuleContext } from "./_engine/rule";

const MAIN_REL = "packages/command/src/main.ts";

function collectSwitchCases(ctx: RuleContext): Array<{ name: string; line: number; col: number }> {
  const results: Array<{ name: string; line: number; col: number }> = [];
  const switches = ctx.ast.find(ts.isSwitchStatement);
  for (const sw of switches) {
    for (const clause of sw.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      if (!ts.isStringLiteral(clause.expression)) continue;
      const pos = ctx.ast.positionOf(clause);
      results.push({ name: clause.expression.text, line: pos.line, col: pos.column });
    }
  }
  return results;
}

function extractSubcommands(content: string): Set<string> | null {
  const m = content.match(/\bSUBCOMMANDS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const literals: string[] = [];
  const re = /["']([^"']+)["']/g;
  for (const hit of m[1].matchAll(re)) literals.push(hit[1]);
  return literals.length > 0 ? new Set(literals) : null;
}

function findSubcommands(ctx: RuleContext): Set<string> | null {
  const local = extractSubcommands(ctx.file.content);
  if (local) return local;
  for (const meta of ctx.files.values()) {
    if (meta.relPath.includes("commands/completions.ts")) {
      const remote = extractSubcommands(meta.content);
      if (remote) return remote;
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
    if (!subcommands) return;

    for (const { name, line, col } of cases) {
      if (!subcommands.has(name)) {
        ctx.violated(line, col, `case "${name}"`);
      }
    }
  },
};

export default rule;
