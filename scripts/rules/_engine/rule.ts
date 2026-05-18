/**
 * Rule type and dispatch for the `doing-it-wrong` engine.
 *
 * A Rule is a self-contained architectural invariant. Each rule lives in
 * its own file under `scripts/rules/<id>.rule.ts` and exports a default
 * Rule object. The registry in `scripts/rules/index.ts` collects them.
 *
 * Rule kinds:
 *
 *   - `pattern`  — regex over the file body. The simplest case; covers
 *     things like "no execSync with template interpolation".
 *   - `check`    — full programmatic access to the FileMeta (content,
 *     imports, exports). Use when a regex won't do, e.g. AST-aware checks.
 *
 * Why no `import` / `fileLocation` rule kinds (yet): mcp-cli is a flat
 * repo, not a layered monorepo, so cross-layer import rules don't apply.
 * Add them when there's a concrete invariant to enforce.
 *
 * Every rule carries human-facing guidance: what's wrong, how to fix, and
 * (optionally) a documentation pointer. The reporter groups violations by
 * rule id and emits the guidance once per group, not once per violation.
 */

import type { FileMeta } from "./file-loader";

export type Violated = (line: number, column: number, snippet: string) => void;

export interface RuleContext {
  file: FileMeta;
  /** All loaded files, keyed by absolute path. Use for cross-file checks. */
  files: Map<string, FileMeta>;
  violated: Violated;
}

interface RuleBase {
  /** Stable identifier; used in suppression comments and registry keys. */
  id: string;
  /** One-line "what's wrong" summary. Shown in the violation banner. */
  scold: string;
  /** Multi-line "how to fix" hints. Each line is bulleted in the report. */
  guidance: string[];
  /** Optional pointer to CLAUDE.md anchor, issue, or PR. */
  documentation?: string;
  /** When false, .spec.ts / .test.ts files are skipped for this rule. Default true. */
  appliesToTests?: boolean;
}

export interface PatternRule extends RuleBase {
  kind: "pattern";
  pattern: RegExp;
  /** Substrings that, when present in the matched line, exempt it. */
  except?: string[];
}

export interface CheckRule extends RuleBase {
  kind: "check";
  check: (ctx: RuleContext) => void;
}

export type Rule = PatternRule | CheckRule;

export interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  rule: Rule;
}

/**
 * Run a single rule against a single file. Suppression checks happen at
 * the boundary — rule implementations don't need to know about
 * `// dotw-ignore` / `// dotw-todo` comments.
 */
export function evaluateRule(rule: Rule, file: FileMeta, files: Map<string, FileMeta>): Omit<Violation, "rule">[] {
  if (rule.appliesToTests === false && file.isTest) return [];

  const collected: Omit<Violation, "rule">[] = [];
  const violated: Violated = (line, column, snippet) => {
    collected.push({ file: file.path, line, column, snippet });
  };

  if (rule.kind === "pattern") {
    runPatternRule(rule, file, violated);
  } else {
    rule.check({ file, files, violated });
  }
  return collected;
}

function runPatternRule(rule: PatternRule, file: FileMeta, violated: Violated): void {
  const lines = file.content.split("\n");
  // Global flag is not assumed — clone with /g semantics by iterating per-line.
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  for (const [i, line] of lines.entries()) {
    if (rule.except?.some((s) => line.includes(s))) continue;
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null = pattern.exec(line);
    while (m !== null) {
      violated(i + 1, m.index + 1, line.trim());
      if (m.index === pattern.lastIndex) pattern.lastIndex++; // zero-width safety
      m = pattern.exec(line);
    }
  }
}
