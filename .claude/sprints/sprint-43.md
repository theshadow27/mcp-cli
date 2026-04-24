# Sprint 43

> Planned 2026-04-23 23:45 local. Target: 18 PRs (6 Phase 2 hardening + 5 Phase 3 kickoff + 4 sites polish + 3 phase-5 foundations).

## Goal

**Harden Monitor Phase 2 + kick off Phase 3 CopilotPoller + land Phase 5 foundations.** Sprint 42 shipped Phase 2 end-to-end but generated a cluster of follow-ups (#1666 race, #1667 reconciliation, #1691 persistence, #1696/#1698/#1700 cascadeHead polish) that need to land before Phase 3 consumes the infrastructure. Simultaneously open Phase 3 with #1578 CopilotPoller + #1579 four-surface review coverage, and unblock Phase 5 with #1583/#1584 (cross-thread alias runtime + waitForEvent). Filler: sites validation polish carried over from sprint 42's Copilot-thread cleanup.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1578** | CopilotPoller for inline review comments with diff tracking | high | 1 | opus | P0 monitor Phase 3 — unblocks #1579 |
| **1583** | cross-thread runtime for defineMonitor | high | 1 | opus | P0 monitor Phase 5 — unblocks aliases-as-monitors |
| **1691** | persist ciRunStates to SQLite | high | 1 | opus | P0 monitor — sprint 42 deferred |
| **1666** | pr.merged derive silently dropped when work item created after event | high | 1 | opus | P0 monitor — real race bug |
| **1667** | startup reconciliation for work items stuck in qa after crash/downtime | high | 1 | opus | P0 monitor — recovery story |
| **1584** | waitForEvent(ctx, filter) helper for phase scripts and aliases | medium | 1 | sonnet | Phase 5 companion |
| 1579 | poll PR reviews, top-level PR comments, issue comments (4th surface) | high | 2 | opus | monitor Phase 3 — deps: #1578 |
| 1696 | cascadeHead emitted on non-actionable transitions | medium | 2 | sonnet | sprint 42 follow-up |
| 1698 | updatedAt epoch fallback permanently wins FIFO | medium | 2 | sonnet | sprint 42 follow-up |
| 1700 | ciRunStates map leaks stale entries when prNumber cleared | medium | 2 | sonnet | sprint 42 follow-up |
| 1688 | backfill path does not apply session.response/responseTail gating | medium | 2 | sonnet | monitor — security tail |
| 1544 | in-process MailServer.insertMail() does not publish monitor events | medium | 2 | sonnet | monitor completeness |
| 1582 | defineMonitor alias contract and metadata extraction | medium | 2 | sonnet | Phase 5 — deps: after #1583 lands branch |
| 1678 | validate browser.profileDir is absolute or ~/-prefixed | low | 3 | sonnet | sites polish — sprint 42 follow-up |
| 1677 | chromeProfile must reject path separators and .. segments | low | 3 | sonnet | sites polish — sprint 42 follow-up |
| 1705 | assign browser only after eng.start() succeeds in loadBrowser | low | 3 | sonnet | sites polish — sprint 42 follow-up |
| 1656 | upgrade actions/upload-artifact to v5+ | low | 3 | sonnet | CI maintenance |
| 1672 | add coverage for publishCoalesced / flushCoalesced / disposeCoalescer | low | 3 | sonnet | test coverage — primitive from #1574 |

## Batch Plan

### Batch 1 — P0 anchors (immediate, 6 picks)
#1578, #1583, #1691, #1666, #1667, #1584

5 opus anchors + 1 sonnet companion. #1578 is the Phase 3 Entry; #1583 opens Phase 5; #1691 closes the SQLite-persistence follow-up we intentionally deferred from #1577; #1666 and #1667 are real race/recovery bugs discovered during sprint 42 integration. #1584 is a sonnet helper that companions #1583.

### Batch 2 — Phase 3 second wave + monitor hardening (7 picks)
#1579, #1696, #1698, #1700, #1688, #1544, #1582

#1579 depends on #1578 landing. #1696/#1698/#1700 are cascadeHead and ciRunStates polish from sprint 42's #1581/#1577 reviews. #1688 closes a backfill-gating gap that was flagged pre-existing during sprint 42. #1544 is standalone completeness. #1582 can parallel once #1583's branch exists.

### Batch 3 — Sites polish + CI + tests (5 picks)
#1678, #1677, #1705, #1656, #1672

Four of these are direct follow-ups from sprint 42 reviews (Copilot threads whose fixes were tracked as follow-ups). #1656 closes a Node 20 deprecation warning filed during sprint 42's #1621 QA. #1672 adds test coverage for the CoalescingPublisher we shipped.

## Dependency graph

```
#1578 (CopilotPoller) — blocks #1579
#1583 (defineMonitor runtime) — blocks #1582
#1574 (CoalescingPublisher, shipped sprint 42) — consumed by #1672 tests
#1577 (ci events, shipped sprint 42) — consumed by #1691, #1700
#1576 (pr enrich, shipped sprint 42) — consumed by #1696
All P0 anchors: independent of each other (can run in parallel)
```

**Hot-shared file watch:**

- `packages/daemon/src/github/ci-events.ts` — #1691, #1700 both modify. Serialize: **#1691 first** (adds DB persistence → wider change surface), rebase #1700 after.
- `packages/daemon/src/github/cascade-head.ts` — #1696 and #1698 both touch. Serialize: **#1696 first** (filter at emission site), then #1698 (ordering tiebreak at selection site).
- `packages/daemon/src/github/work-item-poller.ts` — #1666, #1667, #1700, plus #1578 (CopilotPoller integration). Heavy contention zone. Serialize: **#1666 first** (adds pending-derive retry queue), **#1667 second** (startup scan), **#1700 third** (Map cleanup), **#1578 last** (CopilotPoller hooks into the polling loop). Accept rebase cost — we cannot parallel these safely.
- `packages/daemon/src/claude-session/ws-server.ts` — #1583 adds defineMonitor runtime. No conflicts planned.
- `packages/daemon/src/ipc-server.ts` — #1688 (backfill gating) — solo touch, no conflicts.
- `packages/daemon/src/site/browser/playwright.ts` + site-worker.ts — #1677, #1678, #1705 each modify different functions. Safe parallel.

## Excluded (with reasons)

- **Monitor Phase 4 (#1580, #1581)** — MERGED sprint 42 (#1658, #1679). Do not re-pick.
- **Monitor Phase 6 (#1585, #1586, #1587)** — still gated on Phase 3 + #1574 consumers. Sprint 44+.
- **VFS/clone cluster (#1262, #1263, #1277, #1279, #1280)** — arc stalled ~4 sprints. Needs dedicated sprint or deprioritize. Skip again.
- **Sites — #1459 session-header staleness, #1540 OWA BaseFolderId, #1595 cookie auth, #1599 proxy 401** — medium-to-large scope; save for sprint 44 with a sites-focus theme.
- **Orchestration — #1250 cross-repo sprint rebuild, #1365 worktree-shim probes, #1395 pollMailUntil dedup, #1510 scoped GH_TOKEN, #1525 aliasState validate** — low priority, not blocking current work. Sprint 44 if capacity.
- **CLI polish — #1518 --help on subcommands, #1550 agent-tools name/message, #1602 slim builds, #1603 mcx agent claude ls cwd hint, #1605/#1606/#1607/#1608/#1609 `mcx agent claude` UX** — valuable but mostly independent polish. Bundle opportunity in a dedicated "CLI DX sprint" later.
- **Permissions follow-ups (#1702 combined wildcards + arg patterns, #1703 bare `mcp__server`)** — nice enhancements on top of shipped #1695/#1701. Bundle for a future permissions-focus mini-sprint.
- **Tests — #1660 session.idle integration, #1681 session.result integration, #1693 onCiEvent integration, #1683 /events invalid-pr leak** — all test-only, bundle later.
- **Sprint 42 follow-ups not picked** — #1692 (superseded by #1700), #1697 (merged), #1682 (superseded by #1668), #1671 (duplicate default site, low-impact), #1687/#1689 (containment tests, cwd edge cases), #1647/#1646/#1645 (sites install polish), #1634 (Bun.sleep comment), #1686/#1673/#1633/#1632 (check-test-timeouts lint extensions — bundle later), #1684 (agent_sessions.repo_root canonicalize — bundle with other repoRoot work). All low-priority.

## Risks

- **#1578 scope is the sprint's largest unknown.** CopilotPoller is new infrastructure (~400-500 lines estimate), adds a polling loop tied to inline-review GraphQL pagination, needs diff tracking between polls. If it stalls, the sprint can still hit 12-14 PRs without it, but Phase 3 kickoff slips a sprint. Plan fallback: split into #1578a (poller + in-memory diff) and file #1578b (persistence) as a follow-up if scope grows.
- **#1583 may hit the same "every startDaemon adds a subscriber" class as #1580 did.** Implementer must store subscription IDs and expose `dispose()` on the first commit — not a follow-up. Added to impl prompt notes.
- **#1666 atomicity.** The fix needs to correctly reconcile: work-item created AFTER pr.merged event fires. Simplest: on work-item-creation, check event log for recent pr.merged on its branch + re-derive. Watch for: infinite loops if derive publishes another pr.merged (shouldn't, but defensive depth cap helps).
- **Follow-up debt still real.** Sprint 42 filed 13 follow-ups, 0 resolved same-sprint. Sprint 43 pulls 9 of those back in (#1691, #1666, #1667, #1696, #1698, #1700, #1688, #1678, #1677, #1705, #1656) — that's healthy but the generation rate hasn't slowed. Track whether sprint 43's follow-ups stabilize or grow.
- **Work-item-poller.ts serialization.** Four picks touch it. If batch 2 stalls, the whole poller chain backs up. Mitigation: do not spawn #1578 before #1666/#1667 PRs are at least pushed — use `mcx phase run impl --work-item '#1578' --dry-run` first to check ordering.
- **Quota.** Sprint 42 consumed two 5h blocks for 21 PRs. With 5 opus anchors in Batch 1 and #1578 being the biggest solo pick, sprint 43 may need similar budget. Plan: if 5h utilization ≥80% after Batch 1 anchors push, defer Batch 3 sites-polish picks to sprint 44.

## Retro rules applied from sprint 42

1. **Near quota reset, fire for effect.** Don't hold impl work at 80%+ if reset is <15 min away; see `.claude/memory/feedback_quota_end_of_block.md`.
2. **Force-update `work_items.phase` after every `mcx phase run`.** The `approved: X → Y` output doesn't persist phase state — orchestrator must `work_items_update {phase, force, forceReason}` after each transition. File an issue to fix this in the phase engine (carryover from sprint 42 retro "What didn't work").
3. **Pre-flight Copilot-thread sweep before QA spawn.** Implement skill should `gh api /pulls/{n}/comments` after push and either reply or document dismissal in the PR body. Saves round-1-qa:fail burn.
4. **`mcx phase install` after every main-merge of a phase change.** The lockfile drifts as soon as a `.claude/phases/*.ts` change merges. Add to the per-tick loop: if the next phase run fails with "HASH MISMATCH", run `mcx phase install` automatically and retry.
5. **`--from <phase>` is mandatory for repair↔qa transitions.** `mcx phase run qa --work-item '#N'` without `--from` reads the last transition-log entry as the "from" and rejects valid transitions. Either always pass `--from`, or document it as required in the orchestrator loop.
6. **Reviewer self-repair saves opus cycles.** If findings are 1-3 contained edits with file:line + concrete fixes, `send` the reviewer back rather than spawning a fresh opus repair. Saved ~$60-80 across sprint 42.
7. **`bye` carefully.** Sprint 42 had one case where the main checkout ended up on a PR branch after session bye. Add a post-bye invariant check: `git -C $MAIN_CHECKOUT branch --show-current` must equal `main` before spawning next session.

## Context

Sprint 42 shipped v1.7.2 — 21 PRs, the entire monitor Phase 2 core + sites stability cluster + CI concurrency unblock. Phase 2 generated 13 follow-ups (9 sites or monitor-adjacent) and the Phase 3 CopilotPoller remains the next big piece. Sprint 43 sits at the intersection of "harden what Phase 2 shipped" and "open Phase 3 + unblock Phase 5." If the sprint hits 18 PRs, the monitor epic drops from ~40% of open issues to ~30% — meaningful progress toward wrapping the epic in sprints 44-45.
