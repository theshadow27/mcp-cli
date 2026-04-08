# Sprint 25

> Planned 2026-04-08 15:30. Target: 13 PRs.

## Goal

Fix pre-commit — stop needing `--no-verify`

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1078** | **Pre-commit daemon test timeout** | **medium** | **1** | **opus** | **P1 goal** |
| **1085** | **Pre-commit blocked in worktrees** | **medium** | **1** | **opus** | **P1 goal** |
| **1084** | **Bun segfault CI workaround** | **medium** | **1** | **opus** | **P1 goal** |
| 1052 | @file trailing flags + Python repr | low | 1 | opus | goal |
| 1038 | Permission approval for spawned sessions | medium | 1 | opus | goal |
| 1051 | Kill serve instances | low | 2 | opus | filler |
| 1039 | Orchestration smoke test: flag guards | low | 2 | opus | filler |
| 1040 | Orchestration smoke test: wait/age | low | 2 | opus | filler |
| 1019 | Flaky daemon integration timeout | high (flaky) | 2 | opus | filler |
| 1020 | Flaky S2 concurrent CLI | high (flaky) | 3 | opus | filler |
| 1029 | Mock Worker startup tests | low | 3 | opus | filler |
| 1041 | Flaky interrupt test pattern | low | 3 | opus | filler |
| 1042 | S3 timing headroom | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1078, #1085, #1084, #1052, #1038

The three P1s fix the pre-commit pipeline. #1078 (daemon tests exceeding 120s) is the root cause — either raise the budget, exclude daemon tests from pre-commit, or speed them up. #1085 is the same issue manifesting in worktrees. #1084 needs a CI-level workaround for the 33% Bun segfault rate (auto-retry, or split the test run). #1052 and #1038 are independent features.

### Batch 2 (backfill — 4 issues)
#1051, #1039, #1040, #1019

Kill serve instances, orchestration smoke test expansion, and flaky daemon integration.

### Batch 3 (backfill — 4 issues)
#1020, #1029, #1041, #1042

Remaining flaky tests and test stability improvements.

## Context

Sprint 24 had 6/8 sessions needing `--no-verify` due to the daemon test timeout. This sprint eliminates that tax. The Bun segfault (33% CI failure rate) also needs a workaround since the upstream fix (oven-sh/bun#27960) is still pending.
