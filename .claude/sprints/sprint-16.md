# Sprint 16

> Planned 2026-03-17 20:15. Started 2026-03-18 00:05. Completed 2026-03-18 02:10. Result: 15/15 merged.

## Goal

Test infrastructure hardening + serve DX + alias auto-promote

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **812** | **Replace per-file test time budget with hash-based timing cache** | **high** | **1** | **opus** | **goal** |
| **811** | **Server-side jq filtering for mcx serve** | **medium** | **1** | **opus** | **goal** |
| 697 | Auto-promote ephemeral aliases based on usage patterns | high | 1 | opus | goal |
| 807 | flaky: orphan-reaper preserves alive process assertion | low | 1 | opus | goal |
| 792 | Replace bare setTimeout in use-plans.spec.ts | low | 1 | opus | goal |
| 765 | SIGTERM/SIGINT handler in cmdServe | low | 2 | opus | goal |
| 766 | Detect TTY stdin in mcx serve | low | 2 | opus | goal |
| 809 | flaky: daemon-integration beforeEach/afterEach hook timeout | medium | 2 | opus | goal |
| 808 | flaky: ipc-server shutdown test timeout | medium | 2 | opus | goal |
| 796 | Automated tests for pre-commit hook file classification | low | 2 | opus | goal |
| 785 | Replace N+1 transcript IPC with daemon-side claude_plans | high | 3 | opus | goal |
| 786 | Zod validation for claude_transcript response | low | 3 | opus | goal |
| 781 | Extract shared getTargetPlan helper | low | 3 | opus | filler |
| 777 | Plans list poll interval too slow (30s → 5s) | low | 3 | opus | filler |
| 718 | Periodically retry claiming well-known WS port | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (P1 test infra + customer issue + deferred alias)
#812, #811, #697, #807, #792

#812 ships first — the hash-based timing cache is the replacement for the disabled profiling. #811 is a customer-filed issue about jq in serve (only customer issue on the board). #697 was deferred from Sprint 15 and depends on the now-merged #696. #807 and #792 are quick flaky test fixes.

### Batch 2 (serve DX + flaky test fixes + pre-commit tests)
#765, #766, #809, #808, #796

Two quick serve improvements (#765 SIGTERM, #766 TTY detection). Two flaky test fixes (#809 daemon-integration hooks, #808 ipc-server shutdown). #796 adds automated tests for the pre-commit hook tiers shipped in Sprint 15.

### Batch 3 (plans tab perf + cleanup + daemon)
#785, #786, #781, #777, #718

#785 is the biggest — eliminates N+1 IPC calls in usePlans. The rest are small cleanup and polish items from adversarial reviews.

## Context

Sprint 15 merged 14 PRs: ephemeral aliases (#696), 8 plans tab fixes, 3 serve/DX improvements, pre-commit hook optimization. Adversarial reviews of #696 caught 4 blockers across 2 rounds. The test timing budget was disabled after burning ~$2700 overnight on retry loops.

Key carry-forwards:
- #697 (auto-promote aliases) — blocked on #696 in Sprint 15, now unblocked
- #812 (hash-based timing cache) — P1, replaces the disabled hard-fail budget
- #811 (jq in serve) — customer-filed, only external user report on the board

Issues considered but excluded:
- #804 (watcher.spec.ts budget) — subsumed by #812's design
- #690 (suite wall time <25s) — aspirational, #812 is the concrete step
- #577 (Bun segfault on Linux) — upstream issue, can't fix ourselves
- #487 (idle timeout flaky) — may be same root cause as #809
- #700 (Plans tab epic) — mostly done, remaining children are in this sprint
- #776 (move usePlan hook) — dead code, can wait
- ACP/OpenCode spikes (#518, #503) — need validation, not blocking
- #699 (auto-update) — large feature, needs design
- #100 (defineAlias epic) — good foundation but too large for one sprint
- #328 (event-driven orchestration) — high value but high complexity
