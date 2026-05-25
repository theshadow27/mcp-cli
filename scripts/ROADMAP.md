# am-i-done / doing-it-wrong roadmap

Status of the rule-engine migration. Phase 1 (scaffolding), Phase 2 (rule
migrations), Phase 3 (pre-commit consolidation), and Phase 4 (meta-rule
for unreferenced suppressions) are all DONE. Phase 5 (context-aware
tiering) remains untriggered.

The current shape of the gate: `bun run am-i-done --pre-commit` runs
`typecheck → lint → doing-it-wrong (full rule sweep)`; the comprehensive
form adds the parallel/control test split and the coverage ratchet. No
per-architecture standalone `check-*.ts` scripts remain — every
invariant lives under `scripts/rules/*.rule.ts` and is exercised by the
single unified sweep.

---

## Phase 1 — scaffolding ✅ DONE

**Goal.** Make it possible to *write* a rule with fixtures and *run* it
end-to-end via `bun run doing-it-wrong`. Make `bun run am-i-done` the
unified oracle, with the AI file-logger preserving orchestrator context
budget on failure.

**What landed:**

- `scripts/_runner/` — step type, context detection, console/capture/AI
  loggers, `StepRunner` with silent-first / verbose-on-failure /
  `--from N` / `--only X` semantics.
- `scripts/rules/_engine/` — `Rule` type (pattern / check kinds), file
  loader (excludes fixtures, .d.ts, node_modules, `*.rule.ts`),
  JSDoc-frontmatter fixture loader with line-preserving comment blanking,
  suppression parser (`// dotw-ignore` / `// dotw-todo #NNN`), grouped
  violation reporter, lazy AST helper (`ctx.ast`) shared across `check`
  rules.
- `scripts/am-i-done.ts` — unified oracle, two step lists (pre-commit
  subset, comprehensive). AI logger active when `CLAUDECODE` / `AGENT` /
  `MCP_CLI_AI` is set.
- `scripts/doing-it-wrong.ts` — rule entry point, also exported as a
  `ScriptFunction` so am-i-done runs it in-process.
- `scripts/rules/shell-injection.rule.ts` + 3 fixtures
  (interpolated / safe-array / suppressed). Replaced the deleted
  `scripts/check-shell-injection.ts` and its spec.

---

## Phase 2 — rule migrations ✅ DONE

Every standalone `check-*.ts` script slated for migration has been
ported to a `<id>.rule.ts` declaration plus fixtures. The scripts and
their specs are deleted; the rule sweep now covers them.

### 2a. test-timeouts → rule ✅

- `scripts/rules/test-timeouts.rule.ts` (`check` kind, `appliesToTests: true`).
- Paren-depth tracking for multi-line `setTimeout(...)` and `Bun.sleep(...)`.
- `setTimeout` delay is always the 2nd positional argument (not the last),
  so `setTimeout(fn, 50, extra)` is flagged.
- Fixtures: `flagged`, `clean`, `multi-line`, `non-test-file`.
- Standalone parity: scoped to `.spec.ts(x)` only (matching the original
  `**/*.spec.ts` glob); `.test.ts` files like `scripts/bun-segfault-repro/repro.test.ts`
  remain unscanned by this rule.
- Removed: `scripts/check-test-timeouts.ts` + `.spec.ts`.

### 2b. args-bounds → rule ✅

- `scripts/rules/args-bounds.rule.ts` (`check` kind).
- All four originally-recognised safe patterns preserved: `args[++i] ??`
  null-coalescing, truthy `args[i+1]` pre-check (6-line lookback,
  multi-line `if` blocks too), explicit bounds comparison
  (`i + 1 < args.length` and the algebraic `i < args.length - 1` /
  reversed forms), post-check on the assigned variable
  (`!val`, `val === undefined/null`, `val == null`) within 2 lines.
- Suppression: engine boundary handles `// dotw-ignore args-bounds: <reason>`.
  The legacy `// lint-allow-args-bounds: <reason>` form is inert — no
  remaining call sites in the codebase, no codemod required.
- Fixtures: `flagged`, `safe`, `suppressed`.
- Removed: `scripts/check-args-bounds.ts` + `.spec.ts`.

### 2c. session-teardown → rule ✅

- `scripts/rules/session-teardown.rule.ts` (`check` kind, scoped to
  `packages/`).
- Direct port of `ASYNC_METHOD_RE`, multi-line signature scanner (handles
  access modifiers, `Promise<{ ... }>` return types, generic angle-bracket
  depth), and `checkMethodViolation` (delete-after-await reporter).
- Fixtures: `clean`, `flagged`, `multi-line-signature`.
- Removed: `scripts/check-session-teardown.ts` + `.spec.ts`.

### 2d. phase-drift → rule ✅

- `scripts/rules/phase-drift.rule.ts` (`check` kind, file-scoped via fast
  early-return — only scans `packages/command/src/commands/phase.ts`).
- Verifies the `sub === "run"` block calls `assertNoDrift` /
  `detectDrift`; flags the block-missing and call-missing shapes.
- Fixtures: `guard-present`, `guard-missing`, `no-run-block`.
- Removed: `scripts/check-phase-drift.ts` + `.spec.ts`.

### Not migrating

- **`check-coverage.ts`** — not a per-file rule; reads coverage JSON
  and gates against thresholds. Stays a standalone Step.
- **`test-noise.ts`, `test-failures.ts`, `test-timings.ts`** — analysis
  utilities, not invariants.
- **`prepare-npm.ts`, `release.ts`, `build.ts`, etc.** — workflow
  scripts, not lints.

---

## Phase 3 — pre-commit consolidation ✅ DONE

`.git-hooks/pre-commit` now invokes `bun run am-i-done --pre-commit` as
its sole static gate (in addition to the privacy-check and
tier-classification bash prelude). The pre-commit step list in
`scripts/am-i-done.ts` covers every static check the hook previously ran
inline. Pre-push and CI use the comprehensive `am-i-done` step list via
the same entry point — local and CI share one static definition of done
(#2344).

On failure in an AI context, only the path to
`build/am-i-done-<timestamp>.txt` is surfaced — the captured output stays
out of the orchestrator's context budget. The file is deleted on
success.

---

## Phase 4 — meta-rule for unreferenced suppressions ✅ DONE

`dotw-todo-needs-issue` is registered. Scans every file for
`// dotw-todo <rule>: <text>` comments lacking `#<number>` and emits a
violation on each. Documented in `scripts/rules/README.md` alongside the
suppression syntax (see #2352).

---

## Phase 5 — context-aware tiering (only if a need emerges)

Splitting steps by execution context (`ci` / `ai` / `sh`) remains
deferred. mcp-cli currently doesn't differentiate — the AI logger
handles audience and pre-commit/pre-push provide the speed tier.

**Trigger.** Land Phase 5 only when there is a concrete step we want to
run in one audience but not another (e.g. "skip the docker-based e2e in
interactive runs"). Don't add the machinery speculatively.

---

## Anti-roadmap (things this design intentionally does NOT carry over)

- **No `import` / `fileLocation` rule kinds.** mcp-cli isn't a layered
  monorepo. Cross-layer import enforcement adds machinery for a problem
  that doesn't exist here.
- **No per-rule `ci` / `ai` / `sh` filter callbacks** on rules. The
  rule kind already says when a rule applies; audience-based filtering
  belongs at the Step level, not the Rule level.
- **No 50-file batched `Promise.all` parallelism.** mcp-cli has ~200
  source files; the current sequential scan completes in <2s. Add
  batching only when a rule is slow enough to justify the complexity.
- **No CLI subcommand for "generate a new rule scaffold".** With ~25
  rules now in place, the existing files are the template — copy and
  edit, no scaffolder required.

---

## Resolved open questions

1. **Suppression comment syntax — `// dotw-` or `// doing-it-wrong-`?**
   Settled on the short `// dotw-ignore` / `// dotw-todo` form. The
   suppression parser is a single file so the choice can still be
   revisited cheaply.

2. **Should `check` rules get a shared TypeScript AST helper?** Resolved
   (#2267). `scripts/rules/_engine/ast.ts` provides an `AstHelper`
   interface accessible as `ctx.ast` in check rules (lazy,
   WeakMap-cached per FileMeta). AST is the preferred substrate for
   structural rules.

3. **Does the file-loader need workspace metadata (e.g. `pkg`)?**
   Populated and used by rules that scope by package prefix
   (e.g. `no-manual-arg-parsing`, `session-teardown`,
   `cli-surface-registered`). Kept.
