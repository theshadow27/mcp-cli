# Sprint 23

> Planned 2026-03-29 21:00. Updated 2026-04-08. Target: 15 PRs.

## Goal

Project scoping epic + quota monitoring + orchestrator DX

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1009** | **Scope registry: mcx scope init/list/rm** | **medium** | **1** | **opus** | **goal** |
| **1010** | **Scope detection: walk-up cwd matching** | **medium** | **1** | **opus** | **goal (dep: #1009)** |
| **1008** | **Quota monitoring via OAuth usage endpoint** | **medium** | **1** | **opus** | **goal** |
| **1053** | **flock PID file to prevent duplicate daemons** | **medium** | **1** | **opus** | **P1 goal** |
| **1011** | **Session filtering by scope in ls/wait/bye** | **medium** | **2** | **opus** | **goal (dep: #1010)** |
| **1012** | **Config loader parent matching for worktrees** | **medium** | **2** | **opus** | **goal (dep: #1010)** |
| **1013** | **mcpctl scope selector** | **medium** | **3** | **opus** | **goal (dep: #1011)** |
| 1043 | Reactive rate limit: session:rate_limited event | low | 1 | opus | filler |
| 1048 | bye --keep-worktree | low | 1 | opus | filler |
| 1028 | Cost tracking garbage values | medium | 2 | opus | filler |
| 1014 | Test noise threshold regression | low | 1 | opus | filler |
| 1026 | permission-router.ts coverage gap | low | 1 | opus | filler |
| 1015 | permission-router blocks pre-commit | low | 1 | opus | filler |
| 1024 | daemon-integration hangs in pre-commit | high (flaky) | 2 | opus | filler |
| 1023 | Flaky SSE connection refused | high (flaky) | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 7 issues)
#1053, #1009, #1008, #1043, #1048, #1014, #1026, #1015

#1053 is P1 — duplicate daemons after sleep/wake is a recurring problem. Fix with flock.

#1009 (scope registry) is the foundation of the scoping epic — must land first so #1010 can start. #1008 (quota monitoring) is fully specced with proven API. #1043/#1048 are quick DX wins. #1014/#1026/#1015 are pre-commit blockers that need fixing.

### Batch 2 (backfill — 5 issues)
#1010 (dep: #1009), #1011 (dep: #1010), #1012 (dep: #1010), #1028, #1024

#1010 (scope detection) unblocks #1011 and #1012 which can run in parallel. #1028 (cost tracking) and #1024 (flaky daemon integration) fill the remaining slots.

### Batch 3 (backfill — 2 issues)
#1013 (dep: #1011), #1023

#1013 (mcpctl scope selector) depends on session filtering landing first. #1023 is a flaky test fix.

## Dependency chain

```
#1009 → #1010 → #1011 → #1013
                → #1012
```

All other issues are independent.

## Excluded

- **#1049** (work item tracker epic) — pulled out for proper design. Needs sub-issue breakdown before implementation. This is a core architectural feature, not a flag on wait.

## Context

Sprint 22 shipped the mock agent provider, orchestration smoke tests, and the critical idle detection fix (#978). The daemon is now much more reliable. This sprint builds on that with project scoping (the #981 epic — 5 sub-issues), quota monitoring (#1008 — proven endpoint), and orchestrator DX improvements (--keep-worktree, reactive rate limits).

Pre-commit is currently broken on main due to noise threshold and coverage regressions (#1014, #1015, #1026) — those are batch 1 priority.
