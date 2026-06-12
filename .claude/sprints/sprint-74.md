# Sprint 74

> Planned 2026-06-12. Target: 15 PRs.

## Goal

Land #2805 — ContainmentGuard parity over the stdio transport — so stdio becomes usable as the sprint-session default, plus the stdio-lifecycle/stderr/containment hardening around it.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2805 | stdio spawns hard-refuse under containment (#2789 fail-closed); ContainmentGuard unreachable over stdio. Issue carries a hook-bridge design sketch — treat as **hypothesis**, spike-verify the 5 listed checks against the real binary first. **Artifact-flag.** | high | 1 | opus | goal |
| 2793 | stdio transport write failure leaves live child process after disconnectSession (zombie leak) | low-med | 1 | sonnet | goal |
| 2784 | inline disconnect postmortem can miss final stderr line (db:disconnected/db:stderr ordering) | low | 1 | sonnet | goal |
| 2707 | mcp__ prefix blanket-allow bypasses path containment for MCP tools with path args | medium | 1 | opus | goal |
| 2774 | child stderr persisted/re-emitted unsanitized — log-injection + ANSI poisoning surface | medium | 2 | opus | goal |
| 2708 | CONTAINMENT_SAFE_TOOLS allowlist drift wedges sessions on claude upgrade; containment_denied events flood monitor | low-med | 2 | sonnet | goal |
| 2800 | build smoke failurePattern over-matches non-worker servers → false-fail on required `build` gate. **Artifact-flag.** | low | 1 | sonnet | filler |
| 2781 | repair→qa transition blocked by hardcoded VALID_TRANSITIONS when repoRoot missing; manifest silently ignored | low | 2 | sonnet | filler |
| 2749 | mcx claude ls prints spurious "Error: git diff failed (exit null):" on stderr | low | 2 | sonnet | filler |
| 2786 | mock-only ws-server-stdio.spec lets invalid spawn-arg combos ship uncaught (sprint-72 canary repeat risk). Test the spawn surface #2805 lands. **Artifact-flag.** | medium | 3 | opus | goal |
| 2773 | stderr capture does unbatched synchronous SQLite writes per line — can wedge daemon event loop | low-med | 3 | sonnet | goal |
| 2795 | mechanize sendToSession return-discard guard as doing-it-wrong rule (#2790 follow-up) | low | 3 | sonnet | filler |
| 2761 | gate lease missing on pre-push TEST_CHANGED step — re-opens #2690 oversubscription | low | 3 | fable | filler |
| 2735 | parseModelFromSprintTable misses secondary issue in paired-# rows ("2693 (+2520)") | low | 3 | fable | filler |
| 2747 | tighten replay.spec.ts Phase-2 crash-test timeoutMs 3000→~200ms (dead headroom post-#2746) | low | 3 | fable | filler |

Scrutiny note (sprint-73 lesson): metric-based triage will likely route #2805/#2786/#2774/#2707 to QA-direct; the orchestrator should expect to **manually override to the plan's scrutiny** until #2804 mechanizes a scrutiny field.

## Batch Plan

### Batch 1 (immediate)
#2805, #2793, #2784, #2707, #2800
(#2800 promoted to batch 1: it de-flakes the required `build` gate that every PR in this sprint hits)

### Batch 2 (backfill)
#2774, #2708, #2781, #2749

### Batch 3 (backfill)
#2786, #2773, #2795, #2761, #2735, #2747

### Dependency edges (run phase: translate to addBlockedBy)

- #2774 blockedBy #2784 (abstract-worker-server.ts stderr/disconnect path — ordering fix lands before sanitization)
- #2773 blockedBy #2774 (same stderr persistence path — sanitize before batching)
- #2708 blockedBy #2707 (both edit packages/core/src/containment.ts)
- #2786 blockedBy #2805 (tests the final spawn-arg surface #2805 lands; shared ws-server-stdio.spec.ts)
- #2795 blockedBy #2786 (regression test also lands in ws-server-stdio.spec.ts)

### Hot-file rebase directive (not an edge)

#2805 and #2793 both start in batch 1 and share `ws-server.ts` (#2793 edits
disconnectSession; #2805 edits buildSpawnCmd + replaces the #2789 refusal).
#2805 is deliberately NOT blocked on #2793: its session starts with the spike
verifications + the `hook-eval` command (`packages/command/src/commands/agent.ts`
+ daemon IPC handler — no overlap), and only touches `ws-server.ts` last. When
#2793 merges, the orchestrator broadcasts to the #2805 session: "rebase onto
main and check ws-server.ts for conflicting/duplicate edits before opening
your PR."

## Context

Sprint 73 closed the stdio investigation (#2688) with a NO-GO verdict for contained stdio and merged the fail-closed refusal (#2789); #2805 is the gating item to lift it. The build/worker-resolution regression class got an interim fix (#2799 --root pin + smoke); the structural fix (#2801) and bun upstream (#2798) are deliberately deferred. Codex remains broken (#2482) — no codex routing. Fable is 4-for-4 over three sprints → 3 trivial low-scrutiny fable slots (#2761, #2735, #2747).

Risks: #2805 is a one-heavy-session critical path (~1.5–2h incl. spike); if the spike disproves the hook-bridge sketch, the acceptance shifts to "documented alternative + keep fail-closed" — that is an acceptable `needs-attention` outcome, not a failure. #2786/#2795 sit behind it and are droppable at wind-down.

## Closed at plan time (OBE by #2805 — user-directed)

- #2791 (resolveTransport grid-outage) — outage only existed because of the #2789 fail-closed refusal, which #2805 removes; wiring stdio becomes the cutover, not a trap. Closed wontdo.
- #2792 (stream_event canary / StuckDetector blindness) — the hook bridge's per-tool-call daemon ping is the stdio liveness signal; stream_event stops being load-bearing. Closed wontdo.
- Both reopen if the #2805 spike disproves the hook approach.

## Excluded (deliberately NOT this sprint)

- #2801 (embedded worker manifest), #2798 (bun upstream), #2797 (smoke-test isolation) — build arc deferred; #2799 interim fix holds
- #2780, #2760 (gate-lease hardening) — robustness, not blocking
- #2788 (coverage passthrough edge), #2727 (test tree-mutation), #2742 (DB cast guards), #2737 (phase findGitRoot), #2662 (worktree gc) — defer; #2742/#2662 are good batch-1 candidates for sprint 75
- Flakies #2783, #2770, #2383 — need nerd-snipe gates; no slots for investigation sessions this sprint given the heavy goal item
- #2482 codex — still broken, out
