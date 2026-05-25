# The rule engine (for replication / bootstrapping a new repo)

This describes the `doing-it-wrong` engine in enough detail to recreate it, or — faster — to copy the source files and wire them up. The engine is small, dependency-light (TypeScript + Bun's `Glob`), and deliberately flat: it suits a single-package or shallow-monorepo repo, not a deeply layered one.

## Layout

```
scripts/
  doing-it-wrong.ts        entry: runs rules, flags, exit code
  am-i-done.ts             orchestrator: runs the rule sweep + other checks as Steps
  rules/
    index.ts               re-exports loadAllRules + findRule (no manual registry)
    <id>.rule.ts           one rule per file, default export
    fixtures/
      <id>__<scenario>.fixture.ts
    fixtures.spec.ts       autoloads fixtures, asserts every rule has ≥1 + counts match
    _engine/
      rule.ts              Rule types (pattern | check) + evaluateRule dispatch
      rule-loader.ts       globs *.rule.ts, validates, sorts by id, dedupes ids
      file-loader.ts       FileMeta + tree scan (what's in/out of scope)
      ast.ts               lazy WeakMap-cached SourceFile + AstHelper
      suppression.ts       // dotw-ignore / // dotw-todo parsing
      fixture-loader.ts    fixture frontmatter + JSDoc blanking
      reporter.ts          grouped, capped, grep-friendly output
```

## Components

- **`rule.ts`** — defines `Rule = PatternRule | CheckRule` (see `new-rule.md` §1 for fields) and `evaluateRule(rule, file, files, opts?)`, which dispatches by kind and returns raw violations. Suppression is applied *outside* `evaluateRule` (at the runner boundary), so rule authors never deal with comments. The AST is exposed through a lazy getter — `createAstHelper(file)` is only called on first `ctx.ast` access. Also exports `validateAnchors(rule, files)` and `MissingAnchorError` — cross-file rules declare `anchors: string[]` (repo-relative paths) and the engine hard-errors via `MissingAnchorError` before any per-file check runs if an anchor is absent. `RuleContext.checked()` lets a check signal real inspection work; the runner uses it to detect silent-pass regressions (see #2315).

- **`rule-loader.ts`** — `loadAllRules(dir)` globs `*.rule.ts`, dynamically imports each, validates the default export (`id` + valid `kind` + `pattern`/`check` present), sorts by `id` (stable report order independent of glob order), and throws on duplicate ids. No hand-maintained registry — adding a file is adding a rule.

- **`file-loader.ts`** — `loadFiles({ repoRoot, roots?, filter? })` scans `packages/`, `scripts/`, `test/` (override via `roots`) for `**/*.{ts,tsx}`, returning `Map<absPath, FileMeta>` where `FileMeta = { path, relPath, content, pkg, isTest }`. **Excludes** `.d.ts`, `node_modules`, anything under `rules/fixtures/` or `*.fixture.ts(x)`, and `*.rule.ts(x)` (so rules never flag themselves — engine internals under `_engine/` stay in scope as ordinary product code). `filter` is a path substring (powers `--filter`).

- **`ast.ts`** — `AstHelper` over a `ts.SourceFile` cached per `FileMeta` in a `WeakMap`. Methods: `sourceFile`, `find(guard)`, `findByKind(kind)`, `callsTo(name)`, `positionOf(node)`, `stringLiterals(node)`. Pure `typescript`; no type-checker/program, so it's fast and needs no tsconfig resolution.

- **`suppression.ts`** — `checkSuppression(content, lineNo, ruleId)` parses `// dotw-ignore <id>: <reason>` (permanent) and `// dotw-todo <id>: <desc> #NNN` (temporary, issue ref required). A suppression applies to its own line **and** the next non-empty line (covers comment-above and trailing-comment styles). Returns `{ suppressed, todoWithoutIssue, kind }`; a `dotw-todo` missing `#NNN` is surfaced as malformed (a future meta-rule promotes it to a hard error).

- **`fixture-loader.ts`** — parses the `@rule`/`@expect`/`@path` JSDoc frontmatter, enforces filename-prefix == `@rule`, and blanks all JSDoc blocks to whitespace (line-preserving) so prose never triggers pattern rules and reported lines align. Produces a `FileMeta` shaped exactly like the production loader.

- **`reporter.ts`** — `reportViolations(violations, { logger, showAll, perRuleLimit=5 })`. Groups by rule id; prints a banner (`━━━ rule: <id> ━━━`), the `scold` with a count, up to `perRuleLimit` `file:line:column` + snippet lines (grep-friendly), then the `guidance` bullets once and the `documentation` pointer. `✨ no rule violations` when clean.

## Entry points

- **`doing-it-wrong.ts`** — `runRules({ ruleId?, filter?, showAll? }, logger)` loads rules + files, validates declared anchors (hard-error on any missing — see #2315), evaluates each rule over each file (rules iterated outer so report order is registration order), tracks per-rule `ctx.checked()` counts (a rule that ran on >0 applicable files but signalled zero inspection is logged at debug as `silent-pass`), applies suppression, and returns `{ violations, malformedTodos, unknownRule, ruleCount, durationMs, silentPassRules, missingAnchors }`. CLI flags: `--rule <id>`, `--filter <substr>`, `--all` (no per-rule cap), `--list`. **Exit code 1 on any violation, unknown rule, or missing anchor** — the gate's source of truth. Also exported as a `ScriptFunction` (`doingItWrongStep`) so the orchestrator runs it in-process without a second Bun startup.

- **`am-i-done.ts`** — the orchestrator. Declares each check as a `Step` (name, description, command — a shell string or an in-process function) and runs them with silent-first / verbose-on-failure semantics, `--from N`, `--only NAME`. Two step lists: `--pre-commit` (fast static subset: typecheck, lint, the rule sweep, any other static checks) and the comprehensive default (adds test + coverage). In an AI context (`CLAUDECODE`/`AGENT`/`MCP_CLI_AI`) it captures output to a file and surfaces only the path on failure, to protect an orchestrator's context budget.

## Wiring — the load-bearing step

**The engine does nothing unless the gate runs it.** This is the single most important lesson (mcp-cli #2344): sprint 62 shipped rules with green fixtures, but the sweep ran in neither pre-commit nor CI, so violations piled up invisibly and the rules were inert.

Wire `am-i-done --pre-commit` into **both**:
- the **pre-commit hook** (fast local feedback), and
- **CI** (the unforgettable backstop — a red PR can't merge; the hook is bypassable via `--no-verify`, web edits, force-push).

Run the **identical** command in both so local and CI share one definition of done — a violation then fails in seconds locally, never for the first time in CI. Keep heavyweight, environment-specific steps (test splitting, coverage with crash-retries, build/smoke) on their own CI jobs; route only the static gate through `am-i-done --pre-commit` unless/until those are folded in too.

## Bootstrapping a new repo

1. Copy `scripts/rules/_engine/`, `scripts/doing-it-wrong.ts`, and (recommended) `scripts/am-i-done.ts` with its `_runner/`.
2. Adjust `file-loader.ts` `roots` to the new repo's source layout.
3. Add `package.json` scripts: `"doing-it-wrong"` and `"am-i-done"` (one entry total — not one per rule).
4. Wire `am-i-done --pre-commit` into the pre-commit hook and CI (see above).
5. Write the first rule + a minimal fixture pair (`new-rule.md`), confirm `bun test scripts/rules` and `bun run doing-it-wrong` (exit 0) pass.
6. Seed real rules from `harvest-rules` findings rather than inventing invariants speculatively.
