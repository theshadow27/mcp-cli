# Sprint 56

> Planned 2026-05-19 00:47 local. Started 2026-05-19 02:13 local. Finished 2026-05-19 03:31 local. Target: 16 issues, mostly small/medium DX picks (no high-scrutiny heavies). **All 16 shipped (3 drive-by closures + 13 PR merges in ~78 min).**

## Goal

Orchestrator UX hardening: clear the sprint-55 fallout, fix the `mcx claude resume`/`ls` papercuts that block the orchestrator's own recovery + pre-flight, and land monitor consistency + lint/test/docs fillers that have been sitting.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2091 | chore(mcx): auto-prune mcx-tracked entries when phase=done | low | 1 | sonnet | goal-quick |
| 2090 | polish: 3 post-merge nits on #2086 manifest version check | low | 1 | sonnet | goal-quick |
| 2089 | docs/types: AliasContext stubs missing cache/repoRoot/signal; EventFilterSpec.subscribe MonitorCategory[] | medium | 1 | sonnet | goal |
| 2088 | docs: add waitForEvent to ambient mcp-cli.d.ts template in docs/phases.md | low | 1 | sonnet | goal-quick |
| 2025 | bug(claude-ls): `mcx claude ls --all --short` hangs on empty result set | low | 1 | sonnet | goal (orch pre-flight) |
| 2082 | bug(mcx claude resume): blocks recovery of review/QA worktrees because their branch is 'already merged' | medium | 2 | opus | goal (orch recovery; needs design choice between 3 fallbacks) |
| 1325 | perf(aliases): findGitRoot spawns 3 git subprocesses on every alias invocation | medium | 2 | sonnet | goal |
| 2017 | docs/phases.md: clarify that 'mcp-cli' is a virtual package (not npm-installable) | low | 2 | sonnet | filler |
| 2040 | test: cover orphan-reaper and claude-server null-ownership paths from #1980 fix | low | 2 | sonnet | filler |
| 1787 | monitor: gap control message should include `ts` field for consistency with MonitorEvent | low | 2 | sonnet | filler (monitor) |
| 1791 | perf(monitor): add rate-limit warning log to repo-scoped CopilotPoller inline fetch path | low | 2 | sonnet | filler (monitor) |
| 1792 | refactor(db): normalize `last_poll_ts` format for sentinel row in `copilot_comment_state` | low | 2 | sonnet | filler (monitor) |
| 1361 | fix(manifest): JSDoc comment for findManifest says "Does not stat" but uses lstatSync | low | 3 | sonnet | filler (trivial) |
| 1673 | lint: extend check-test-timeouts.ts to flag Bun.sleep in test files | low | 3 | sonnet | filler |
| 1707 | feat(sites): log lock-contention warnings when browser operations queue unexpectedly | low | 3 | sonnet | filler |
| 1806 | ci: skip Copilot review + CI on docs-only branches (meta/*, sprint-*, release/*) | medium | 3 | sonnet | filler (needs design call on repo-ruleset vs account-setting precedence) |

## Dependency edges (translate to `addBlockedBy` at run time)

- #2088 blockedBy #2089 (#2089 lands the new AliasContext stubs; #2088 documents them in the ambient template — must land in this order to avoid drift)
- #2082 blockedBy #2025 (both touch `packages/command/src/commands/claude.ts`; #2025 is a small flush/empty-set fix, #2082 is the bigger recovery-path change — sequence to avoid logical conflict on the same file)

All other picks are independent — no shared-file serializations beyond the two above.

## Batch Plan

### Batch 1 (immediate — sprint-55 fallout + smallest orch wins)
#2091, #2090, #2089, #2088, #2025

### Batch 2 (backfill — medium picks + monitor consistency)
#2082, #1325, #2017, #2040, #1787, #1791, #1792

### Batch 3 (backfill — remaining fillers)
#1361, #1673, #1707, #1806

## Hot-shared file watch

- `packages/command/src/commands/claude.ts` — #2025 lands first, #2082 rebases on top. Orchestrator must broadcast targeted rebase on #2082 worker when #2025 merges (and remind it to check for duplicate dispatch entries).
- `packages/core/src/manifest.ts` — only #2090 (small polish) touches it this sprint. No serialization required.
- AliasContext / docs/phases.md — #2089 (stubs) and #2088 (docs) are sequenced via `addBlockedBy`; same content, different files (alias-bundle.ts + typegen.ts vs docs/phases.md), so the conflict is logical not textual.

## Drive-by closures already detected

The following were flagged as sprint-56 candidates but verification shows they're already closed — no action needed:

- #2058 (flaky 3 tests during #2050 QA — closed after Bun 1.3.14 bump)
- #2034 (flaky server-pool disconnect SIGTERM — fixed by #2041)
- #2042 (mcx gc `+` prefix parsing — closed in sprint 55)
- #2025 (claude ls --all --short empty hang — closed 2026-05-18 via PR #2050; planner missed it)
- #2040 (orphan-reaper/null-ownership coverage — closed 2026-05-18 via PR #2048; planner missed it)
- #2017 (mcp-cli virtual package docs — closed 2026-05-18 via PR #2045; planner missed it)

These three were detected at run-start by `mcx phase run impl` returning
"work item not found" / state "done". The plan listed them because the
planner ran ~24h earlier than the run-start and didn't re-verify GitHub
state immediately before execution. Sprint scope is therefore 13 issues
(not 16). Removed from active list; #2082 is now unblocked (#2025 dep
already satisfied).

## Excluded (and why)

- **#2023** (ctx.gh first-class GitHub API) — heavy 4-6h Opus-scrutiny feature with cascading downstream (#1912, #1964 blocked on it). User chose orchestrator-UX-hardening framing over ctx.gh foundation. Defer to sprint 57.
- **#1912** (mcx pr command) — heavy IPC + cache-invalidation work; benefits massively from #2023 landing first. Defer to sprint 57.
- **#2092** (macOS support window + CI matrix) — `meta` label removed and deferred to sprint 57. Deliverables are README + new CI workflow + optional daemon preflight; not a meta-fix.
- **#2083** (flaky alias-bundle-tsc.spec.ts) — off critical path; pair with a future test-perf bundle (#2012).
- **#2012** (inject clock into StuckDetector) — structural improvement worth deferring; saves <500ms off critical path.
- **#1964** (perf: daemon cache for ctx.gh) — blocked on #2023.
- **#1945** (mcx memory audit) — low priority; retro improvement, not sprint-critical.
- **#1750** (mcx claude bye flip default to keep) — `[BLOCKED on #1748 + #1749]` per title.
- **#2074** (bug(spawn): per-action permission prompts) — labeled `needs-clarification`; skip per Rule 1.

## Context

Sprint 55 just shipped (commit 91ccfbf): automation framework refactor, manifest hardening + version-check, mail-wait recovery, merge module groundwork. Several follow-ups surfaced — type stubs that #2085 added but only partially documented (#2088, #2089), polish nits on the manifest version check (#2090), and one mcx-tracked papercut where merged work items linger (#2091). Two orchestrator-internal bugs (#2025, #2082) keep biting in pre-flight and OOM recovery. Sprint 56 is intentionally heavy-free so we can land the polish stack quickly and clear runway for ctx.gh + monitor work in sprint 57.
