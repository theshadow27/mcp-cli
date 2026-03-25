# Sprint 22

> Planned 2026-03-25 15:30. Target: 13 PRs.

## Goal

Ship release binaries + regression-proof the orchestration layer

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1005** | **Release workflow fix (macos-13 → cross-compile)** | **medium** | **1** | **opus** | **P1 goal** |
| **1006** | **Mock agent provider** | **medium** | **1** | **opus** | **goal** |
| **1007** | **CLI orchestration smoke tests (dep: #1006)** | **medium** | **2** | **opus** | **goal** |
| **1008** | **Quota API spike** | **low** | **2** | **opus** | **nerdsnipe** |
| 973 | shutdownComplete in P1 startup afterAll | low | 1 | opus | filler |
| 975 | Flaky: CodexServer connect timeout metric | high (flaky) | 1 | opus | filler |
| 995 | Flaky: stress test S3 timeout | high (flaky) | 1 | opus | filler |
| 988 | TUI: warn missing `=` in env var | low | 2 | opus | filler |
| 989 | TUI: HTTP/SSE no env vars | low | 2 | opus | filler |
| 990 | TUI: stdio quoting warning | low | 2 | opus | filler |
| 991 | TUI: duplicate server name warning | low | 3 | opus | filler |
| 992 | TUI: form state on tab switch | low | 3 | opus | filler |
| 993 | TUI: deduplicate TRANSPORT_OPTIONS | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1005, #1006, #973, #975, #995

#1005 is P1 — v1.0.0 and v1.0.1 have no release binaries. Fix the workflow first. #1006 (mock agent provider) is the foundation for #1007. #975 and #995 are flaky tests → mandatory adversarial review. #973 is a quick test fix.

### Batch 2 (backfill — 5 issues)
#1007, #1008, #988, #989, #990

#1007 depends on #1006 landing first. #1008 is the quota API nerdsnipe — autonomous investigation, reports findings. Three TUI follow-ups from #81 review.

### Batch 3 (backfill — 3 issues)
#991, #992, #993

Remaining TUI polish from #81/#82 adversarial review findings.

## Context

v1.0.1 just shipped but has no binaries (release workflow broken since project inception). Sprint 21 exposed 3 critical orchestration regressions from the agent refactor (#913) — all fixed, but no regression tests exist. The mock agent provider (#1006) + smoke tests (#1007) will prevent recurrence.

The scoping epic (#981) is planned for Sprint 23 with 5 sub-issues (#1009-#1013).
