# Sprint 71

> Planned 2026-06-09 (evening EDT). Target: 15 PRs. Started 2026-06-09 23:00 EDT. Ended 2026-06-10 01:07 EDT — 15/15 merged.

## Goal

Mop up sprint 69/70 — land the rolled agent-grid finishers end-to-end, fix the re-tracking blocker that gates them, harden the review/QA verdict gate, and clear quick-win tech debt.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2463 | re-tracking inherits stale transition-log tail, blocking impl re-entry | high | 1 | opus | claude | root blocker |
| 2628 | pre-commit BSD grep breaks agent-grid commits on macOS | low | 1 | opus | claude | mopup enabler |
| 2659 | MODEL_SHORTNAMES stale (opus→4.6, no fable shortname) | low | 1 | opus | claude | filler |
| 2645 | test-timings.spec.ts leaks mkdtempSync dirs | low | 1 | claude-fable-5 | claude | filler (fable canary) |
| 2630 | pollUntil evaluates condition twice on success | low | 1 | opus | claude | filler |
| 2587 | agent-grid replay — PR #2614 qa:pass, rebase + merge | medium | 2 | opus | claude | mopup |
| 2588 | agent-grid capability tests b1 — PR #2617 qa:pass, rebase + merge | medium | 2 | opus | claude | mopup |
| 2653 | review.ts/qa.ts prEdit silently discards --add-label | low | 2 | opus | claude | review-gate |
| 2652 | security: verdict labels trusted on existence alone — self-approve | high | 2 | opus | claude | security |
| 2473 | codex waiter cleanup drift vs opencode/acp (also fixes dup #2468) | low | 2 | opus | claude | tech debt |
| 2589 | agent-grid capability tests b2 | high | 3 | opus | claude | mopup |
| 2616 | agent-grid replay: actual mock-driver replay, not static validation | medium | 3 | opus | claude | mopup |
| 2651 | security: adversarial-review prompt-injection hardening | high | 3 | opus | claude | security |
| 2522 | invert alias-bundle-core ↔ index re-export (drift hazard) | low | 3 | opus | claude | tech debt |
| 2505 | hoist duplicated git-root/PR-status/diff-stats wrappers → session-deps.ts | low | 3 | opus | claude | tech debt |

Model note: `opus` resolves to claude-opus-4-6 until #2659 merges, then claude-opus-4-8.
#2645 is a deliberate fable canary (`--model claude-fable-5`, full ID — the `fable`
shortname doesn't exist until #2659 lands): first worker-session test of Fable 5 through
the pinned claude 2.1.119 binary. If the spawn fails at the API/harness layer, file the
finding, fall back to opus, and route no further work to fable this sprint.

## Batch Plan

### Batch 1 (immediate)
#2463, #2628, #2659, #2645, #2630

#2463 is the root blocker — it (or its documented `--from` workaround) gates re-tracking
of all four rolled agent-grid issues. High scrutiny + investigations-gate treatment
(`references/investigations.md`): the transition-log mechanism needs a nerd-snipe pass
before impl. The other four are independent quick wins.

### Batch 2 (backfill)
#2587, #2588, #2653, #2652, #2473

#2587/#2588 are already qa:pass with open PRs (#2614/#2617) — the work is rebase onto
post-#2637 main, green CI, merge. Not a fresh impl; preserve the existing branches.

### Batch 3 (backfill)
#2589, #2616, #2651, #2522, #2505

## Dependency edges (→ addBlockedBy at run time)

- #2587 blockedBy #2463 (stale transition-log blocks re-tracking; workaround = explicit --from)
- #2588 blockedBy #2463 (same)
- #2589 blockedBy #2588 (capability tests b2 builds on b1)
- #2616 blockedBy #2587 (mock-driver replay builds on the replay command)
- #2652 blockedBy #2653 (shared review.ts/qa.ts prEdit paths)
- #2651 blockedBy #2652 (review-gate hardening serialized across review-fn.ts/qa-fn.ts)
- Fillers #2628, #2659, #2645, #2630, #2473, #2522, #2505 have no blockers.

## Hot-shared notes

- `.claude/phases/review.ts` / `qa.ts` / `review-fn.ts` / `qa-fn.ts` — #2653 → #2652 →
  #2651 all touch the verdict-label paths; the blockedBy chain enforces serialization.
- `agent-grid/src/` — #2587/#2588/#2589/#2616 all land here; the dependency chain
  serializes the colliding pairs. #2628 unblocks agent-grid commits on macOS.
- `packages/core/src/model.ts` + `packages/command/src/commands/spawn-args.ts` — #2659
  only; several spec files pin model IDs, worker must sweep assertions.

## Closed at plan time (board hygiene)

- #2633 — moot: the band-aids it tracked were reverted in #2637.
- #2529 — already fixed by #2464 / PR #2532 (merged before the issue was filed).
- #2640 — already fixed: `agent-grid/src` is in scripts/check-coverage.ts:221.
- #2468 — left open; duplicate of #2473, worker closes both with one PR.

## Excluded / deferred

Recon (Explore digest) deferred: #2648, #2650, #2654, #2655, #2656, #2657, #2658 (P2
robustness/arch — review-gate follow-ups land after the #2651/#2652/#2653 chain),
#2501/#2502 (perf batch), #2503/#2504 (coverage/StateDb refactors), #2562 (state-machine
correctness, pairs with future stdio work), #2471 (proc start-time source), #2647
(ctx.git feature). Meta issues reviewed with user: #2622 relabeled as sprint-eligible
rules work (next sprint candidate); #2576, #2553, #2507, #2506, #2485, #2393, #2182
deferred to retro.

## Results

- **Released**: v1.14.1
- **PRs merged**: 15/15 planned (#2663, #2668, #2672, #2671, #2674, #2676, #2677,
  #2614, #2617, #2675, #2678, #2689, #2694, #2691, #2695) — first sprint at 100%
  of a 15-PR target
- **Issues closed**: 16 by PR (15 planned + dup #2468), plus 3 board-hygiene
  closures at plan time (#2633, #2529, #2640)
- **Issues dropped**: 0
- **New issues filed**: 17 (#2665 model routing on work items, #2666 pre-push
  empty-stdin, #2670 hook test gap, #2673 worktree lock resolution, #2679
  stale-base worktree forks, #2680 replay cancellation follow-up, #2681
  per-spawn binary/transport override, #2682 phase_state_set ACL, #2683 NaN
  guard rule, #2684 E2E transition-error tests, #2685 atomic prune rewrite,
  #2688 stdio dogfooding canary, #2690 host oversubscription, #2692 done-fn
  stub drift, #2693 worktree containment escape, #2696 env-inherit rule,
  #2698 QA-must-not-push) + data-point comments on #2656, #2648
- **Wall clock**: 2h07m (23:00–01:07 EDT), ~$95 total session cost, quota
  peaked ~7%
- **Notable**: stdio-transport dogfooding gap discovered (sprint runs pinned
  .119/ws; #2688 canaries it next sprint); fable-5 worker canary (#2645)
  passed end-to-end; verdict-gate security chain (#2653→#2652→#2651) fully
  landed; zero opus repair spawns — all repairs were reviewer micro-repairs
  with independent fresh-eyes verification

## Context

Sprint 70 recovered from the 69/70 test-infra collapse (#2637 reverted the killer
cascade; main is clean, coverage ~45s). Three qa:pass PRs were deferred at sprint-70
close pending rebase onto cleaned main; #2625 merged post-sprint, #2614/#2617 remain
open and are this sprint's batch-2 fast lane. The June issue tail (#2645–#2659) came
from the #2641 investigation and the #2575/#2649 security review; #2575's fix surfaced
the #2651/#2652/#2653 trust-boundary cluster this sprint addresses. First sprint planned
under Fable 5 as orchestrator; #2659 + the #2645 canary are the model-routing follow-ups
from that switch (see also #2660, deferred).
