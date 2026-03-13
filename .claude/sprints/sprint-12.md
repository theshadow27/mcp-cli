# Sprint 12

> Planned 2026-03-12. Target: 15 PRs.

## Goal

Plans tab foundation (epic #700 sprint 1) + adversarial review follow-ups + deferred sprint 11 features

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 701 | plan protocol types and Zod schemas | low | 1 | opus | goal |
| 702 | plan server auto-detection in server-pool | medium | 1 | opus | goal |
| 703 | plan data fetching hooks (usePlans) | medium | 1 | opus | goal |
| 230 | control: prompt input mode in Claude tab | medium | 2 | opus | filler |
| 138 | expose mail as virtual MCP tools | medium | 2 | opus | filler |
| 676 | wrap virtual server stop in try/catch | low | 2 | opus | filler |
| 678 | constants for virtual server names | low | 2 | opus | filler |
| 695 | process-identity test passes for wrong reason | low | 2 | opus | filler |
| 691 | double-close race on crash-restart during shutdown | low | 3 | opus | filler |
| 692 | no timeout on client.close() blocks shutdown | low | 3 | opus | filler |
| 693 | timezone-immune elapsed time for PID | low | 3 | opus | filler |
| 694 | spawnSync per-session blocks event loop | low | 3 | opus | filler |
| 680 | suppress worker log noise in tests | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (Plans arc — sequential)
#701 → #702 → #703

These have hard dependencies. Start #701 immediately, spawn #702 when #701 merges,
spawn #703 when #702 merges. Backfill batch 2 issues into open impl slots while
waiting for the chain.

### Batch 2 (backfill — independent)
#230, #138, #676, #678, #695

All independent. Spawn alongside batch 1 to keep slots saturated.

### Batch 3 (backfill — independent)
#691, #692, #693, #694, #680

All adversarial review follow-ups from sprint 11. Small, focused fixes.

## Context

Epic #700 is a new feature arc: a Plans tab in mcpctl that auto-detects MCP servers
implementing a plan protocol and provides a live operations dashboard. This sprint
covers the foundation layer (types, detection, hooks) — no visible UI yet. Sprint 2
of the arc (#704-#706) builds the actual tab.

Batch 2 carries forward #230 and #138 from sprint 11 (deferred due to quota). The
rest are follow-up issues filed by adversarial reviews during sprints 10-11: shutdown
safety (#676, #691, #692), process identity hardening (#693, #694, #695), and test
noise (#678, #680).

## Results

- **Released**: v0.5.0
- **PRs merged**: 14 (#708–#711, #714, #724–#731, #733)
- **Issues closed**: 13/13 planned + 2 unplanned (#712 P0 regression, #723 --cwd escape)
- **Issues dropped**: 0
- **New issues filed**: 2 (#712, #723)
- **Note**: Sprint was spiked mid-execution by P0 #712 (daemon idle timeout killing active sessions). All planned issues had already been completed in prior sessions. Sprint execution discovered and fixed the P0, plus the --cwd absolute path bug (#723/#733).
