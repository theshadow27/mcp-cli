# Sprint 17

> Planned 2026-03-18 02:30. Started 2026-03-18 02:45. Completed 2026-03-18 06:15. Result: 16/16 merged.

## Goal

Test debt cleanup + defineAlias deepening + CLI first-run polish

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **824** | **serve.ts below 80% line coverage** | **low** | **1** | **opus** | **goal** |
| **816** | **Replace remaining bare setTimeout in use-plans.spec.ts** | **low** | **1** | **opus** | **goal** |
| 776 | Move usePlan hook (dead code cleanup) | low | 1 | opus | goal |
| 487 | flaky: idle timeout daemon-integration test | medium | 1 | opus | goal |
| 94 | Zod schema validation for aliases on save and run | high | 1 | opus | goal |
| 752 | Add cache() helper to defineAlias context | medium | 2 | opus | goal |
| 77 | Import servers from Claude Desktop config | low | 2 | opus | goal |
| 86 | First-run prompt when .mcp.json detected | low | 2 | opus | goal |
| 373 | Integration tests for resume --wait and --timeout | low | 2 | opus | goal |
| 39 | Stdio-specific retry semantics for crash vs startup | medium | 2 | opus | goal |
| 518 | spike: validate ACP protocol with Copilot CLI | medium | 3 | opus | goal |
| 503 | spike: validate OpenCode server protocol | medium | 3 | opus | goal |
| 80 | Tab completion for mcx install from registry slugs | low | 3 | opus | filler |
| 38 | Integration test: verify transport error messages | low | 3 | opus | filler |
| 148 | mcpctl: show mcx serve instances and connected clients | medium | 3 | opus | filler |
| 834 | Sprint skill documentation and repo-level pointer | low | 1 | sonnet | filler |

## Batch Plan

### Batch 1 (sprint 16 follow-ups + dead code + flaky test + alias foundation)
#824, #816, #776, #487, #94

#824 and #816 are direct follow-ups from Sprint 16. #776 is dead code cleanup (usePlan hook merged but never used). #487 is a long-standing flaky test. #94 (Zod validation for aliases) builds on the defineAlias foundation — now that ephemeral aliases (#696) and auto-promote (#697) are shipped, structured validation is the natural next step.

### Batch 2 (CLI polish + test coverage + retry semantics + alias cache)
#752, #77, #86, #373, #39

#752 (cache helper) deepens defineAlias. #77 and #86 are CLI first-run polish that's been waiting since phase 1. #373 adds missing integration test coverage. #39 fixes a longstanding daemon retry behavior gap.

### Batch 3 (ACP/OpenCode spikes + filler)
#518, #503, #80, #38, #148

The two spikes (#518 ACP, #503 OpenCode) validate whether the provider architecture works before committing to full implementations. #80 (tab completion), #38 (error message tests), and #148 (serve instances in TUI) are independent fillers.

## Context

Sprint 16 achieved a clean 15/15 sweep: hash-based timing cache (P1), customer jq issue, alias auto-promote, 3 flaky test fixes, daemon-side plans, WS port reclaim, and 4 plans tab fixes. v0.8.0 released.

The defineAlias epic (#100) has strong foundation: ephemeral aliases (#696), auto-promote (#697), defineAlias virtual module, alias bundler. Next steps are Zod validation (#94) and the cache helper (#752). The registry (#698) and composition (#104) are too large for this sprint.

ACP (#517) and OpenCode (#502) are the biggest unexplored arcs — both need spikes before committing to full implementations. Sprint 17 validates feasibility.

Issues considered but excluded:
- #698 (shared alias registry) — large feature, needs #94 first
- #104 (alias composition) — needs #94 first
- #699 (auto-update) — large feature, needs design
- #328 (event-driven orchestration) — high value but high complexity, save for focused sprint
- #690 (suite wall time <25s) — aspirational, #812 was the concrete step
- #577 (Bun segfault on Linux) — upstream issue
- #299/#295 (tracing) — valuable but large, needs dedicated sprint
- #82/#81/#85 (TUI features) — large, save for TUI-focused sprint
- #113 (OAuth auto-discover) — complex auth work, needs design
- #115/#116/#117 (transport/concurrent tests) — good but not urgent
