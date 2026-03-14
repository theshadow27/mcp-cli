# Sprint 14

> Planned 2026-03-13. Target: 15 PRs.

## Goal

Automatic aliases (ephemeral alias lifecycle) + Plans tab repair + customer-reported help text

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 696 | Ephemeral aliases — auto-save long CLI calls with TTL | high | 1 | opus | goal |
| 751 | mcx claude spawn --help should show usage docs | low | 1 | opus | goal |
| 748 | Plans tab — selectedStep clamp + composite expandedPlan key + deterministic order | medium | 1 | opus | goal |
| 749 | usePlans — silent per-server failures when all plan servers unreachable | low | 1 | opus | goal |
| 697 | Auto-promote ephemeral aliases to curated based on usage patterns | high | 2 | opus | goal |
| 705 | Plans tab — advance/abort keyboard actions | medium | 2 | opus | goal |
| 706 | Plans tab — live metrics panel | medium | 2 | opus | goal |
| 707 | Plans tab — Claude Code plan integration (read-only) | medium | 2 | opus | goal |
| 750 | Parallelize test profiler in check-coverage.ts | medium | 1 | opus | filler |
| 747 | use-daemon-process-count.spec.ts sleep-based assertions (flakiness) | low | 1 | opus | filler |
| 745 | Show process holding WS port when warning displayed | low | 3 | opus | filler |
| 90 | Add --verbose and --dry-run flags for debugging | medium | 3 | opus | filler |
| 616 | Flaky: ConfigWatcher integration tests timeout | low | 3 | opus | filler |
| 492 | Investigate idle timeout test needing 15s margin | low | 3 | opus | filler |
| 619 | Flaky: stress.spec.ts concurrent auto-start | low | 3 | opus | filler |

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

Issues considered but excluded:
- #698 (shared alias registry) — depends on #696 + #697, too much for one sprint
- #718 (retry WS port) — complex, standalone spike
- #699 (auto-update) — large feature, needs design
- #519/#520 (ACP) — needs spike validation first (#518)
- #503/#505 (OpenCode) — needs spike validation first
- #704 — PR #746 open, repair via #748/#749 instead of re-implementing
