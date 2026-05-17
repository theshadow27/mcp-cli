# am-i-done / doing-it-wrong roadmap

Status of this branch (`chore/am-i-done-mvp`) and the partitioned follow-up
work. The MVP shipped here is intentionally small — a working step runner
with an AI file-logger, a working rule engine with fixture-driven tests,
and exactly one rule (`shell-injection`) migrated end-to-end as a proof
the pattern works in mcp-cli's actual codebase shape.

Everything after Phase 1 is an independent PR. Each phase has a single
purpose, a clear "done when" criterion, and no dependency on phases
beyond its predecessor.

---

## Phase 1 (this branch) — scaffolding

**Goal.** Make it possible to *write* a rule with fixtures and *run* it
end-to-end via `bun run doing-it-wrong`. Make it possible to invoke the
full check suite via `bun run am-i-done`, with the AI file-logger
preserving orchestrator context budget on failure.

**What landed:**

- `scripts/_runner/` — step type, context detection, console/capture/AI
  loggers, `StepRunner` with silent-first / verbose-on-failure /
  `--from N` / `--only X` semantics.
- `scripts/rules/_engine/` — `Rule` type (pattern / check kinds), file
  loader (excludes fixtures, .d.ts, node_modules), JSDoc-frontmatter
  fixture loader with line-preserving comment blanking, suppression
  parser (`// dotw-ignore` / `// dotw-todo #NNN`), grouped violation
  reporter.
- `scripts/am-i-done.ts` — unified oracle, two step lists (pre-commit
  subset, comprehensive). AI logger active when `CLAUDECODE` / `AGENT` /
  `MCP_CLI_AI` is set.
- `scripts/doing-it-wrong.ts` — rule entry point, also exported as a
  `ScriptFunction` so am-i-done runs it in-process.
- `scripts/rules/shell-injection.rule.ts` + 3 fixtures
  (interpolated / safe-array / suppressed). Replaces the deleted
  `scripts/check-shell-injection.ts` and its spec.
- `scripts/tsconfig.json` — strict typecheck (`noUncheckedIndexedAccess`)
  over `_runner/`, `rules/`, and the two entry scripts.
- 18 tests across `_runner/runner.spec.ts`, `rules/_engine/suppression.spec.ts`,
  and the autoloading `rules/fixtures.spec.ts`.

**Not done in this branch (deliberate):**

- Migrating the other six `check-*.ts` scripts — each is its own PR
  (see Phase 2). Behavior is unchanged: every existing pre-commit step
  still runs, the rule engine is just a new step alongside them.
- Wiring `am-i-done --pre-commit` into the pre-commit hook. The hook
  still invokes each `bun run lint:*` / `check:*` script individually.
  Swapping it is a one-liner once Phase 2 is far enough along that
  am-i-done is the equivalent or superset.

---

## Phase 2 — rule migrations (one PR per rule)

Each migration is the same shape: take the standalone `check-*.ts`, turn
it into a `<id>.rule.ts` declaration plus fixtures, delete the script
and its spec, drop the corresponding `bun run lint:*` line from the
pre-commit hook (replaced by the rule engine running it).

Order by complexity — start with the simplest so the team confirms the
pattern before tackling AST-flavoured rules.

### 2a. test-timeouts → rule

**Why.** Simplest single-line regex. Currently 250 lines of
glob+regex+report boilerplate; should collapse to ~30.

**Done when.**
- `scripts/rules/test-timeouts.rule.ts` exists.
- `scripts/rules/fixtures/test-timeouts__*.fixture.ts` covers: fixed
  setTimeout-with-numeric-delay (positive), `await pollUntil()` (negative,
  expect 0), `Bun.sleep` exception (negative).
- `scripts/check-test-timeouts.ts` + `.spec.ts` deleted.
- `lint:timeouts` removed from `package.json` and pre-commit hook.

**Anticipated landmines.**
- The current detector tracks parenthesis depth for multi-line callbacks.
  A simple regex won't catch every form. Decide upfront: either ship as a
  `pattern` rule and accept some false negatives (and add fixtures
  covering both), or upgrade to a `check` rule that walks tokens.

### 2b. args-bounds → rule

**Why.** Already has a custom suppression syntax (`// lint-allow-args-bounds: <reason>`).
Migrating consolidates that into the standard `// dotw-ignore args-bounds: <reason>` and
gets one fewer dialect to learn.

**Done when.**
- Rule fires on `args[++i]` accesses without bounds check.
- Fixtures cover all four currently-detected safe patterns (null
  coalescing, truthy pre-check, explicit bounds, post-check on assigned
  variable) plus the suppression form.
- `scripts/check-args-bounds.ts` + `.spec.ts` deleted, `lint:args-bounds`
  unregistered, **and** a one-time codemod renames existing
  `// lint-allow-args-bounds: <reason>` comments to
  `// dotw-ignore args-bounds: <reason>` (single sed pass; commit
  separately).

**Anticipated landmines.**
- The "look at the next 2 lines for `!varName` / `=== undefined`"
  heuristic is the kind of multi-line context that a pure regex can't
  express. This wants a `check` rule with a small scanning helper, not
  a `pattern` rule.
- **Sprint guidance update.** After this lands, existing
  `// lint-allow-args-bounds: <reason>` comments that the codemod
  missed (e.g. inside string literals, in branches not yet rebased)
  will silently fail to suppress. Implementer / repairer workers
  trained on the old syntax will burn cycles. Add a one-liner to
  `run.md`: "args-bounds suppression syntax is `// dotw-ignore
  args-bounds: <reason>`; the old `// lint-allow-args-bounds` form is
  inert."

### 2c. session-teardown → rule

**Why.** Already AST-shaped (matches async method signatures, tracks
"first await"). Already has a passing spec — port the logic and reuse
the test cases as fixtures.

**Done when.**
- `scripts/rules/session-teardown.rule.ts` is a `check` rule with the
  current `ASYNC_METHOD_RE` + `SESSIONS_DELETE_RE` logic moved over.
- Fixtures recreate the scenarios from the existing spec (delete before
  await, delete after await, no delete at all).
- `scripts/check-session-teardown.ts` + `.spec.ts` deleted; `lint:teardown`
  unregistered.

### 2d. phase-drift → rule

**Why.** File-scoped (only `packages/command/src/commands/phase.ts`).
A `check` rule with a fast-path `if (file.relPath !== ...) return;`
keeps the cross-tree scan free and migrates the logic verbatim.

**Done when.**
- Rule fires if the `sub === "run"` block in phase.ts doesn't call
  `assertNoDrift` / `detectDrift`.
- Fixtures cover: drift-call present, drift-call missing,
  run-block absent (which is itself a violation — the rule needs the
  block to exist).
- `scripts/check-phase-drift.ts` + `.spec.ts` deleted; `check:phase-drift`
  unregistered.

### Not migrating

- **`check-coverage.ts`** — this isn't a per-file rule; it reads
  coverage JSON and gates against thresholds. It stays a standalone
  Step.
- **`test-noise.ts`, `test-failures.ts`, `test-timings.ts`** — analysis
  utilities, not invariants. No migration needed.
- **`prepare-npm.ts`, `release.ts`, `build.ts`, etc.** — workflow
  scripts, not lints.

---

## Phase 3 — pre-commit consolidation

**Goal.** Once 2a–2d are merged, the pre-commit hook is enumerating
half-empty: most of its steps are gone, replaced by a single
`bun run doing-it-wrong`. At that point, swap the per-step shell
chain in `.git-hooks/pre-commit` for a single
`bun run am-i-done --pre-commit`.

**Done when.**
- `.git-hooks/pre-commit` invokes `bun run am-i-done --pre-commit` and
  nothing else (other than the privacy-check and tier-classification
  bash prelude).
- The pre-commit step list in `scripts/am-i-done.ts` includes all the
  checks the hook previously ran.
- Pre-push and CI also call `bun run am-i-done --pre-push`.

**Why a separate PR.** Behavior change. The hook works today; cutting
over invites surprise if any step list disagrees with what the hook
ran. Best to land it when the lists are obviously equivalent.

**Sprint guidance update.** This is the moment workers stop seeing
stderr-with-100-lines on failure and start seeing a one-line
"full logs: build/am-i-done-<ts>.txt" pointer. Repair workers that
read only the orchestrator's truncated error will miss the actual
failure. Update `run.md` (or wherever the repair playbook lives) to
read the log file path out of the pre-commit failure and pass it to
the repair worker. Also note: the file is deleted on success, so a
later passing run won't leave a stale artifact.

---

## Phase 4 — meta-rule for unreferenced suppressions

**Goal.** Enforce the team norm "every `dotw-todo` has an issue
number" by failing the build when one doesn't. The suppression parser
already returns `todoWithoutIssue: true` for these; the meta-rule
surfaces it as a violation in its own right.

**Done when.**
- New rule `dotw-todo-needs-issue` registered. Scans every file for
  `// dotw-todo <rule>: <text>` comments lacking `#<number>`.
- Fixture covers a `dotw-todo` with `#1234` (no violation), without
  (one violation).
- Documented in `scripts/rules/README.md` (new — short, ~30 lines).

---

## Phase 5 — context-aware tiering (only if a need emerges)

One option is splitting steps by execution context (`ci` / `ai` / `sh`).
mcp-cli currently doesn't differentiate — the AI logger handles
audience, and pre-commit/pre-push already provide the speed tier.

**Trigger.** Land Phase 5 only when there is a concrete step we want
to run in one audience but not another (e.g. "skip the docker-based
e2e in interactive runs"). Don't add the machinery speculatively.

---

## Anti-roadmap (things this design intentionally does NOT carry over)

- **No `import` / `fileLocation` rule kinds.** mcp-cli isn't a layered
  monorepo. Cross-layer import enforcement adds machinery for a problem
  that doesn't exist here.
- **No per-rule `ci` / `ai` / `sh` filter callbacks** on rules. The
  rule kind already says when a rule applies; audience-based filtering
  belongs at the Step level, not the Rule level.
- **No 50-file batched `Promise.all` parallelism.** mcp-cli has ~200
  source files; the current sequential scan completes in 100ms. Add
  batching when a rule is slow enough to justify the complexity.
- **No CLI subcommand for "generate a new rule scaffold".** Three rules
  worth of repetition is the point at which a scaffolder pays for
  itself. We have one. Revisit at four.

---

## Open questions deferred to Phase 2 PRs

1. **Suppression comment syntax — `// dotw-` or `// doing-it-wrong-`?**
   This branch picked the short form to match the existing
   `// lint-allow-args-bounds` brevity. The parser is a single file so
   the choice can be revisited cheaply.

2. **Should `check` rules get a shared TypeScript AST helper?** Two of
   the four migrations (session-teardown, phase-drift) want light AST
   awareness. Three would justify a `scripts/rules/_engine/ast.ts`
   utility. Until then, each `check` rule can roll its own.

3. **Does the file-loader need workspace metadata (e.g. `pkg`)?**
   Currently populated but unused. Leave it until a rule needs
   cross-package logic, then validate the shape against real use.
