# Sprint 27

> Planned 2026-04-10 23:30. Target: 10 PRs.

## Goal

Merge open PRs + stabilize auth/worktree/CI pipeline

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1125** | **Pre-commit fast path — daemon tests CI-only** | **low** | **1** | **opus** | **P1 goal** |
| **1122** | **OAuth redirectUrl fix for Atlassian** | **low** | **1** | **opus** | **P1 goal** |
| **1129** | **Bun 1.3.12 unsigned binaries — build.ts codesign workaround** | **low** | **1** | **opus** | **P1 goal** |
| **1126** | **Upgrade Bun 1.3.11→1.3.12 — verify segfault fix** | **medium** | **1** | **opus** | **P1 goal** |
| 1120 | SSE protected resource URL mismatch (Asana) | medium | 1 | opus | P2 goal |
| 1121 | approve/deny dead code — wire through agent.ts | low | 1 | opus | goal |
| 1116 | Orphaned worktree on IPC failure after git worktree add | low | 2 | opus | goal |
| 1115 | Headless --worktree branch namespace collision | low | 2 | opus | goal |
| 957 | Bun segfault — verify fixed on 1.3.12, close or update | medium | 2 | opus | filler |
| 577 | CI segfault tracking — close if 1.3.12 fixes it | low | 2 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1125 (PR #1128 exists — QA), #1122 (PR #1127 exists — QA), #1126, #1120, #1121

#1125 and #1122 have open PRs (#1128, #1127) — run through triage → QA pipeline to merge. #1126 is Bun upgrade verification — run daemon tests 5x on 1.3.12 to confirm segfault is gone. #1120 is the Asana SSE issue (medium scrutiny — touches OAuth flow). #1121 is a quick wiring fix.

### Batch 2 (backfill — 4 issues)
#1116, #1115, #957, #577

Worktree cleanup fixes from adversarial review of #1114. #957/#577 are segfault tracking — if #1126 confirms the fix, close them with data.

## Context

Sprint 26 completed all 8 issues. v1.1.3 released. Pre-commit was taking 4 minutes — PR #1128 cuts it to 15s. Bun 1.3.12 just released and local full test suite (3932 tests) passed without segfault — first time daemon tests didn't crash. This sprint validates that fix across CI and cleans up the auth/worktree follow-ups.
