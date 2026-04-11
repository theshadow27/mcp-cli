# Sprint 31

> Planned 2026-04-11 11:30. Target: 15 PRs.

## Goal

Orchestrator DX (named sessions, bye friction) + VFS provider hardening

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1207** | **Human-readable session names** | **medium** | **1** | **opus** | **P1 goal** |
| **1208** | **mcx claude bye requires a message** | **low** | **1** | **opus** | **P1 goal** |
| **1205** | **unwrapToolResult ignores isError** | **low** | **1** | **opus** | **goal** |
| **1203** | **vfs.spec.ts for CLI wrapper** | **low** | **1** | **opus** | **goal** |
| **1169** | **Confluence page delete doesn't work** | **low** | **1** | **opus** | **goal** |
| **1183** | **Unit tests for clone/pull/push engines** | **medium** | **2** | **opus** | **goal** |
| **1166** | **GitHub Issues provider** | **medium** | **2** | **opus** | **goal** |
| **1170** | **VFS first-run setup and error handling** | **medium** | **2** | **opus** | **goal** |
| **1206** | **core.bare=true recurrence** | **low** | **2** | **opus** | **goal** |
| **1210** | **git-remote-mcx: protocol engine** | **medium** | **2** | **opus** | **goal** |
| **1178** | **--depth flag for shallow clone** | **low** | **3** | **opus** | **goal** |
| **1164** | **Lightweight usage analytics** | **medium** | **3** | **opus** | **filler** |
| **299** | **W3C span hierarchy** | **low** | **3** | **opus** | **filler** |
| **295** | **Virtual _tracing MCP server** | **low** | **3** | **opus** | **filler** |
| **1004** | **Compile Bun segfault data** | **low** | **3** | **sonnet** | **filler** |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1207, #1208, #1205, #1203, #1169

The orchestrator DX issues (#1207, #1208) are the sprint's primary thesis — they came directly from the sprint 30 retro. #1205 (unwrapToolResult) is a data-loss risk in the new Asana/Jira providers. #1203 (vfs.spec.ts) and #1169 (Confluence delete) round out VFS hardening.

### Batch 2 (backfill — 5 issues)
#1183, #1166, #1170, #1206, #1172

More VFS: clone engine tests (#1183), GitHub Issues provider (#1166, new feature), first-run UX (#1170). #1206 (core.bare) may already be fixed by the .gitignore change — the session should verify first. #1210 (git-remote-mcx protocol engine) is the foundation for the git-remote-mcx epic (#1209) — pure logic, stdin parser + capability handler, no wiring dependencies. Lands first so #1211/#1212 can parallelize in sprint 32.

### Batch 3 (backfill — 5 issues)
#1178, #1164, #299, #295, #1004

Remaining VFS feature (--depth), observability features (analytics, tracing), and the long-standing Bun segfault data collection task (sonnet — just needs to compile existing crash reports).

## Context

Sprint 30 shipped 12 PRs in 48 minutes including Jira and Asana VFS providers. The retro's main finding was that the orchestrator treats spawned sessions as disposable function calls instead of team members. #1207 and #1208 add tooling friction to fight that pattern. The VFS providers need hardening before they're production-ready — error handling, tests, and the delete bug.

## Excluded

- **#1211, #1212, #1213, #1214, #1215** (git-remote-mcx follow-ups) — depend on #1210 landing first. Planned for sprint 32.
- **#328** (event-driven orchestration via Stop hook) — depends on #342 (sequence cursors), needs design.
- **#935** (agent profiles) — needs clarification on use cases.
- **#698** (shared alias registry) — deferred, no urgency.
- **#100** (defineAlias epic) — long-standing, needs breakdown.
