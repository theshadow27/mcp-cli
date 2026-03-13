# Sprint 13

> Planned 2026-03-12. Target: 15 PRs.

## Goal

Plans tab UI (epic #700 sprint 2) + daemon observability polish + flaky test cleanup

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 704 | Plans tab — plan list + step pipeline visualization | high | 1 | opus | goal |
| 721 | PlanStatus/PlanCapability z.enum breaks forward compat | low | 1 | opus | goal |
| 722 | ListPlansResult needs pagination params | low | 1 | opus | goal |
| 705 | Plans tab — advance/abort keyboard actions | medium | 2 | opus | goal |
| 706 | Plans tab — live metrics panel | medium | 2 | opus | goal |
| 707 | Plans tab — Claude Code plan integration | medium | 2 | opus | goal |
| 715 | uptime counter excessive decimal precision | low | 1 | opus | filler |
| 720 | no way to collapse expanded session in Claude tab | low | 1 | opus | filler |
| 732 | use ALIAS_SERVER_NAME constant in spec | low | 1 | opus | filler |
| 679 | keep_alive messages stored in transcript (regression) | low | 3 | opus | filler |
| 713 | shutdown should require --force with active sessions | medium | 3 | opus | filler |
| 716 | display duplicate daemon process count as alert | low | 3 | opus | filler |
| 717 | warn when WS port falls back to random | low | 3 | opus | filler |
| 688 | flaky: ConfigWatcher sequential changes timeout | low | 3 | opus | filler |
| 658 | flaky: shutdown stops IPC server ECONNRESET | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (Plans foundation fixes + quick wins)
#704, #721, #722, #715, #720, #732

#704 is the big one (plan list UI). #721 and #722 are small fixes to plan types from sprint 12 reviews — land before #704 to avoid rework. #715, #720, #732 are quick wins to fill slots.

### Batch 2 (Plans tab features — depend on #704)
#705, #706, #707

All depend on #704 (plan list UI). Spawn as #704 merges. Independent of each other.

### Batch 3 (daemon polish + flaky tests)
#679, #713, #716, #717, #688, #658

All independent. Backfill as batch 1/2 slots free.

## Context

Sprint 12 landed the Plans tab foundation: protocol types (#701), server auto-detection (#702), and data hooks (#703). This sprint builds the actual UI — plan list with step pipeline visualization (#704), keyboard actions (#705), live metrics (#706), and Claude Code integration (#707).

Filler issues focus on daemon observability: uptime display (#715), session collapse (#720), duplicate daemon alerts (#716), WS port warnings (#717), and shutdown safety (#713). Two flaky tests (#688, #658) have been open since sprint 10-11.

Issues considered but excluded:
- #718 (retry well-known WS port) — complex migration logic, better as standalone spike
- #719 (dynamic WS listener) — question/discussion, not actionable yet
- #690 (test suite <25s) — ongoing perf work, not sprint-sized
- #616, #619 (more flaky tests) — #688 and #658 cover the worst offenders

## Results

- **Released**: v0.6.0
- **PRs merged**: 11 (#734, #735, #736, #737, #738, #739, #740, #741, #743, #744 + #742 inline fix)
- **Issues closed**: 12 (#679, #658, #688, #704-impl, #713, #715, #716, #717, #720, #721, #722, #732, #742)
- **Issues dropped**: 3 (#705, #706, #707 — blocked on #704 merge; #704 PR open, needs repair from adversarial review)
- **New issues filed**: 4 (#747 sleep-based test assertions, #748 plans tab clamp/key/order, #749 usePlans silent failures, #750 parallel test profiler)
- **Sprint cost**: ~$20 in mcx sessions (11 opus implementations, 8 sonnet QA/reviews)
- **Duration**: ~30 minutes wall clock

### Notes
- #679 was already fixed (closed without PR)
- #704 PR #746 open but not merged — adversarial review found issues (#748, #749), needs opus repair
- #713 required adversarial review → 2 P0 bugs found and fixed before merge
- #742 fixed inline by orchestrator (watcher spec refactor: 31→14 tests, 10s→324ms)
- Batch 2 (#705, #706, #707) never started — all depend on #704 which completed late
- Release thresholds updated: major=breaking top-level command, minor=new command/package, patch=everything else
