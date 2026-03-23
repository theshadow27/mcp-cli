# Sprint 20

> Planned 2026-03-19 06:30. Started 2026-03-19 07:00. **Re-planned 2026-03-23 15:44.** Completed 2026-03-23 22:41. Result: 14/14 merged (26/15 total including original run).

## Progress (12 of 15 original issues shipped)

Closed: #907, #908, #909, #911, #912, #905, #903, #902, #899, #897, #888, #880
Closed as dup/superseded: #904 (→ #920), #937 (→ #936)

## Goal

Complete agent unification + stabilize test suite + ship daemon reliability fixes

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **910** | Resume shim: generic session resume | medium | 1 | opus | goal |
| **913** | Alias mcx claude → mcx agent claude | low | 1 | opus | goal |
| **940** | Stdio server child processes leak on daemon restart | medium | 1 | opus | goal |
| 922 | Replace spyOn(console) with DI in update/config specs | low | 1 | opus | filler |
| 923 | Replace spyOn(process, "exit") in install.spec.ts | low | 1 | opus | filler |
| **920** | fix(daemon): idle-timeout ENXIO structural race | medium | 2 | opus | goal |
| **936** | fix(daemon): claude-server metrics test flaky | low | 2 | opus | goal |
| 941 | Python-repr parser breaks on nested JSON strings | low | 2 | opus | filler |
| 933 | Verify npm pack output for #888 | low | 2 | opus | filler |
| 934 | Coverage for scripts/prepare-npm.ts entrypoint | low | 2 | opus | filler |
| 930 | Further reduce suite wall time | low | 3 | opus | filler |
| 921 | CI: upgrade actions/checkout for Node.js 24 | low | 3 | opus | filler |
| 938 | Replace manual ANSI slicing with Bun.sliceAnsi | low | 3 | opus | filler |
| 939 | Configure bun test --path-ignore-patterns | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#910, #913, #940, #922, #923

#910 and #913 complete the agent epic (#906). #940 is a P1 daemon bug — stdio child processes leaking on restart. #922 and #923 are quick test quality fixes (DI pattern, same as #903 fix).

### Batch 2 (backfill — 5 issues)
#920, #936, #941, #933, #934

#920 is the structural idle-timeout race condition. #936 is the metrics singleton flaky test. #941 is a parser bug in alias tooling. #933/#934 are npm distribution follow-ups.

### Batch 3 (backfill — 4 issues)
#930, #921, #938, #939

All low-scrutiny filler: test perf, CI maintenance, Bun API adoption.

## Context

Sprint 20 shipped the core agent unification epic (12 of 15 issues) in the first phase. This re-plan pivots to: completing the remaining epic work (#910, #913), fixing daemon reliability bugs surfaced during sprint QA (#920, #936, #940), and clearing the test stability backlog.

**Dependency chain:** #910 and #913 depend on #908 (shipped). Everything else is independent.

**Excluded:**
- #929 (Bun segfault) — upstream bug, can't fix
- #935 (agent profiles) — needs design discussion, not sprint-ready
- #699 (auto-update) — post-v1
- #698 (shared alias registry) — post-v1
- #328 (event-driven orchestration) — post-v1
- #577 (Bun CI segfault) — upstream
