# Sprint 29

> Planned 2026-04-11 04:30. Started 2026-04-11 04:45. Completed 2026-04-11 07:15. Result: 5/6 merged (1 gap analysis only).

## Goal

Deep review + land mcx clone; complete work item tracker Phases 2-3

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1163** | **mcx clone — adversarial review of PR #1163** | **high** | **1** | **sonnet (review), opus (repair)** | **P1 goal** |
| **1160** | **mcx clone — gap analysis vs epic scope** | **medium** | **1** | **sonnet** | **goal** |
| **1140** | **GitHub GraphQL poller for work item state** | **medium** | **2** | **opus** | **goal** |
| **1141** | **mcx wait --any races session + work item events** | **low** | **3** | **opus** | **goal** |
| **1142** | **enriched mcx claude ls with lifecycle line** | **low** | **3** | **opus** | **goal** |
| **1171** | **triage.ts requires worktree that bye cleaned up** | **low** | **2** | **opus** | **filler** |

## Batch Plan

### Batch 1 (immediate — 2 sessions)

**Adversarial review of PR #1163**: This is a big PR (15 files, new package) from an unreviewed solo session. Needs:
1. Fix CI failures first (typecheck/build errors — 3 consecutive failures in <45s)
2. Deep adversarial review against repo standards (CLAUDE.md rules, no `any`, barrel exports, test patterns)
3. Repair cycle for findings
4. Gap analysis: what from #1160's phased plan is actually in this PR vs what's left? File follow-up issues for remaining phases.

**CI fix first**: Spawn an opus to fix the build, then review the fixed version.

### Batch 2 (parallel with clone review — 2 issues)
#1140, #1171

#1140 is the GitHub GraphQL poller — depends on Phase 1 (merged in Sprint 28). This is the meaty one that makes work items live. #1171 is triage tooling fix (independent filler).

### Batch 3 (after #1140 merges — 2 issues)
#1141, #1142

Both depend on #1140 (need the poller emitting events). Can run in parallel — #1141 is wait integration, #1142 is enriched ls. These complete the work item tracker vision.

## Context

Sprint 28 shipped work item tracker Phase 1 + auto-update (v1.2.0). PR #1163 (mcx clone) was built by an external session on a different machine — impressive scope (1022-page Confluence clone in 10s) but hasn't been through the review pipeline. CI is failing. This sprint validates and lands it, then completes the work item tracker with Phases 2-3 (GraphQL poller, wait integration, enriched ls). By end of sprint, `mcx claude ls` should show live PR/CI/review status and `wait --any` should race session + work item events.

## Results

- **Released**: v1.3.0
- **PRs merged**: 5 (#1163, #1174, #1180, #1185, #1186)
- **Issues closed**: 6 (#1140, #1141, #1142, #1160 Phase 1, #1162, #1171)
- **Adversarial reviews**: 5 (clone: 3 P0 security issues, poller: 3 reds, wait: 2 reds — all repaired)
- **New issues filed**: ~15 (gap analysis filed clone follow-ups #1175-1184, CI blocker #1181, docs #1173)
- **Gap analysis**: Posted on #1160 with phase-by-phase status
