# Sprint 26

> Planned 2026-04-08 22:15. Target: 8 PRs. Cleanup sprint.

## Goal

Stability cleanup + worktree pollution investigation

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1109** | **Worktree pollution investigation** | **medium** | **1** | **opus** | **P2 goal** |
| **1108** | **approve/deny not wired through claude shim** | **low** | **1** | **opus** | **bug** |
| **1103** | **Daemon shutdown hangs** | **medium** | **1** | **opus** | **bug** |
| 1105 | closeAll timing flake | high (flaky) | 1 | opus | filler |
| 1104 | startMockServer no timeout | low | 2 | opus | filler |
| 1071 | closeAll race tracking | low | 2 | opus | filler |
| 1097 | serve kill --stale | low | 2 | opus | filler |
| 968 | Sprint pause/resume orchestrator wiring | medium | 2 | opus | goal |

## Batch Plan

### Batch 1 (immediate — 4 issues)
#1109, #1108, #1103, #1105

#1109 is the worktree pollution investigation — nerdsnipe to trace exactly how files end up modified in the main tree. #1108 is a quick wiring fix. #1103 needs root cause analysis. #1105 is a flaky test.

### Batch 2 (backfill — 4 issues)
#1104, #1071, #1097, #968

Quick test fixes, serve kill --stale, and the sprint pause/resume wiring (quota monitoring + rate limit events are already in, just needs orchestrator integration in the sprint skill).

## Monitoring plan

**Worktree pollution tracking:** After EVERY session bye, run `git status --porcelain` on the main tree. If any files are dirty:
1. Record which files
2. Cross-reference with the session's PR diff
3. Determine: duplicate write (work in both places) or misrouted write (only in main)
4. If misrouted: DO NOT reset — the work may be lost from the PR

## Context

This is likely the final cleanup sprint before wrapping this conversation context. After this, the board should be down to long-term epics (#100, #1049, #295/299, #328, #698, #699, #935) and upstream tracking (#577, #929, #957). Good place for a multi-sprint retro and roadmap handoff.
