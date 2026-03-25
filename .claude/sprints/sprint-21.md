# Sprint 21

> Planned 2026-03-23 23:15. Target: 14 PRs.

## Goal

TUI enhancements + post-v1.0 cleanup

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **969** | **Release build fails — mcx bundle not found** | **medium** | **1** | **opus** | **goal** |
| **81** | **Server add/remove in TUI** | **high** | **1** | **opus** | **goal** |
| **82** | **Registry browser in TUI** | **high** | **2** | **opus** | **goal** |
| **961** | **Audit mcpctl for Bun.sliceAnsi** | low | 1 | opus | goal |
| 946 | Completions: add claude and agent to SUBCOMMANDS | low | 1 | opus | filler |
| 950 | shutdownComplete in P4 afterEach | low | 1 | opus | filler |
| 962 | Session age in mcx claude ls | low | 1 | opus | filler |
| 963 | Stale comments referencing deleted files | low | 1 | opus | filler |
| 964 | Stale daemon build breaks --short and stats | medium | 2 | opus | filler |
| 967 | Ratchet test budget below 40s | low | 2 | opus | filler |
| 952 | Flaky: claude-server counter on successful connect | low | 2 | opus | filler |
| 956 | Flaky: ClaudeServer connect timeout metric | low | 2 | opus | filler |
| 960 | Flaky: daemon boots virtual servers ENXIO | low | 3 | opus | filler |
| 965 | Bun segfault in check-coverage.ts pre-commit | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 7 issues)
#969, #81, #961, #946, #950, #962, #963

#969 is P1 — v1.0.0 release has no binaries. Fix the release build first.

#81 (server add/remove in TUI) is the main goal issue — interactive server management in mcpctl. #961 is a TUI quality pass (Bun.sliceAnsi). The rest are quick filler wins.

### Batch 2 (backfill — 5 issues)
#82, #964, #967, #952, #956

#82 (registry browser) is the second big TUI feature — discover and install servers from within mcpctl. The fillers are daemon bug fix and flaky tests.

### Batch 3 (backfill — 2 issues)
#960, #965

Remaining flaky tests and Bun segfault workaround.

## Context

v1.0.0 just shipped. The unified agent command epic is complete. The TUI (mcpctl) hasn't had feature work since Sprint 14. #81 and #82 make it a fully self-contained tool — users can manage their entire MCP setup without dropping to the CLI. The quick wins clean up follow-ups from Sprint 20.
