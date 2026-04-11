# Sprint 28

> Planned 2026-04-11 02:15. Started 2026-04-11 02:30. Completed 2026-04-11 04:00. Result: 8/9 merged (1 already fixed).

## Goal

Work item tracker Phase 1 + auto-update + cleanup

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1136** | **Core work item types + state machine** | **low** | **1** | **opus** | **goal** |
| **1133** | **permission-router.ts coverage** | **low** | **1** | **opus** | **filler** |
| **1145** | **Remove homebrew job from release workflow** | **low** | **1** | **opus** | **filler** |
| **1146** | **alias-executor cache test stale from segfault** | **low** | **1** | **opus** | **filler** |
| **1137** | **work_items SQLite table + CRUD** | **low** | **2** | **opus** | **goal** |
| **1143** | **mcx update command** | **medium** | **2** | **opus** | **goal** |
| **1144** | **install.sh curl installer** | **low** | **2** | **opus** | **goal** |
| **1138** | **_work_items virtual MCP server** | **medium** | **3** | **opus** | **goal** |
| **1139** | **mcx track/untrack/tracked CLI** | **low** | **3** | **opus** | **goal** |
| **699** | **Auto-update epic — close when sub-issues done** | **—** | **—** | **—** | **tracking** |

## Batch Plan

### Batch 1 (immediate — 3 issues)
#1136, #1133, #1145

All independent. #1136 is the foundation types for the work item tracker. #1133 is a quick test coverage fix. #1145 is a 2-line CI cleanup. #1146 is a flaky test fix (stale cache from segfault crashes).

### Batch 2 (backfill — 3 issues)
#1137, #1143, #1144

#1137 depends on #1136 (uses the types). #1143 and #1144 are independent (auto-update). All three can run in parallel once batch 1 is done — #1143/#1144 don't depend on the work item tracker.

### Batch 3 (backfill — 2 issues)
#1138, #1139

#1138 depends on #1137 (uses the CRUD). #1139 depends on #1138 (calls the virtual server). Sequential dependency.

## Context

Sprint 27 cleared the backlog — 7 PRs merged, v1.1.4 released. Board was down to long-term epics. This sprint starts two new feature arcs: work item tracker (#1049 Phase 1) and auto-update (#699). The work item tracker is the last infrastructure gap before the sprint orchestrator becomes fully event-driven. Auto-update enables distribution without homebrew.

## Results

- **Released**: v1.2.0
- **PRs merged**: 8 (#1147, #1148, #1149, #1150, #1151, #1152, #1155, #1161)
- **Issues closed**: 9 (#1133, #1136, #1137, #1138, #1139, #1143, #1144, #1145, #1146)
- **Adversarial reviews**: 3 (#1152, #1155, #1161 — all found real issues, all repaired)
- **New issues filed**: 0
- **Dropped**: #1133 (already fixed in Sprint 27)
