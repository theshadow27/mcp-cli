# Sprint 24

> Planned 2026-04-08 06:00. Target: 8 PRs. Short sprint — focused on P1 OAuth fix.

## Goal

Fix OAuth scope (P1 customer blocker) + DX quick wins from session survey

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1076** | **OAuth: send scope parameter (breaks Atlassian)** | **high** | **1** | **opus** | **P1 goal** |
| 1075 | Wire parsePythonRepr into mcx call output | low | 1 | opus | goal |
| 1072 | mcx <server-name> fallthrough to mcx call | low | 1 | opus | goal |
| 1073 | Command synonyms (aliases, save, find, etc.) | low | 1 | opus | filler |
| 1074 | mcx auth --help parsed as server name | low | 1 | opus | filler |
| 1062 | Expand ~ in @file paths | low | 2 | opus | filler |
| 1064 | Show quota warning banner in mcx claude ls | low | 2 | opus | filler |
| 1063 | Check quota_status before spawning in sprint | low | 2 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 issues)
#1076, #1075, #1072, #1073, #1074

#1076 is P1 — OAuth with Atlassian (and likely others) is completely broken without scope. Match mcp-remote's behavior: default fallback "openid email profile", support scope in server config, read scopes_supported from discovery metadata. The rest are DX quick wins from the session survey.

### Batch 2 (backfill — 3 issues)
#1062, #1064, #1063

Tilde expansion, quota banner, and quota-aware sprint spawning.

## Context

#1076 is a customer-facing blocker — anything that works with mcp-remote should work with mcpd. The session survey (#1072-1075) found high-frequency DX issues that Claude hits repeatedly.
