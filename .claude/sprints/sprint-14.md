# Sprint 14

> Planned 2026-03-13, revised 2026-03-16. Target: 14 PRs.

## Goal

P1 serve bug fix + Plans tab repair + customer help text + DX polish

(Original plan included automatic aliases #696/#697 — deferred mid-sprint to prioritize P1 #754 serve bug.)

## Issues

| # | Title | Scrutiny | Batch | Model | Result |
|---|-------|----------|-------|-------|--------|
| **754** | **bug(serve): mcx serve never responds to initialize** | **high** | **1** | **opus** | **merged PR #760** |
| 751 | mcx claude spawn --help should show usage docs | low | 1 | opus | merged PR #757 |
| 748 | Plans tab — selectedStep clamp + composite expandedPlan key + deterministic order | high | 1 | opus | merged PR #758 |
| 749 | usePlans — silent per-server failures when all plan servers unreachable | low | 1 | opus | merged PR #755 |
| 750 | Parallelize test profiler in check-coverage.ts | low | 1 | opus | merged PR #756 |
| 747 | use-daemon-process-count.spec.ts sleep-based assertions (flakiness) | low | 1 | opus | merged PR #759 |
| 705 | Plans tab — advance/abort keyboard actions | high | 2 | opus | merged PR #770 |
| 706 | Plans tab — live metrics panel | high | 2 | opus | merged PR #771 |
| 707 | Plans tab — Claude Code plan integration (read-only) | high | 2 | opus | merged PR #773 |
| 745 | Show process holding WS port when warning displayed | low | 3 | opus | merged PR #768 |
| 90 | Add --verbose and --dry-run flags for debugging | high | 3 | opus | merged PR #769 |
| 616 | Flaky: ConfigWatcher integration tests timeout | low | 3 | opus | merged PR #767 |
| 492 | Investigate idle timeout test needing 15s margin | low | 3 | opus | merged PR #772 |
| 619 | Flaky: stress.spec.ts concurrent auto-start | low | 3 | opus | merged PR #774 |

## Batch Plan

### Batch 1 (aliases foundation + quick wins + plans repair)
#696, #751, #748, #749, #750, #747

#696 is the big one — ephemeral alias infrastructure (TTL column, auto-save, cleanup sweep). #751 is the customer issue (help text). #748 and #749 are plans tab fixes from adversarial review — must land before batch 2 plans work. #750 and #747 are quick DX wins.

### Batch 2 (auto-promote + remaining plans tab features)
#697, #705, #706, #707

#697 depends on #696 (ephemeral aliases must exist first). #705/#706/#707 depend on #748/#749 (plans tab repairs). All independent of each other within their dependency groups.

### Batch 3 (filler — DX polish + flaky tests)
#745, #90, #616, #492, #619

All independent. Backfill as batch 1/2 slots free.

## Context

Sprint 13 merged 12 issues and released v0.6.0. Plans tab UI (#704) PR #746 is open but needs repair from adversarial review (#748, #749). The remaining plans tab features (#705, #706, #707) were blocked on #704 and carry forward.

The user wants automatic aliases as the primary goal. #696 (ephemeral) and #697 (auto-promote) form a two-issue arc — #696 adds the infrastructure, #697 adds intelligence. Both are well-specified with clear implementation paths (TTL column, usage tracking, promotion CLI).

#751 is a customer-filed issue about missing help text — prioritized as a quick win in batch 1.

Issues deferred:
- #696/#697 (automatic aliases) — deferred to prioritize P1 #754
- #698 (shared alias registry) — depends on #696 + #697
- #718 (retry WS port) — complex, standalone spike
- #699 (auto-update) — large feature, needs design

## Results

- **Released**: v0.6.1 (pending)
- **PRs merged**: 14
- **Issues closed**: 14
- **Issues dropped**: 2 (#696, #697 — deferred, not dropped)
- **Issues added**: 1 (#754 — customer P1 pulled in mid-sprint)
- **New issues filed**: 12+ (from adversarial reviews)
- **Adversarial reviews**: 8 (across #754, #748, #705, #706, #707, #90)
- **Note**: PR #746 (plans tab foundation) still merging to main — #748 and #705 landed on feature branch
