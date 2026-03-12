# Sprint 11

> Planned 2026-03-11. Target: 15 PRs.

## Goal

Fix Codex integration + harden daemon reliability + clean up sprint 10 follow-ups

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 666 | codex spawn serialization bug | medium | 1 | opus | goal |
| 671 | bye never cleans up daemon-created worktrees | low | 1 | opus | goal |
| 665 | filter keep_alive from transcript ring buffer | low | 1 | opus | goal |
| 669 | double-close of virtual server clients on shutdown | low | 1 | opus | goal |
| 644 | PID reuse in session restore — SIGTERM wrong process | medium | 1 | opus | goal |
| 643 | worker crash + WS port kills restorable sessions | medium | 2 | opus | goal |
| 667 | python-repr: b''/r''/f'' string prefixes fail | low | 2 | opus | filler |
| 668 | python-repr: trailing commas not stripped | low | 2 | opus | filler |
| 652 | release script: pre-commit runs full test suite | low | 2 | opus | filler |
| 653 | release script: no rollback on partial failure | low | 2 | opus | filler |
| 664 | release: no rollback if gh release create fails | low | 3 | opus | filler |
| 663 | release: pre-commit may leave dirty package.json | low | 3 | opus | filler |
| 551 | test suite perf — profile slow files | medium | 3 | opus | goal |
| 230 | control: prompt input mode in Claude tab | medium | 3 | opus | goal |
| 138 | expose mail as virtual MCP tools | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate)
#666, #671, #665, #669, #644

### Batch 2 (backfill)
#643, #667, #668, #652, #653

### Batch 3 (backfill)
#664, #663, #551, #230, #138

## Results

**13/15 merged. 2 deferred (quota conservation).**

| # | PR | Result |
|---|-----|--------|
| 665 | #672 | merged |
| 667 | #675 | merged |
| 668 | #677 | merged |
| 671 | #674 | merged |
| 643 | #682 | merged |
| 652 | #681 | merged |
| 666 | #684 | merged |
| 663 | #687 | merged |
| 664 | #685 | merged |
| 551 | #689 | merged |
| 669 | #673 | merged (adversarial review → repair → QA) |
| 653 | #686 | merged (adversarial review → repair → QA) |
| 644 | #683 | merged (adversarial review → repair → QA) |
| 230 | — | deferred (quota) |
| 138 | — | deferred (quota) |

### Incidents

- Daemon restart mid-sprint killed 6 orphaned sessions. Root cause: daemon was
  running pre-#618 code (started before well-known WS port merged). 2 sessions
  reconnected (spawned after restart), 6 died but had already pushed PRs.
- Added pre-flight and wind-down daemon restart steps to sprint run reference.

### Follow-up issues filed by adversarial reviews

- #676, #678 (from #669 review)
- #679 (from #671 QA)
- #691, #692 (from #669 second review)
- #693, #694, #695 (from #644 review)

## Context

Sprint 10 shipped v0.4.0 with 11 PRs. The adversarial reviews surfaced several
follow-up issues (#665, #667, #668, #669) that are quick fixes. #666 (Codex
broken) is P1 — blocks using Codex for reviews. #671 (bye cleanup) is P1 —
causes 100+ orphaned worktree dirs per sprint. #644 and #643 are daemon
reliability bugs that could cause data loss. Release script issues (#652, #653,
#663, #664) are all from the sprint 10 review of release.ts. #230 and #138 are
feature work that rounds out the Control TUI story from sprint 9-10.
