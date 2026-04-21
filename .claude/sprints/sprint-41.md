# Sprint 41

> Planned 2026-04-21 12:40 local. Target: 18 PRs (4 P0 anchors + 6 Phase 1 closeout + 2 OAuth + 6 filler).

## Goal

**Close out monitor Phase 1 + kill the infra blockers.** Land the cross-thread EventBus bridge (#1567) so Phase 2+ is unblocked, fix the CI trigger gap (#1506) that stalled sprint 40 twice, fix the browser blank-tab P0 (#1588), and end the 3-sprint `mcx gc` recurrence (#1398). Fill remaining capacity with the Phase 1 bug bundle and OAuth repair.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1506** | CI `pull_request` trigger gap on force-push | high | 1 | opus | P0 infra |
| **1567** | cross-thread EventBus bridging (worker→main) | high | 1 | opus | P0 monitor |
| **1588** | sites: browser opens blank tab — no auto-navigate | medium | 1 | opus | P0 sites |
| **1398** | mcx gc `_acp` daemon-unreachable recurrence | high | 1 | opus | P0 recurring |
| **1517** | OAuth DCR no-port redirect_uri breaks interactive auth | high | 2 | opus | OAuth |
| **1548** | auto-retry authorize 500 with forced DCR refresh | medium | 2 | sonnet | OAuth |
| **1570** | wire EventBus to IPC live stream + fix seq incompat | medium | 2 | opus | monitor Phase 1 |
| **1556** | GET /events has no backpressure (slow consumer = unbounded memory) | medium | 2 | sonnet | monitor Phase 1 |
| **1557** | subscriber not cleaned up on abrupt peer close | low | 2 | sonnet | monitor Phase 1 |
| **1539** | done phase reports merge_failed when PR merged on GitHub | low | 2 | sonnet | orchestration |
| **1522** | triage phase fails with "(initial) → triage" | low | 3 | sonnet | orchestration |
| **1530** | ban setTimeout in *.spec.ts files via lint | low | 3 | sonnet | filler (CI) |
| **1559** | handle EPIPE on stdout (`mcx monitor \| head`) | low | 3 | sonnet | filler (monitor) |
| **1566** | add `mcx monitor` to printUsage + completions | low | 3 | sonnet | filler (trivial) |
| **1569** | mail-events.ts comment references non-existent fn | low | 3 | sonnet | filler (trivial) |
| **1564** | buildEventFilter rejects all when `?pr=abc` (NaN) | low | 3 | sonnet | filler (monitor) |
| **1571** | `pr` query param NaN guard (server-side) | low | 3 | sonnet | filler (monitor) |
| **1250** | sprint wind-down rebuild breaks cross-repo sprints | low | 3 | sonnet | filler (deferred) |

## Batch Plan

### Batch 1 — P0 anchors (immediate)
#1506, #1567, #1588, #1398

All four are opus. #1506 is investigate-heavy (may close without code if GitHub-side). #1567 is the gatekeeper for all Phase 2+. #1588 has root cause + fix laid out in the issue body. #1398 needs a regression test before the fix.

### Batch 2 — OAuth + monitor Phase 1 closeout (backfill)
#1517, #1548, #1570, #1556, #1557, #1539

#1570 blocks #1558 (deferred to sprint 42 if #1570 doesn't land). #1517 is the remaining Atlassian auth P0. #1539 is the done-phase false-alarm bug hit ≥3× in sprint 40.

### Batch 3 — Fillers (backfill)
#1522, #1530, #1559, #1566, #1569, #1564, #1571, #1250

All low-scrutiny sonnet picks. #1564 and #1571 are the same bug class at two call sites — can be bundled into one PR if the implementer sees it. #1250 deferred from sprint 40.

## Dependency graph

```
#1567 (cross-thread bus) — blocks Phase 2 entirely; no intra-sprint deps
#1570 (seq wire-up) — blocks #1558 (deferred)
#1506 (CI trigger) — no code deps; unblocks QA reliability
#1517 → #1548 loosely (DCR fix first, then retry logic)
#1564 / #1571 — same bug class, can bundle or parallel
All fillers: independent
```

**Hot-shared file watch:**
- `packages/daemon/src/ipc-server.ts` — #1556, #1557, #1570, #1571 all touch this file. Serialize: #1570 first (largest), then #1556/#1557 (can parallel — different functions), then #1571 last (tiny NaN guard).
- `packages/daemon/src/claude-session-worker.ts` — #1567 rewrites the EventBus wiring here. No other picks touch it.

## Excluded (with reasons)

- **Phase 1 issues needing #1570 first:** #1558 (since-400 → since-backfill), #1572 (backfill integration test), #1573 (filter pushdown). Deferred until #1570 merges — sprint 42 if not.
- **Phase 1 test-only issues:** #1527 (openEventStream client tests), #1565 (--timeout integration test). Low value without the bus bridge (#1567) shipping first.
- **Phase 1 feature issues:** #1560 (--until glob), #1561 (nonzero exit), #1563 (--repo flag). Polish, not P0.
- **Phase 1 minor bugs:** #1528 (heartbeat 2× interval), #1544 (MailServer.insertMail publish), #1568 (phase param). Deferred to sprint 42 Phase 1 tail.
- **Orchestration cleanup:** #1524, #1525, #1531 — all real but not blocking. Sprint 42.
- **Stalled arcs:** VFS/clone (#1262 cluster) — formally deferred to sprint 42 per arcs.md.
- **Sprint 40 deferred:** #1361+#1319 (JSDoc bundle) — keeps getting bumped; include in sprint 42 if capacity.
- **Monitor Phase 2+:** not ready until #1567 ships. Sprint 42.
- **#1589** (backfill memory safety) — architectural, better after #1570 lands.

## Risks

- **#1506 may be GitHub-side.** If the `pull_request` event drop is an Actions platform bug (no webhook delivery at all), there's no code fix — only the `gh workflow run` workaround. Sprint 41 orchestrator should budget for this and use the workaround documented in arcs.md without burning hours investigating.
- **#1567 scope.** Cross-thread bridging in Bun workers (separate V8 isolates, no shared memory) requires `postMessage` forwarding. Could be clean (30-line bridge) or messy (serialization overhead, back-pressure across the thread boundary). Cap at 1 day; if it's messy, file a design spike and defer Phase 2.
- **ipc-server.ts contention.** 4 picks touch it. Batch 2 serialization plan above mitigates, but rebases are likely. Sprint 40's #1513 rebase pain is fresh — land #1570 first, rebase others before pushing.
- **Quota.** Sprint 40 hit 100% 5h twice. 4 opus anchors in batch 1 will burn fast. Consider staggering: spawn #1506 + #1567 first, #1588 + #1398 after first pair returns.

## Context

Sprint 40 shipped v1.7.0 (17 merged + 1 dup-closed = 18 resolved against target 20). The entire monitor Phase 1 core landed (#1511, #1512, #1513, #1514, #1515) but generated 20+ follow-up issues from adversarial review — the Phase 1 bug bundle. Sprint 40's pain points: CI trigger gap (#1506) cost ~3 hours across #1513/#1515 QA rounds, quota pauses (2 full stops), and rebase conflicts between parallel epic PRs.

CI trigger workaround valid until #1506 fix:
```
gh workflow run ci.yml --ref <branch-name>
```
