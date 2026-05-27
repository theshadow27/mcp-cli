# Sprint 66

> Planned 2026-05-26 21:00 EDT. Started 2026-05-27 10:48 EDT. Ended 2026-05-27 12:47 EDT. Target: 15 work items.

## Goal

Bugfix sweep — fix the daemon/connection races, Claude session-NDJSON parsing
gaps, and flaky-test root-causes that accumulated through sprints 64–65; follow
through on the #2408 import-graph (no-import-cycles rule); and close the
cookie-auth gap that limits many site use cases. Headlined by the silent
`.catch(() => {})` cleanup audit (#2153). Theme: correctness / reliability /
daemon hardening.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2153 | silent `.catch(() => {})` audit across daemon session workers + cleanup paths | high | 1 | opus | goal |
| 2451 | extractContent returns `[undefined]` when single text block has no text | low | 1 | sonnet | goal |
| 2441 | `mcx pr comments resolve` fails — GraphQL `pushedAt` field doesn't exist | low | 1 | sonnet | goal |
| 2232 | claude `rate_limit_event` NDJSON type unhandled → log noise every turn | low | 1 | sonnet | goal |
| 2135 | connectFn→PID race: childPid cached null when process exits during connect | med | 1 | opus | goal |
| 1595 | sites: cookie-based session auth unsupported — bearer-only captures miss many cases | high | 2 | opus | goal |
| 2233 | claude `result/error_during_execution` lacks `errors[]`, mis-parsed as empty success | med | 2 | sonnet | goal |
| 2411 | cleanStaleFiles unlinks PID file when flock is held on existing inode | low | 2 | sonnet | goal |
| 2437 | flaky: disconnect SIGTERM to stdio child times out intermittently | med | 2 | opus | goal |
| 2074 | per-action tool permission prompts despite `--allow` on spawn | med | 2 | opus | goal |
| 2438 | rule: categorically ban import cycles (no-import-cycles), built on #2408 graph | med | 3 | opus | goal |
| 2445 | flaky: computeVerdictKey determinism test shares process.cwd() with acp-session | med | 3 | opus | goal |
| 1624 | race: concurrent `mcx auth` on same server stages conflicting DCR clients | med | 3 | opus | filler |
| 2215 | ci: pty-test job fails with actions/checkout auth error on PR runs | low | 3 | sonnet | filler |
| 2436 | upstream: file Ink bug for ErrorOverview duplicate-key + incomplete parseLine guard | low | 3 | sonnet | filler |

## Batch Plan

### Batch 1 (immediate)
#2153, #2451, #2441, #2232, #2135

### Batch 2 (backfill)
#1595, #2233, #2411, #2437, #2074

### Batch 3 (backfill)
#2438, #2445, #1624, #2215, #2436

### Dependency edges (translate to `addBlockedBy` at run time)
- #2411 blockedBy #2135 (both touch daemon-lifecycle/server-pool sync; the PID-race fix is the foundation for the flock guard to be meaningful)
- #2437 blockedBy #2135 (the connectFn→PID race is the likely root of the SIGTERM-to-stdio-child flake; the nerd-snipe gate should confirm #2135 resolves it before patching the test)
- #2233 blockedBy #2232 (both touch the claude-session NDJSON/session-state parsing path; serialize to avoid a logical conflict on the message-type handling)

### Hot-shared files (cross-batch broadcast targets)
- `packages/daemon/src/server-pool.ts` + `packages/command/src/daemon-lifecycle.ts`: #2135, #2411, #2437 — serialized via edges; #2135 lands first.
- `packages/daemon/src/claude-session/` (ndjson / session-state): #2232, #2233 — serialized.
- `packages/daemon/src/*-session-worker.ts` (all 5 providers): #2153 rewrites the cleanup `.catch` across every worker — strictly serialize any other session-worker-touching PR behind it (none planned this sprint, but broadcast if one appears).

### Nerd-snipe gate (mandatory before impl spawn)
- **#2437** (flaky SIGTERM-to-stdio-child timeout): establish the mechanism before patching. Prime hypothesis: the #2135 connectFn→PID race leaves childPid null so the kill targets nothing. Gate must confirm whether #2135's fix resolves it, or whether there's an independent SIGTERM-propagation bug. Hard-fail = `needs-attention`. (#2454 was closed as a dup — same flake.)
- **#2445** (flaky verdict-cache determinism): the test shares `process.cwd()` with acp-session-worker tests that create/remove untracked files; gate must confirm the race window + the right isolation (cwd param to `computeVerdictKey`) before patching. This is a CONDITION-not-TIME-PASSING violation per `test/CLAUDE.md`.
- **#2074** (per-action permission prompts despite `--allow`): unclear mechanism — does the allow-list reach the SDK and get ignored, or is it a doc gap (which tool families don't honor `--allow`)? Gate must reproduce + trace the allow-list through to the SDK before any fix. Hard-fail = `needs-attention`.

## Context

**Theme genesis:** Sprint 65 (14/14 merged, v1.12.1) shipped the #2408 AST
import-graph cache and a test-harness parallel-safety arc, but its reviews/QA
surfaced a cluster of latent daemon/session bugs and flakies. Sprint 66 drains
that cluster plus the longest-standing daemon races (#2135, #1624, #2411).

**Headline #2153** (silent `.catch(() => {})` audit): 5 cleanup sites across
`claude/opencode/codex/acp/mock-session-worker.ts` swallow promise rejections,
so cleanup failures vanish as untraceable resource leaks. Recon confirmed it's
one uniform PR (~10–20 LOC): route the silent catches through a
`logCleanupError` helper. High scrutiny + adversarial review because it touches
every session worker's teardown path.

**#1595** (cookie-based site auth): the second heavy. Today `mcx site` captures
are bearer-token-only; cookie-session sites (a large class the user has hit
repeatedly) can't be driven. Feature-sized (~100–200 LOC across
`packages/daemon/src/site/`), auth-sensitive → high scrutiny + adversarial
review. Placed in batch 2 (not batch 1) so it doesn't share a batch with the
other heavy (#2153).

**Daemon-race trio** (#2135 → #2411 → #2437): the connectFn→PID race (#2135) is
the root — childPid cached null when the child exits during connect. The flock
guard (#2411, follow-on to sprint 64's #2410) and the SIGTERM-flake (#2437) both
depend on it landing first. Serialized.

**Session-NDJSON pair** (#2232 → #2233): both are wire-format gaps in the claude
session stream — `rate_limit_event` logs an error every turn; `error_during_execution`
mis-parses as empty success (corrupts interrupt handling). Serialized on the
shared parsing file.

**#2438** (no-import-cycles rule): follow-through on #2408's now-merged import
graph (`scripts/rules/_engine/import-graph.ts` exposes closureOf/dependentsOf
for SCC/DFS cycle detection). Free invariant — no cycles on main today, so the
rule lands clean and guards against regression. The `find-circular-deps` payoff
the #2408 gate named.

### Meta dispositions (Step 1a — APPLIED PRE-SPRINT)
- **#2443 — applied** in PR #2460 (merged): "search existing issues before
  filing" rule added to CLAUDE.md's filing contract (captures the sprint-65
  verdict-cache 6-dup sprawl).
- **#2343 — deferred** (per user): worker `.claire` mangled-path / worktree-escape
  bug. Same class as sprint 65's worker-escaped-to-main incident; revisit.
- **#2350 — deferred** (per user): `/rule-author` + harvest-rules consolidation.
- **#2393 — deferred** (per user): Grok-first-class-citizen epic.

### Excluded from candidacy
- **#2186** (phase impl auto-spawn + stale comment): touches `.claude/phases/impl.ts`
  (orchestration meta) — handle via the meta flow, not a sprint issue.
- **#1250** (wind-down rebuild breaks cross-repo sprints): touches `run.md` (meta).
- **#2210 / #2313** (Bun 1.3.14 segfault/bus-error): un-fixable without an
  upstream Bun patch or version bump. Still parked.
- **#2439** (closed-done — fixed by #2417/#2435), **#2454** (closed-dup of #2437),
  **#2447** (closed — 6th verdict-cache dup, fixed by #2401).

## Results

- **Released**: v1.12.2 (patch — features/fixes, no new top-level command or package)
- **PRs merged**: 13 (#2462 #2465 #2466 #2467 #2469 #2470 #2472 #2475 #2476 #2480 #2481 #2483 #2484)
- **Issues closed**: 15/15 — all planned. 13 via PR; **#2135** closed as already-fixed-on-main (sprint 58 PR #2165 — planner picked up a stale-open issue); **#2436** resolved by filing upstream (vadimdemedes/ink#963) — ErrorOverview bug is Ink's code, local boundary already handled by closed #2351.
- **Issues dropped**: 0
- **Nerd-snipe gates**: 3/3 passed (#2074 `--allow`-replaces-defaults, #2437 `isOurProcess` etime jitter, #2445 verdict-cache cwd race) — all produced concrete root causes + fix plans; zero needs-attention.
- **Adversarial reviews**: 4 high-scrutiny (#2153, #1595, #2074, #2438) — all Changes-Requested round 1, all converged. #1595 (CORS redesign) and #2074 (permission-resolution unification into `allow-patterns.ts`) needed holistic-refactor repairs.
- **New issues filed**: #2463 (stale transition-log poisons `mcx phase` from-detect), #2471 (`/proc` jitter-free etime source), #2482 (codex spawn RPC -32600 regression), #2485 (epic: `mcx issue` mail funnel + issue-author agent), the alias-bundle import-cycle follow-up, + ink#963 (upstream).
- **Shipped to sprint branch (lands on merge)**: `.claude/agents/issue-author.md` + the CLAUDE.md filing-rule swap (interim of #2485).
