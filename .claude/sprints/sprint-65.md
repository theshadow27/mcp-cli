# Sprint 65

> Planned 2026-05-26 17:55 EDT. Started 2026-05-26 15:37 EDT. Completed 2026-05-26 20:45 EDT. Target: 14 work items. Result: 14/14 merged.

## Goal

Fix the `am-i-done` compromise — ship the AST import-graph + closure-hash test
cache (the deferred half of #2396), then harden the test harness for parallel
safety (fixture teardown, orphan sweep), clean up the rule-engine follow-ups,
and clear DX papercuts. Theme: flaky tests / test harness / parallel testing /
DX.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2408 | AST import-graph + per-file closure-hash test cache for am-i-done | high | 1 | opus | goal |
| 2401 | replace ZERO_FAIL_RE prose-regex with structured bun reporter output | low | 1 | sonnet | goal |
| 2392 | detectContext: documented `MCP_CLI_AI=0` opt-out is a no-op (truthy string) | low | 1 | sonnet | filler |
| 2354 | fix(rules): remediate 3 no-error-message-sniffing suppressions | low | 1 | sonnet | goal |
| 2421 | feat: capability-flag lint rule — costTracking/compactLog without matching handler | med | 1 | opus | goal |
| 2413 | test infra: route echo-server + long-lived fixtures through spawnManaged | med | 2 | opus | goal |
| 2417 | flaky(local): validateFreeformTsc tests fail in worktree environment | med | 2 | opus | goal |
| 2420 | rule: provider spec tests must assert capability shape, not cardinality | low | 2 | sonnet | goal |
| 2316 | bug(core): extractContent / mcp-proxy ignores isError — alias scripts get errors as data | low | 2 | sonnet | filler |
| 2409 | poll-until-headroom rule: setDefaultTimeout interaction not well-documented | low | 2 | sonnet | goal |
| 2415 | test infra: pre-test orphan sweep for leaked workers and fixtures | med | 3 | opus | goal |
| 2422 | test: provider cardinality spec vs capability-shape spec — split agent-provider.spec.ts | low | 3 | sonnet | goal |
| 2419 | rule: costTracking: true on ACP provider requires acp-event-map test | low | 3 | sonnet | goal |
| 2351 | mcpctl: TUI crashes (TypeError t.type) when viewing session logs with stack-trace output | med | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate)
#2408, #2401, #2392, #2354, #2421

### Batch 2 (backfill)
#2413, #2417, #2420, #2316, #2409

### Batch 3 (backfill)
#2415, #2422, #2419, #2351

### Dependency edges (translate to `addBlockedBy` at run time)
- #2408 blockedBy #2401 (both touch `scripts/_runner/ci-steps.ts`; structured-bun-reporter cleanup precedes test-cache wiring)
- #2415 blockedBy #2408 (orphan sweep integrates with the runner where the AST cache lives)
- #2422 blockedBy #2420 (both touch `packages/acp/src/agents.spec.ts`; capability-shape assertions land before the split)
- #2419 blockedBy #2422 (acp-event-map test added inside the now-split spec)
- #2409 blockedBy #2401 (both touch `scripts/_runner/ci-steps.ts` test-output handling — #2409 is doc-only but anchors a comment near the reporter logic)

### Hot-shared files (cross-batch broadcast targets)
- `scripts/_runner/ci-steps.ts`: #2401, #2408, #2409, #2415 — second-and-later PRs must rebase + check for shared-region edits
- `packages/acp/src/agents.spec.ts`: #2420, #2422, #2419 — strict serialization required
- `packages/core/src/alias.ts` family: #2316 stands alone but watch for any worker also touching `extractContent` callers

### Nerd-snipe gate (mandatory before impl spawn)
- **#2408** (HIGH scrutiny): 200–400 LOC of new AST graph-resolver code, including specifier→path resolution (relative + `@mcp-cli/*` workspace-alias + tsconfig paths), barrel (`export *`) following, and reverse-index. Adversarial review mandatory. Investigation already documents the trade-off vs leaning entirely on `bun test --changed` — the gate should confirm we build the resolver (committing to the bonus rules upside: dead-export, find-circular-deps) rather than reverse course.
- **#2417** (worktree-only flake): env-specific. Unclear what's different about a worktree env that breaks the spawned `tsc` binary. Gate must establish mechanism (PATH? cwd? GIT_DIR leak even after sprint 64's `gitSafeEnv` fix?) before patching. Hard-fail outcome = `needs-attention`.
- **#2351** (TUI crash with minified stack from compiled binary): bug location is the Ink stack-frame parser. Gate must find the source-level component before any fix lands; "shotgun a try/catch" is the wrong answer.

## Context

**Theme genesis (user direction):** Sprint 64 closed by deferring half of #2396 —
the verdict cache shipped (PR #2406) but the AST import-graph piece was
explicitly scope-cut and refiled as #2408. The compromise: `am-i-done
--pre-push` runs `bun test --changed` only, missing tests that depend
transitively on changed source. The user's call: *"the compromise we made to
cut out most tests from am-i-done is a real problem, we know how to fix it
right."* So sprint 65's crown jewel is #2408 — build the real AST resolver +
closure-hash cache on the existing rule-engine AST layer (`scripts/rules/_engine/ast.ts`).

**Pre-paid investigation (don't re-pay):** #2408's body documents the feasibility
study from 2026-05-26 — the right shape is ~200–400 LOC on the existing AST
layer, with barrel `export *` following and tsconfig-path resolution. The
alternative ("lean on bun's `--changed`") is also documented; the nerd-snipe
gate should confirm direction before implementation, not redo the survey.

**Test-harness arc (parallel-safety follow-through):** Sprint 64 proved the
suite is 0-flake-across-22k-runs once leaked processes are gone. #2413
(spawnManaged for fixtures) + #2415 (pre-test orphan sweep) + #2417
(validateFreeformTsc worktree flake) finish what sprint 64's `--no-orphans`
push started. Goal: make parallel test runs the *default*, not a brittle
opt-in.

**Provider/lint quartet (governance):** #2419/#2420/#2421/#2422 close the
follow-ups filed during sprint 64's grok-provider adversarial review (PR
#2391). #2421 ships a new rule (independent file); #2420/#2422/#2419 chain
on `agents.spec.ts`. Together they prevent the next provider onboarding
from re-paying for the same review findings.

**DX cluster (filler):** #2392 (MCP_CLI_AI=0 truthy-string bug), #2316
(extractContent silently treats error-result as data), #2351 (mcpctl TUI
crashes on stack-trace logs) — three independent papercuts that round out
capacity without overcommitting on theme.

### Meta dispositions (Step 1a — APPLIED PRE-SPRINT)
- **#2333 — applied** in PR #2425 (auto-merged): codify Bun's
  condition-based-waiting test philosophy into `CLAUDE.md` + `test/CLAUDE.md`.
  On-theme with sprint 64's flaky-test rules.
- **#2398 — applied** in PR #2424 (auto-merged): retro guarantees the
  `.active` sentinel clear + `.git-hooks/sprint-active.sh` auto-clears a
  stale sentinel whose sprint is already squash-merged on HEAD.
- **#2350 — deferred:** `/rule-author` consolidation. Larger lift; defer
  to a dedicated skill-cleanup pass.
- **#2343 — long-tail watch:** worker `.claire` mangled-path bug. Not
  recurred since sprint 62; per user, keep open as watchpoint rather than
  close.
- **#2393 — epic, keep open:** Grok-harness-as-first-class-citizen.

### Pending board hygiene (workers can do as side-effects, otherwise retro)
- Close #2245, #2260, #2334, #2339 as dups of #2330 (sprint 64 PR #2404
  consolidated them; consolidation noted in commit message). Sprint 64
  retro already pre-classified these.
- Close #2407 as done (`case "grok":` already in `packages/command/src/main.ts:421`).
- Close #2416 as done (`describe("getProcessStartTime retry")` already in
  `packages/daemon/src/process-identity.spec.ts:67`).

### Excluded from candidacy (per Explore recon)
- **Defer:** #2210, #2313 (Bun 1.3.14 segfault/bus-error — cannot fix
  without upstream Bun patch or version bump; package.json pinned to
  >=1.3.14).
- **Defer:** #2215 (CI pty-test actions/checkout auth — orthogonal
  GitHub Actions issue).
- **Defer:** #2232, #2233, #2234 (Claude session NDJSON/stream-json
  handling — out of theme; revisit in next session-arc sprint).
- **Defer:** #2186 (phase impl in-handler auto-spawn — orchestrator infra,
  off-theme).
- **Defer:** #2423 (provider re-detect on SIGHUP — daemon refactor,
  off-theme).
- **Defer:** #1639 (event-bus-subscribers gauge testable — complementary
  but post-sprint).
- **Defer:** #1250 (sprint wind-down rebuild concurrent cross-repo —
  cross-cutting orchestrator concern, off-theme).

## Results

- **Released**: v1.12.1 (patch — internal tooling/rules/test-infra + fixes; no new top-level command)
- **PRs merged**: 14 / 14 planned (100%)
- **Issues closed**: 14 sprint issues + 5 verdict-cache duplicates consolidated to #2427 (#2428/#2432/#2434/#2442)
- **Issues dropped**: 0
- **New issues filed**: #2436 (upstream Ink ErrorOverview bug), #2438 (no-import-cycles rule, builds on #2408 graph), #2441 (mcx `pr comments resolve` GraphQL bug), #2443 (meta: search-before-filing), #2445 (verdict-cache determinism flaky), + #2408 deferred-polish follow-up (LRU eviction / graph-build benchmark)
- **Crown jewel**: #2408 AST import-graph + per-file closure-hash test cache (via `Bun.resolveSync`) — shipped after the gate's NO-GO was overturned by data (only 20% of PRs touch core; the cache wins on the ~80% leaf/narrow majority)
- **Incident (recovered)**: a #2354 session escaped its worktree into the main checkout (rebased + committed there), switching main off `main` and blocking phase commands; recovered by preserving the branch ref into a fresh worktree and restoring main. Plus an empty-`--cwd` QA mis-spawn into main checkout. Both retro items.
- **Convergence saves**: #2419 evidence-detection churned 3 text-matching precision rounds → simplified to AST-based detection (ended the treadmill)
