# Sprint 44

> Planned 2026-04-24 12:14 EDT. Target: 15 PRs (6 orchestrator papercuts + 4 CopilotPoller hardening + 3 monitor follow-ups + 1 Phase 6 opener + 1 CLI DX).

## Goal

**Fix the orchestrator papercuts that burned ~$200 of tool calls across sprints 42+43, harden the CopilotPoller we just shipped, and open Phase 6 with `session.stuck`.** Sprint 43 retro surfaced a cluster of orchestration bugs (phase-state not persisted, bye lies about worktrees, gc can't delete squash-merged branches, `HASH MISMATCH` errors don't tell you what to do) that collectively tax every sprint. Meanwhile the sprint-43 CopilotPoller landing generated 4 focused follow-ups (#1734 403 handling, #1735 error clearing, #1736 seen_ids unbounded, #1738 perf) — we land the small ones now. One new Phase 6 event (`session.stuck`) opens the next arc without pulling in the full trio.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1745** | mcx phase run doesn't persist work_items.phase (~40 force_update calls/sprint) | medium | 1 | opus | **P0** orchestrator |
| **1748** | mcx gc can't delete squash-merged branches (0 of 85 per sprint) | medium | 1 | opus | orchestrator |
| **1585** | session.stuck event with lastTool, lastToolError, tokenDelta | medium | 1 | opus | monitor Phase 6 opener |
| **1518** | CLI: --help ignored on subcommands — needs top-level help dispatcher | medium | 1 | opus | DX — multi-file refactor |
| **1736** | CopilotPoller seen_comment_ids blob grows unbounded | medium | 1 | opus | monitor Phase 3 hardening |
| 1734 | CopilotPoller 403 conflated with rate-limit causes permanent backoff | low | 1 | sonnet | monitor Phase 3 hardening |
| 1680 | backfill path leaks session.response chunks without responseTail gating | low | 1 | sonnet | monitor Phase 2 follow-up |
| 1692 | ciRunStates.delete after emittedFinished causes re-emission loop | low | 1 | sonnet | monitor Phase 2 follow-up |
| 1671 | three-way profileDir error when two sites requested | low | 1 | sonnet | sites polish |
| 1714 | wire AbortSignal cancellation into waitForEvent (deferred from #1584) | low | 1 | sonnet | Phase 5 finish |
| 1697 | remove unused CiRunState import in ci-events.spec.ts | low | 1 | sonnet | trivial cleanup |
| 1744 | evalBundledJs timeout error message misleadingly specific | low | 1 | sonnet | DX — error message |
| 1747 | mcx phase run: better error message when .mcx.lock is out of date | low | 2 | sonnet | orchestrator — **deps: #1745 (phase.ts)** |
| 1749 | mcx claude bye: "Removed worktree" message is a lie | medium | 2 | opus | orchestrator — **deps: #1748 (worktree-shim.ts)** |
| 1718 | ring-buffer heartbeat events bypass waitForEvent client skip | low | 2 | sonnet | monitor Phase 5 follow-up — **deps: #1680 (ipc-server.ts)** |

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": create **one TaskCreate per issue** with the `addBlockedBy` edges listed below. Batches are the planner's mental model for what launches immediately vs. what waits on a rebase.

### Batch 1 — 12 unblocked picks (start immediately, stagger the opus anchors)
#1745, #1748, #1585, #1518, #1736, #1734, #1680, #1692, #1671, #1714, #1697, #1744

5 opus + 7 sonnet. #1745 is the P0 anchor. #1748 and #1749 are a natural pair (gc fix + bye fix unblock the follow-up #1750 to flip bye defaults) but they serialize on `worktree-shim.ts`. #1585 opens Phase 6 with the simplest event (session.stuck) — #1586/#1587 stay deferred for a dedicated Phase 6 sprint. #1518 is a multi-file refactor; watch for contention if any other pick grows scope into `main.ts`.

### Batch 2 — 3 picks waiting on shared-file rebase
#1747, #1749, #1718

Each has one explicit `blockedBy` edge from a Batch 1 pick. They start as soon as the blocker merges, not when "Batch 1 is done" — classic blockedBy cascade.

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1747 blockedBy #1745** — both touch `packages/command/src/commands/phase.ts`. #1745 is the P0 and adds the `work_items_update` call after transition commit; #1747 rewrites the HASH MISMATCH error. Serialize to avoid rebase cost.
- **#1749 blockedBy #1748** — both touch `packages/core/src/worktree-shim.ts` (#1748 adds squash-merge detection to branch cleanup; #1749 fixes the "Removed worktree" silent-failure path). Serialize.
- **#1718 blockedBy #1680** — both touch `packages/daemon/src/ipc-server.ts` (#1680 adds responseTail gating to backfill loop; #1718 adds heartbeat skip to ring-buffer replay). Serialize.

## Hot-shared file watch

- `packages/command/src/commands/phase.ts` — #1745, #1747. Serialize via dependency edge above. Note: 4 other phase.ts picks (#1746, #1635, #1636, #1375) are **intentionally deferred** to reduce contention; pull them in sprint 45 after #1745 + #1747 land.
- `packages/daemon/src/github/copilot-poller.ts` — only #1734 this sprint. #1735 + #1738 deferred to sprint 45.
- `packages/daemon/src/ipc-server.ts` — #1680, #1718. Serialized.
- `packages/core/src/worktree-shim.ts` — #1748, #1749. Serialized.
- `packages/daemon/src/site-worker.ts` — only #1671 this sprint. #1707 deferred to sprint 45.
- `packages/core/src/monitor-event.ts` — only #1585 this sprint. #1586 + #1587 deferred to a dedicated Phase 6 sprint.
- `packages/daemon/src/db/state.ts`, `db/work-items.ts` — #1736 solo touch.

## Excluded (with reasons)

- **#1750 (bye default flip)** — explicitly blocked on #1748 + #1749. Title prefix `[BLOCKED on #1748 + #1749]`. Pull in sprint 45 after prerequisites merge.
- **#1746 (phase --from auto-detect)** — blocked on #1745; also "needs clarification" on exact repro per Explore. Pull after #1745 lands and we reproduce the failure mode cleanly.
- **#1735, #1738 (CopilotPoller)** — serialize behind #1734 on `copilot-poller.ts`. Sprint 45.
- **#1635, #1636, #1375 (phase.ts engine)** — serialize behind #1745 + #1747 on `phase.ts`. Sprint 45.
- **#1586, #1587 (Phase 6 events)** — share `monitor-event.ts` with #1585; pick in a dedicated Phase 6 sprint once #1585 validates the plumbing.
- **#1725 (MAIL_RECEIVED rename)** — breaking rename; needs downstream coordination; bundle with a future naming cleanup pass.
- **#1727 (matchFilter memoize)** — perf opt only, not correctness; low priority behind #1718.
- **#1707 (site-worker lock warnings)** — serialize behind #1671.
- **VFS/clone arc (#1209, #1262, #1263, #1277, #1279, #1280, #1281, #1311, #1312, #1323)** — stalled 5+ sprints; needs dedicated sprint or arc-level rethink.
- **Sites medium cluster (#1459 session-header staleness, #1540 OWA BaseFolderId, #1595 cookie auth, #1599 proxy 401)** — save for a sites-focused sprint.
- **Permissions follow-ups (#1702, #1703)** — batch with future permissions mini-sprint.
- **CLI agent polish (#1606, #1607, #1608, #1609)** — batch for a future CLI DX mini-sprint; #1518 is standalone enough to ship without them.

## Risks

- **#1745 is the P0.** If it doesn't land this sprint, every subsequent sprint continues paying the ~40-force_update-per-sprint tax. Mitigation: spawn opus first in Batch 1, no other phase.ts work until it merges (enforced by #1747's blockedBy edge).
- **#1748's squash-merge detection needs care.** The fix uses `gh api` to cross-check merged-PR head refs before `git branch -D`. Watch for: (a) offline/no-auth fallback path (must still refuse to -D without confirmation), (b) cache the per-run API call to avoid rate-limit burn, (c) integration test that simulates squash-merge via a fixture. If API integration grows scope, split into #1748a (safe refusal + clearer error) and file #1748b (squash-merge detection) as follow-up.
- **#1518 help dispatcher is a refactor**, not a feature. ~60 LOC across main.ts + subcommand files. Likely touches every `commands/*.ts` — if it grows beyond ~40 LOC per file, split it or accept high-scrutiny review. Implementer should ensure backwards compat: existing `--help` flag behavior on the main `mcx` command must not regress.
- **#1585 session.stuck requires a timer + state tracking per session.** New event, new wiring. Implementer must store subscription IDs and expose `dispose()` on the first commit (same lesson as #1583 sprint 43). Added to impl prompt notes.
- **#1736 cleanup logic is data-loss-risky.** The `seen_comment_ids` blob is consulted for dedup; a wrong cleanup could cause duplicate Copilot comments to re-fire. Integration test must verify dedup still holds after cleanup. Opus-tier scrutiny (already assigned).
- **Quota.** Sprint 43 consumed one 5h block (peak 84%) + part of a second for 16 PRs. Sprint 44 has 15 picks with 5 opus anchors — similar shape. Apply the `feedback_quota_end_of_block.md` rule: fire-for-effect near reset.

## Retro rules applied (carried forward + new)

Carried forward from sprint 43 retro:

1. **One TaskCreate per issue** with `addBlockedBy` edges — **not** Batch 1/2/3 grouping tasks. Now encoded in `plan.md` Step 4 + `run.md` Input (thanks to sprint 43 retro + skill fix at `98b0dbf7`).
2. **Near quota reset, fire for effect.** See `.claude/memory/feedback_quota_end_of_block.md`.
3. **Auto-chain run → review → retro by default** (skill fix `757e1f5a`). Sprint 44 runs with this mode unless invoked as `/sprint run 44`.
4. **Use Explore for candidate reconnaissance** — done during this plan (see board-overview at sprint start). New in `plan.md` Step 3a.
5. **Reviewer self-repair when findings are 1–3 contained edits** with file:line + concrete fixes. Saves opus repair cycles.
6. **QA gate on unreplied Copilot threads is now arithmetic** (meta fix `45a314d9`, closes #1716). If `UNREPLIED_COUNT > 0`, verdict is qa:fail, no exceptions. This should drop round-1 qa:fail rate significantly.

New rules observed during sprint 43 orchestration:

7. **Bundle small same-file fixes** is a future option but the complexity increase outweighs the ~2 PRs saved — skip for now. If a sprint has 3+ sub-10-LOC fixes on one file, revisit.
8. **`mcx claude wait` foreground with `timeout: 280000`** (Bash tool) preserves cache better than `run_in_background: true` + notification polling. Saved mid-sprint-43 after one cache cycle burned.

## Context

Sprint 43 shipped v1.7.3 — 16 PRs merged + 2 closed as already-done. The monitor epic is now ~25% of open issues (down from ~40%); Phase 3 (CopilotPoller + 4-surface polling) is landing in production. Three open meta follow-ups from sprint 43 wait here (#1745 P0, #1748, #1749) — this sprint pays them off. Phase 6 opens with its simplest event (#1585 session.stuck) so the next sprint has a validated plumbing base for the full 6-event set. CLI DX gets one targeted fix (#1518 --help) to demonstrate that non-monitor non-orchestration work still ships.
