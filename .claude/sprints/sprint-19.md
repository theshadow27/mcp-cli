# Sprint 19

> Planned 2026-03-19 00:45. Started 2026-03-19 01:00. Completed 2026-03-19 06:00. Result: 15/15 merged.

## Goal

ACP integration completion + OpenCode provider + distribution prep — clear the path to v1.0

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **884** | **CI build failure — ModuleNotFound for dist/index.js** | **low** | **1** | **opus** | **goal** |
| **882** | **Daemon-side _acp virtual server for ACP sessions** | **medium** | **1** | **opus** | **goal** |
| 878 | Wrong installHint for gemini agent | low | 1 | opus | goal |
| 504 | Implement OpenCode agent provider | high | 1 | opus | goal |
| 36 | Set up npm publishing for bun add -g | low | 1 | opus | goal |
| 505 | mcx opencode CLI commands + orchestrator integration | medium | 2 | opus | goal |
| 883 | Skills --provider flag for ACP agent routing | low | 2 | opus | goal |
| 37 | Create homebrew tap repo and release automation | low | 2 | opus | goal |
| 104 | Alias composition — typed cross-alias calls | medium | 2 | opus | goal |
| 115 | HTTP/SSE transport mock server integration tests | low | 2 | opus | goal |
| 79 | mcx update — check for version updates | low | 3 | opus | goal |
| 41 | SSE endpoint for streaming daemon logs | medium | 3 | opus | goal |
| 113 | Auto-discover OAuth servers from Claude Code keychain | medium | 3 | opus | filler |
| 12 | Notes system: per-tool annotations | low | 3 | opus | filler |
| 690 | Reduce total test suite wall time below 25s | medium | 3 | opus | filler |

## Batch Plan

### Batch 1 (P1 CI fix + ACP integration + OpenCode + npm)
#884, #882, #878, #504, #36

#884 ships first — CI is broken, blocks all future releases. #882 completes ACP integration (daemon-side virtual server like _claude/_codex). #878 is a quick bug fix. #504 is the big one — OpenCode provider follows the same pattern as ACP (spike already validated in #503). #36 sets up npm publishing.

### Batch 2 (OpenCode CLI + ACP routing + homebrew + alias composition + tests)
#505, #883, #37, #104, #115

#505 depends on #504 (OpenCode provider). #883 adds provider routing for skills. #37 creates the homebrew tap. #104 deepens defineAlias with typed cross-alias calls. #115 fills the HTTP/SSE transport test gap.

### Batch 3 (DX features + test perf + filler)
#79, #41, #113, #12, #690

Distribution DX (#79 update command). Observability (#41 SSE log streaming). Auth (#113 OAuth auto-discover). DX (#12 notes system). Test perf (#690 wall time target).

## Context

Sprint 18 shipped the ACP agent provider (packages/acp/), Agents tab, and `mcx acp/copilot/gemini` commands. Third consecutive clean sweep (46 PRs across Sprints 16-18). v0.10.0 released.

The ACP provider is functional but incomplete — needs a daemon-side virtual server (#882) and the Gemini install hint is wrong (#878). OpenCode spike (#503) was validated in Sprint 17; implementation follows the same `AgentSession` pattern.

**v1.0 target: Sprint 20.** This sprint clears the path by:
- Completing both agent providers (ACP + OpenCode)
- Setting up distribution (npm + homebrew)
- Closing the defineAlias epic arc (#104 is the last major child)
- Filling remaining test gaps

After Sprint 19, the board should be ~14 issues: TUI features (#82, #81, #85), tracing (#299, #295), event-driven orchestration (#328), auto-update (#699), and epic trackers. Sprint 20 can close epics, polish, and tag v1.0.

Issues considered but excluded:
- #517 (ACP epic) — close after #882 lands, not a code issue
- #502 (OpenCode epic) — close after #504/#505 land
- #100 (defineAlias epic) — close after #104 lands
- #880 (ACP tracking) — tracking issue, close when integration done
- #577 (Bun segfault) — upstream, can't fix
- #328 (event-driven orchestration) — high value but defer to Sprint 20
- #299/#295 (tracing) — defer to Sprint 20
- #699 (auto-update) — large, defer to Sprint 20
- #82/#81/#85 (TUI features) — defer to Sprint 20
- #698 (shared alias registry) — defer to post-1.0
