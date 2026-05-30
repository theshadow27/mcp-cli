# Sprint 70

> Planned 2026-05-30 08:18 EDT. Target: 13 PRs.

## Goal

Recover from sprint 69 — fix the #2597 test-infra wedge + the CI sharp edges that stopped the sprint, land the rolled Epic 2 finishers, break out Epic 3.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2597 | bun-wedge: am-i-done concurrency cap + SIGKILL-pgroup watchdog + CI timeout-minutes | high | 1 | opus | claude | P1 root |
| 2602 | stdio sessions revive as ws (the #2234 prod bug) | high | 1 | opus | claude | recover |
| 2601 | compareSemver NaN-segment guard (#2563 follow-up) | low | 1 | sonnet | claude | filler |
| 2607 | session-metrics SQLiteError test noise | low | 1 | sonnet | claude | filler |
| 2613 | am-i-done --ci misses scripts/*.spec.ts (gate gap) | medium | 2 | opus | claude | sharp edge |
| 2587 | agent-grid replay — QA-clean, worktree preserved | medium | 2 | opus | claude | recover |
| 2588 | agent-grid capability tests b1 — QA-clean, worktree preserved | medium | 2 | opus | claude | recover |
| 2592 | agent-grid per-platform archives + git-lfs CI verify | low | 2 | opus | claude | filler |
| 2606 | flaky: interrupt test pollUntil 1500ms too tight | low | 2 | opus | claude | sharp edge |
| 2605 | flaky: git-core-bare-repro timeouts under coverage | low | 3 | opus | claude | sharp edge |
| 2529 | flaky: ci-steps changed-base-ref timeout under coverage | low | 3 | opus | claude | filler |
| 2589 | agent-grid capability tests b2 | high | 3 | opus | claude | recover |
| 2616 | agent-grid replay: implement actual mock provider replay (not just static validation) | medium | 3 | opus | claude | recover |

## Batch Plan

### Batch 1 (immediate)
#2597, #2602, #2601, #2607

#2597 is the P1 root and lands first — it unwedges coverage for everyone (concurrency cap + SIGKILL-pgroup watchdog + CI `timeout-minutes`). The other three are independent of the wedge and the shared am-i-done gate, so they can run alongside without re-saturating the box.

### Batch 2 (backfill — after #2597 unwedges coverage)
#2613, #2587, #2588, #2592, #2606

#2587/#2588 are already QA-clean + `qa:pass` (PRs #2614/#2617, worktrees preserved at `claude-mpr1hd2r` / `claude-mpr2mjei`). Once coverage unwedges they need only a green run → merge — not a fresh impl.

### Batch 3 (backfill)
#2605, #2529, #2589, #2616

## Dependency edges (for run-phase `addBlockedBy`)

- #2613 blockedBy #2597 (shared `scripts/am-i-done`/check-gate files + depends on the unwedged coverage behavior)
- #2587 blockedBy #2597 (preserved worktree; needs coverage unwedged for a green run)
- #2588 blockedBy #2597 (preserved worktree; needs coverage unwedged for a green run)
- #2589 blockedBy #2588 (capability tests b2 builds on b1)
- #2616 blockedBy #2587 (replay impl builds on the replay command skeleton)
- #2606 blockedBy #2597 (load-induced flaky — verify after the concurrency cap lands)
- #2605 blockedBy #2597 (coverage-load timeout flaky — same root)
- #2529 blockedBy #2597 (coverage-load timeout flaky — same root)

Hot-shared file: #2597 and #2613 both touch `scripts/am-i-done`/`scripts/check-*` — the blockedBy edge enforces the rebase. No other shared-dispatch-file collisions among the picks.

## Symptom-cluster dedup (N reports = one fix)

#2604 (SIGKILL rotating-victim, no bun.report), #2612 (check-no-claude segfault, bun.report available), #2615 (Bun 1.3.14 SIGSEGV Linux x64, 1.37GB RSS) all share the **#2597 root**. The #2597 worker **verifies the fix resolves them and closes them as duplicates** — they are NOT separate impl slots. Do not spawn against them.

## Context

Recovery sprint after sprint 69 wedged on #2597 (bun `--test-worker` ignores `--timeout` under load → wedged workers saturated the box, load avg 48). v1.14.0 shipped at sprint-69 close; 12 PRs merged. #2587/#2588 worktrees were deliberately preserved at sprint-69 close for this recovery. #2597 lands first and isolated because it unwedges coverage for every other slot — the entire batch-2/3 fan-out depends on it. Epic 3 (#2539, nightly agent grid) is break-out only this sprint via the #2589/#2616 finishers; the broader epic stays parked. All 7 open `meta` issues (#2576, #2553, #2506, #2182, #2507, #2485, #2393) reviewed at plan time and deferred to retro.
