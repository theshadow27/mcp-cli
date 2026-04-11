# Sprint 30

> Planned 2026-04-11 07:30. Target: 15 PRs.

## Goal

Stabilize Sprints 28-29 + VFS provider expansion (Jira, Asana spike)

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1181** | **bun test exits code 1 on Linux despite 0 failures** | **medium** | **1** | **opus** | **P1 blocker** |
| **1187** | **mcx track should resolve PR number from issue** | **low** | **1** | **opus** | **P1 goal** |
| **1188** | **Poller needs pollNow() trigger on track** | **low** | **1** | **opus** | **P1 goal** |
| **1176** | **Unit tests for clone package** | **low** | **1** | **opus** | **goal** |
| **1182** | **Numeric page IDs round-trip as numbers in frontmatter** | **low** | **1** | **opus** | **goal** |
| **1179** | **Lint rule for execSync with template literals** | **low** | **1** | **opus** | **goal** |
| **1154** | **install.sh PATH fix** | **low** | **1** | **opus** | **filler** |
| **1159** | **work_items_update bypasses state machine validation** | **low** | **2** | **opus** | **goal** |
| **1158** | **work_items schema migration versioning** | **low** | **2** | **opus** | **goal** |
| **1157** | **WorkItemDb construction error boundary** | **low** | **2** | **opus** | **goal** |
| **1153** | **Migrate work-items local types to core** | **low** | **2** | **opus** | **filler** |
| **1167** | **Jira Issues provider** | **medium** | **2** | **opus** | **goal** |
| **1168** | **Asana Tasks provider (spike)** | **medium** | **3** | **opus** | **goal** |
| **1189** | **Wire work item tracker into sprint skill** | **low** | **3** | **opus** | **goal** |
| **1173** | **Docs: SKILL.md + README.md update** | **low** | **3** | **sonnet** | **filler** |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1181, #1176, #1182, #1179, #1154

#1181 is the CI blocker — bun test exits 1 on Linux despite 0 failures. #1187 + #1188 are the work item tracker integration gaps — track doesn't resolve PRs and poller doesn't fire on add. These must land before #1189 (sprint skill wiring). Rest is independent cleanup: clone tests, frontmatter fix, lint rule, install.sh fix.

### Batch 2 (backfill — 5 issues)
#1159, #1158, #1157, #1153, #1167

Work item tracker bugs (#1159, #1158, #1157, #1153) are all small independent fixes. #1167 (Jira provider) is a feature — implements the same `RemoteProvider` interface as Confluence. Asana server is configured here so Jira should work similarly.

### Batch 3 (backfill — 2 issues)
#1168, #1173

Asana spike — we have an Asana server configured (SSE, 44 tools). Explore the API surface and implement a provider. #1189 wires the tracker into the sprint skill (depends on #1187 + #1188 from batch 1). Docs update is a sonnet filler.

## Context

Sprints 28-29 shipped a lot: work item tracker (all 3 phases), mcx clone, auto-update. This sprint stabilizes it all — CI blocker, missing tests, bug fixes, schema hardening. The Jira and Asana providers extend the clone ecosystem while the core stabilizes.
