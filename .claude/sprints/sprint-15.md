# Sprint 15

> Planned 2026-03-16. Target: 15 PRs.

## Goal

Automatic aliases + plans tab stabilization + serve hardening

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 696 | Ephemeral aliases — auto-save long CLI calls with TTL | high | 1 | opus | goal |
| 784 | confirmAbort y-handler should guard on inflight to prevent double-fire | low | 1 | opus | goal |
| 775 | Reset loading state when Plans tab re-enabled after switch | low | 1 | opus | goal |
| 778 | Per-server IPC timeout in usePlans to prevent poll loop stall | medium | 1 | opus | goal |
| 764 | Buffer size limit in BunStdioServerTransport to prevent OOM | medium | 1 | opus | goal |
| 697 | Auto-promote ephemeral aliases to curated based on usage patterns | high | 2 | opus | goal |
| 763 | plansSelectedIndex cursor drifts from expandedPlan when plans reorder | low | 2 | opus | goal |
| 762 | Silent Zod parse failures in usePlans drop server plans | low | 2 | opus | goal |
| 780 | MetricsPanel separator width breaks on narrow terminals | low | 2 | opus | goal |
| 783 | STATUS_COLORS.info maps to green — should be distinct from success | low | 2 | opus | goal |
| 782 | Footer plan hints should gate on individual capabilities | low | 3 | opus | goal |
| 779 | Show partial-failure warning when some plan servers fail | low | 3 | opus | goal |
| 787 | Curated MCP tools don't support session ID prefix matching | low | 3 | opus | filler |
| 788 | MCP transcript tool returns excessive metadata — needs compact mode | low | 3 | opus | filler |
| 765 | SIGTERM/SIGINT handler in mcx serve for graceful shutdown | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (alias foundation + critical bugs + serve hardening)
#696, #784, #775, #778, #764

#696 is the big one — ephemeral alias infrastructure (TTL column, hash-named auto-save, cleanup sweep). #784 is a data-loss bug (double-fire on abort). #778 is a P1 from review (hung server freezes all plans). #764 prevents OOM in the new stdio transport. #775 is a quick UX fix.

### Batch 2 (alias auto-promote + plans tab polish)
#697, #763, #762, #780, #783

#697 depends on #696 (ephemeral aliases must exist first). The rest are independent plans tab fixes from adversarial reviews — all small and well-specified.

### Batch 3 (remaining plans fixes + serve DX)
#782, #779, #787, #788, #765

All independent. Backfill as batch 1/2 slots free.

## Context

Sprint 14 merged 14 issues: P1 serve bug (#754), plans tab features (#705, #706, #707), plans tab repairs (#748, #749), verbose/dry-run flags (#90), help text (#751), and 5 flaky test fixes. Adversarial reviews filed 12+ follow-up issues that form the stabilization backlog.

Automatic aliases (#696, #697) were deferred from sprint 14 to prioritize the P1 serve bug. They're the user's stated priority and return as the primary goal.

PR #746 (plans tab foundation) is merging to main — once it lands, #704 and #700 can be closed.

Issues considered but excluded:
- #785 (N+1 IPC → daemon-side claude_plans) — perf optimization, not blocking
- #786 (Zod validation for transcript response) — defensive, not urgent
- #781 (extract getTargetPlan helper) — refactor, not blocking
- #776 (move usePlan hook) — dead code cleanup, can wait
- #766 (TTY detection for serve) — nice-to-have DX
- #696/#697 carry risk — if aliases slip, plans tab fixes fill the sprint
- ACP/OpenCode spikes (#518, #503) — still need validation
- #699 (auto-update) — large feature, needs design
