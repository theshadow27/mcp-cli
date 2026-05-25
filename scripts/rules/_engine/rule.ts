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

import type { AstHelper } from "./ast";
import { createAstHelper } from "./ast";
import type { FileMeta } from "./file-loader";

export type Violated = (line: number, column: number, snippet: string) => void;

export interface RuleContext {
  file: FileMeta;
  /** All loaded files, keyed by absolute path. Use for cross-file checks. */
  files: Map<string, FileMeta>;
  violated: Violated;
  /**
   * Signal that the rule performed real inspection work on this file (not
   * an early return). Engine uses this to detect silent-pass regressions —
   * a rule that runs over N files but never reports any inspection becomes
   * a debug-level warning. Safe to call multiple times per file.
   */
  checked: () => void;
  /** Lazy-parsed TypeScript AST. Only parsed on first access. */
  readonly ast: AstHelper;
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
  /**
   * Controls whether the engine runs this rule against test files.
   * - `false` → skip .spec.ts / .test.ts files (rule only runs on production code).
   * - `true`  → skip non-test files (rule only runs on test code).
   * - omitted → run on all files (default).
   */
  appliesToTests?: boolean;
  /**
   * Repo-relative paths that MUST be present in the loaded file set for
   * this rule to function. The engine validates these BEFORE invoking
   * check() and hard-errors with `MissingAnchorError` if any are absent.
   *
   * Use for cross-file rules whose check() peers at a sibling file (e.g.
   * `cli-surface-registered` cross-references `main.ts` and
   * `completions.ts`). Without this declaration, a rename or path
   * narrowing (via --filter) would silently no-op the rule and produce a
   * false-confidence pass. See issue #2315.
   */
  anchors?: readonly string[];
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
 * Hard error raised when a rule declares `anchors` that are absent from
 * the loaded file set. Surfaces as a fatal engine failure so a rename or
 * filter that hides an anchor turns into a CI red light, not a silent
 * pass. See issue #2315.
 */
export class MissingAnchorError extends Error {
  constructor(
    public readonly ruleId: string,
    public readonly missing: readonly string[],
  ) {
    super(
      `rule '${ruleId}' declares anchor file(s) not present in the loaded set: ${missing.join(", ")}. The rule cannot run without these files — it would silently pass and produce a false-confidence success. Fix: if the anchor file was renamed/moved, update the rule's anchors list; if running with --filter, broaden the filter to include the anchor; if the anchor was deleted, remove or rewrite the rule.`,
    );
    this.name = "MissingAnchorError";
  }
}

/**
 * Validate that every anchor declared by `rule` is present in `files`.
 * Throws `MissingAnchorError` on the first rule with missing anchors.
 * Intended for use by `runRules` before the per-file evaluation loop.
 */
export function validateAnchors(rule: Rule, files: Map<string, FileMeta>): void {
  if (!rule.anchors || rule.anchors.length === 0) return;
  const present = new Set<string>();
  for (const f of files.values()) present.add(f.relPath);
  const missing = rule.anchors.filter((a) => !present.has(a));
  if (missing.length > 0) throw new MissingAnchorError(rule.id, missing);
}

export interface EvaluateOptions {
  /**
   * Invoked when the rule signals (via `ctx.checked()`) that it performed
   * real inspection work on `file`. Used by the runner to track silent-pass
   * regressions across all files for a given rule.
   */
  onChecked?: () => void;
}

/**
 * Run a single rule against a single file. Suppression checks happen at
 * the boundary — rule implementations don't need to know about
 * `// dotw-ignore` / `// dotw-todo` comments.
 *
 * Note: anchor validation is NOT performed here — it's a `runRules`-level
 * concern so that unit tests can exercise `check()` with a partial file
 * set without tripping the hard error.
 */
export function evaluateRule(
  rule: Rule,
  file: FileMeta,
  files: Map<string, FileMeta>,
  opts: EvaluateOptions = {},
): Omit<Violation, "rule">[] {
  if (rule.appliesToTests === false && file.isTest) return [];
  if (rule.appliesToTests === true && !file.isTest) return [];

  const collected: Omit<Violation, "rule">[] = [];
  const violated: Violated = (line, column, snippet) => {
    collected.push({ file: file.path, line, column, snippet });
  };
  const checked = () => opts.onChecked?.();

  if (rule.kind === "pattern") {
    // Pattern rules always scan — count as inspection work unconditionally.
    checked();
    runPatternRule(rule, file, violated);
  } else {
    let cachedAst: AstHelper | undefined;
    rule.check({
      file,
      files,
      violated,
      checked,
      get ast(): AstHelper {
        cachedAst ??= createAstHelper(file);
        return cachedAst;
      },
    });
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
