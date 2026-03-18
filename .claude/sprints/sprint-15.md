# Sprint 15

> Planned 2026-03-16. Completed 2026-03-17. Result: 14/15 merged (#697 deferred to sprint 16).

## Goal

Automatic aliases + plans tab stabilization + serve hardening

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **789** | **Pre-commit hook runs full test suite on non-code changes** | **low** | **1** | **opus** | **goal** |
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

## Batch Plan

### Batch 1 (pre-commit fix + alias foundation + critical bugs + serve hardening)
#789, #696, #784, #775, #778, #764

#789 ships first — every subsequent commit in the sprint benefits from faster pre-commit hooks. #696 is the big one — ephemeral alias infrastructure (TTL column, hash-named auto-save, cleanup sweep). #784 is a data-loss bug (double-fire on abort). #778 is a P1 from review (hung server freezes all plans). #764 prevents OOM in the new stdio transport. #775 is a quick UX fix.

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

## Results

| # | Title | PR | Result |
|---|-------|----|--------|
| 789 | Pre-commit hook optimization | #793 | merged (also closed #753) |
| 696 | Ephemeral aliases | #800 | merged (2 adversarial reviews, 2 repair rounds) |
| 784 | confirmAbort double-fire guard | #791 | merged |
| 775 | Reset loading state on Plans tab switch | #790 | merged |
| 778 | Per-server IPC timeout in usePlans | #795 | merged |
| 764 | Buffer size limit in BunStdioServerTransport | #794 | merged |
| 697 | Auto-promote ephemeral aliases | — | **deferred to sprint 16** (blocked on #696) |
| 763 | plansSelectedIndex cursor drift | #801 | merged |
| 762 | Silent Zod parse failures in usePlans | #797 | merged |
| 780 | MetricsPanel separator width | #798 | merged |
| 783 | STATUS_COLORS.info color | #802 | merged |
| 782 | Footer plan hints capability gating | #806 | merged |
| 779 | Partial-failure warning for plan servers | #805 | merged |
| 787 | Session ID prefix matching for MCP tools | #810 | merged |
| 788 | MCP transcript compact mode | #803 | merged |

**14 issues merged, 1 deferred. Also closed #753 as a subset of #789.**

## Incidents

- **QA sessions running in main folder**: QA sessions spawned without `--worktree` or `--cwd` ran in the main repo, polluting the working tree. Fixed run.md to document the fallback: use `--worktree` when the implementation worktree was auto-cleaned by `bye`.
- **Overnight cost explosion**: Sessions #779 ($108), #782 ($469), #787 ($1154), #696 repair ($961) got stuck retrying pre-commit hooks overnight. The pre-commit hook's test budget check (`watcher.spec.ts` exceeding 5s) caused infinite retry loops. Total wasted cost: ~$2700. Need a session cost cap or auto-interrupt.
- **watcher.spec.ts timing budget**: Added to TIMING_EXCLUSIONS during sprint. Pre-existing issue — FS integration tests with 8s polling timeouts exceed the 5s budget.
