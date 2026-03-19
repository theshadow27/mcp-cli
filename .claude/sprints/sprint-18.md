# Sprint 18

> Planned 2026-03-18 07:00. Started 2026-03-18 09:30. Completed 2026-03-19 00:15. Result: 15/15 merged.

## Goal

ACP implementation + Agents tab + operational polish

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **519** | **Implement ACP agent provider** | **high** | **1** | **opus** | **goal** |
| **862** | **Rename Claude tab to Agents — show Claude + Codex sessions** | **medium** | **1** | **opus** | **goal** |
| 857 | Resolve copilot binary — try standalone then fall back to gh copilot | low | 1 | opus | goal |
| 837 | Sessions stuck in connecting after daemon auto-start | medium | 1 | opus | goal |
| 835 | mcx claude ls should auto-start daemon | low | 1 | opus | goal |
| 520 | mcx acp + mcx copilot/gemini CLI commands | medium | 2 | opus | goal |
| 864 | Warn when dist/ binaries are stale relative to source | low | 2 | opus | goal |
| 833 | release.ts reformats package.json, breaking lint | low | 2 | opus | goal |
| 855 | wrapTransportError: SDK wraps system errors | low | 2 | opus | goal |
| 852 | Alias executor uses stub cache on daemon path | low | 2 | opus | goal |
| 842 | Investigate: daemon idle timer fires late under CPU contention | medium | 3 | opus | goal |
| 861 | tsc --noEmit fallback validation for freeform aliases | low | 3 | opus | goal |
| 849 | Add mcx add-from-claude-desktop to README | low | 3 | sonnet | filler |
| 117 | Test: error scenario edge cases (expired auth, IPC timeout) | low | 3 | opus | filler |
| 116 | Test: concurrent operation edge cases (reload race, connecting state) | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (ACP provider + Agents tab + operational fixes)
#519, #862, #857, #837, #835

#519 is the big one — full ACP agent provider implementation. The spike (#518) validated the protocol; now build the real `packages/acp` with `AgentSession` interface. #862 renames the Claude tab to Agents, showing both Claude and Codex sessions. #857 fixes copilot binary resolution (day-1 blocker from the spike). #837 and #835 are operational fixes from Sprint 17 findings.

### Batch 2 (ACP CLI commands + DX fixes)
#520, #864, #833, #855, #852

#520 depends on #519 (ACP provider must exist first). #864 (stale binary warning) and #833 (release lint) are from Codex retro. #855 and #852 are bug fixes.

### Batch 3 (investigation + alias DX + test coverage)
#842, #861, #849, #117, #116

Investigation of daemon idle timer root cause (#842). Alias validation improvement (#861). Documentation (#849). Two old test coverage issues (#117, #116) from the pre-v1 backlog.

## Context

Sprint 17 achieved a second consecutive clean sweep (16/16). ACP spike (#518) validated the protocol end-to-end — `gh copilot --acp` works with Bun, SDK is viable. Codex protocol fix (#851) landed — `mcx codex spawn` now works. OpenCode spike (#503) also validated.

The ACP implementation is the natural next step. The spike found (all validated, #518 merged):
- Binary is `gh copilot`, not standalone — #857 filed
- `session/new` requires `mcpServers: []`
- Streaming works: `session/update` field is `params.update.sessionUpdate` (not `params.updateType`)
- Update types seen: `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk`
- `session/cancel` works but Copilot returns `end_turn` not `"cancelled"` as stop reason — use a state flag, not stop reason, to detect cancellation
- `@agentclientprotocol/sdk@0.16.1` works with Bun; `ndJsonStream` needs a `WritableStream` wrapper around Bun's `FileSink` (proc.stdin)
- No Node.js shims needed
- Token/cost info not in ACP messages

Key carry-forwards from Codex retro:
- #864 (stale binary warning) — agents need to know when dist/ is outdated
- #833 (release format) — every release breaks lint
- Partial branches need status markers (process, not code)

Issues considered but excluded:
- #504/#505 (OpenCode implementation) — do ACP first, then OpenCode follows the same pattern
- #699 (auto-update) — large, needs design
- #698 (shared alias registry) — large, needs #94 to stabilize first
- #328 (event-driven orchestration) — high value but high complexity
- #82/#81/#85 (TUI features) — save for TUI-focused sprint
- #113 (OAuth auto-discover) — complex auth work
- #299/#295 (tracing) — dedicated sprint
