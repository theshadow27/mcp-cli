# Sprint 42

> Planned 2026-04-23 20:31 local. Target: 20 PRs (7 Phase 2 monitor anchors + 5 sites stability + 4 infra/follow-ups + 4 phase-state polish).

## Goal

**Ship Monitor Phase 2 end-to-end + clear the sites stability wave.** With Phase 1 bridge merged in sprint 41 (#1567, #1570, #1556, #1557), Phase 2 payload enrichment (#1574, #1575, #1576, #1577) and the first derived-event rule (#1580, #1581) are unblocked and the next `mcx monitor` UX jump comes from landing them together. Simultaneously clear the post-teams-port sites bug backlog (#1592, #1594, #1597, #1598, #1600) so the `/sites` flow is production-stable. Infra P1 `#1621` (auto-merge blocked by concurrency-cancelled check-runs) ends the admin-merge crutch sprint 41 leaned on.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1574** | CoalescingPublisher primitive for per-key event windowing | high | 1 | opus | P0 monitor — unblocks #1577/#1581 |
| **1580** | daemon-side derived event publisher (pr.merged → phase.transition) | high | 1 | opus | P0 monitor Phase 2 |
| **1592** | sites: seed catalog/config/wiggle files not embedded in compiled daemon | high | 1 | opus | P0 sites infra |
| **1600** | sites: _site server dies on laptop sleep/wake and never recovers | high | 1 | opus | P0 sites |
| **1621** | CI: branch protection stays BLOCKED when concurrency-group cancels then succeeds | high | 1 | opus | P0 infra — ends admin-merge crutch |
| **1575** | enrich session.idle/result with cost, turns, tokens, resultPreview | medium | 1 | sonnet | monitor Phase 2 |
| **1576** | enrich pr events with commits, srcChurn, branch, base | medium | 1 | sonnet | monitor Phase 2 — blocks #1581 |
| 1577 | ci.started/running/finished with per-check conclusions and allGreen | medium | 2 | opus | monitor Phase 2 — deps: #1574 |
| 1581 | pr.merge_state_changed with cascadeHead for auto-merge serialization | medium | 2 | sonnet | monitor Phase 2 — deps: #1576 |
| 1573 | server-side subscription filter pushdown on /events endpoint | medium | 2 | opus | monitor Phase 1 tail |
| 1558 | --since flag silently ignored — should return 400 | low | 2 | sonnet | monitor Phase 1 tail |
| 1594 | sites: browser_start ignores new sites when context already running | medium | 2 | sonnet | sites bug |
| 1597 | sites: resetIfBrowserDied + handleBrowserStart not race-safe | medium | 2 | opus | sites race |
| 1598 | sites: chromeProfile path traversal creates phantom 'default' site | medium | 2 | sonnet | sites security |
| 1568 | monitor: phase query param documented but not applied in /events filter | low | 3 | sonnet | monitor Phase 1 tail |
| 1524 | work-items-server: phase_state error message omits phase_state_delete | low | 3 | sonnet | phase polish — trivial |
| 1526 | work-items-server: path.resolve() doesn't resolve symlinks | medium | 3 | sonnet | phase state |
| 1618 | monitor: work-item events double-hop through session worker | low | 3 | sonnet | sprint-41 follow-up |
| 1623 | phase engine transition-log fallback (verify if #1522 merge closed; implement only if not) | low | 3 | sonnet | sprint-41 follow-up |
| 1626 | sites: add compiled-binary smoke test for playwright runtime resolution | medium | 3 | sonnet | sprint-41 follow-up |

## Batch Plan

### Batch 1 — P0 anchors + Phase 2 kickoff (immediate, 7 picks)
#1574, #1580, #1592, #1600, #1621, #1575, #1576

All 5 "high" scrutiny are opus anchors. #1574 is the gatekeeper for #1577/#1581 (CoalescingPublisher primitive). #1580 lands the first derived-event rule end-to-end. #1592 is critical infra — the compiled daemon is broken without embedded seed files. #1600 is a production sleep/wake recovery bug. #1621 is an orchestration infrastructure fix (ends admin-merge requirement). #1575 + #1576 are cheap sonnet Phase 2 enrichment picks that can land fast and unblock #1581.

### Batch 2 — Phase 2 second wave + sites polish (backfill, 7 picks)
#1577, #1581, #1573, #1558, #1594, #1597, #1598

#1577 depends on #1574 landing. #1581 depends on #1576 landing. #1573 is independent (ipc-server.ts serialize note below). #1558 is a 400-response fix. Sites #1594/#1597/#1598 each touch different files — safe parallel.

### Batch 3 — Fillers + follow-ups (backfill, 6 picks)
#1568, #1524, #1526, #1618, #1623, #1626

All low/medium sonnet picks. #1623 verify-first: #1522's merged fix may already cover it (close or flip phase). #1568 is the last ipc-server.ts touch — serialize last. #1526 touches workItemResolver; independent. #1618, #1626 independent.

## Dependency graph

```
#1574 (CoalescingPublisher) — blocks #1577, #1581; anchor of Phase 2
#1576 (enrich pr) — blocks #1581
#1580 (derived publisher) — independent anchor for derived-rule infra
#1621 (CI blocked) — unblocks auto-merge for all downstream PRs this sprint
#1567/#1570 from sprint 41 — done, unblocks all Phase 2 work
#1623 — verify status against #1522 first; likely no-op
All others: independent
```

**Hot-shared file watch:**

- `packages/daemon/src/ipc-server.ts` — #1558, #1568, #1573, #1580, #1577 all touch this. Serialize: **#1580 first** (largest — derived-event-publisher infrastructure hooks into request pipeline). Then **#1577** (ci.started/running/finished filter registration). Then **#1573** and **#1558** can parallel (different handlers — filter-pushdown vs 400-on-since). **#1568** last (tiny query-param apply).
- `packages/daemon/src/event-bus.ts` — #1574 (CoalescingPublisher) adds new primitive; #1580 consumes. Land #1574 first, rebase #1580 before pushing.
- `packages/daemon/src/claude-server.ts` — #1580 only, no conflicts.
- `packages/daemon/src/site/**` — #1592, #1594, #1597, #1598, #1600 each touch different files (seed-embed / browser_start / race / chromeProfile / server-lifecycle). Safe parallel except #1597 which touches `resetIfBrowserDied` and could overlap with #1600's server-death recovery path — serialize: land #1600 first, then rebase #1597.

## Excluded (with reasons)

- **Monitor Phase 3 (#1578 CopilotPoller, #1579 reviews+comments)** — deferred to sprint 43. Depends on #1574 landing cleanly first; CopilotPoller is a multi-day effort that wouldn't fit cleanly in this sprint alongside Phase 2.
- **Monitor Phase 4–6 (#1582–#1587)** — still gated on Phase 2 + #1574. Sprint 43+.
- **Sites — #1590 per-server rate limit, #1595 cookie auth, #1599 proxy 401 aud-exclusion, #1540 OWA BaseFolderId** — medium/large scope; prioritizing the crash/security bugs (#1592, #1600, #1597, #1598) first. Sprint 43.
- **Phase 1 test-only (#1527 openEventStream tests, #1565 --timeout test, #1572 /events?since= test)** — all `testing` label, low-value solo picks when implementation is stable. Bundle opportunity for a future "test coverage sprint".
- **VFS/clone cluster (#1262, #1263, #1277, #1279, #1280, #1311, #1281, #1312)** — arc stalled 3+ sprints. Needs a dedicated sprint (or user signal to kill). Skip.
- **Sprint 41 follow-ups not picked** — #1632 (regex blind spot, already addressed by #1530's round-2 repair — verify and close), #1633 (multi-line setTimeout), #1634 (Bun.sleep(0) comment accuracy), #1635 (--no-execute fallback), #1636 (workItem.phase guard — addressed by #1522 round-2), #1637 (OAuthCallbackTimeoutError structured type), #1639 (gauge decrement test), #1645–#1647 (sites install polish), #1624 (concurrent mcx auth race). All low-priority; backfill candidates for sprint 43.
- **CI polish** — #1508 path-filter (nice-to-have, not blocking), #1506 already shipped.
- **Orchestration cleanup** — #1250 (meta-touching — orchestrator + retro only), #1392 (codex Bun race), #1395 (pollMailUntil dedup), #1510 (scoped GH_TOKEN), #1531 (DEFAULT_TIMEOUT_MS). Low priority. Sprint 43 if capacity.

## Risks

- **#1580 scope / caution flags.** Derived-event publisher is architectural — causedBy chains, first rule wiring, test drain primitives. Runs in the daemon (single event loop + synchronous bun:sqlite) so distributed-race concerns don't apply, but the implementer should still exercise care on: (a) wrap `workItemDb.update` + derived `bus.publish` in a single `db.transaction(() => {...})` so a crash between them can't orphan the update; (b) idempotent rule body (check current phase before deriving) since the event log will replay on restart; (c) infinite-loop guard via `causedBy.length` depth cap, not `src`-prefix match, so future derived→derived chains aren't permanently blocked; (d) deterministic test drain, not `setTimeout`-poll (would regress #1530's new lint). Full notes on the issue.
- **#1592 embedding.** Bun's `embeddedFiles` build-time inclusion has known edge cases (glob expansion, binary-vs-text detection). Impl may need build script changes. Watch for CI check gate regression.
- **#1621 may be GitHub-side.** Investigation may conclude "GitHub's branch-protection check-rollup is broken in concurrency-cancel scenarios, no code fix." Fallback: add `workflow_dispatch` re-trigger or drop the concurrency group on main merges. If purely GitHub-side, close with documented workaround instead of burning opus cycles.
- **Quota.** Sprint 41 peaked at 40% 5h with 14 concurrent sessions. 20 PRs with 9 opus picks (vs sprint 41's 4) will burn harder. Stagger aggressively: spawn Batch 1's 5 opus anchors first, drip Batch 2 opus (#1577, #1573, #1597) only as Batch 1 finishes. If 5h ≥ 80%, switch to QA/review-only; if ≥ 95%, full pause.
- **ipc-server.ts contention** (5 picks). Serialization plan above should mitigate, but the #1580 + #1577 combo is a real conflict zone — both add handlers to the request pipeline. Rebase #1577 before pushing after #1580 lands.
- **Copilot thread fatigue.** Every sprint-41 PR bounced once on unaddressed Copilot threads. Plan for one repair round per PR. Update implementer's `/implement` skill to pre-check Copilot threads before declaring done? (File as meta issue if worth it.)

## Retro rules applied from sprint 41

1. **One TaskCreate per issue, with `addBlockedBy` edges.** Not Batch 1/2/3 grouping tasks. Run phase will enforce this at spawn time so idle slots auto-pull next unblocked issue; no more "waiting for Batch 2 tail" single-agent lulls.
2. **`mcx phase run impl --work-item '#N'` is mandatory after every `mcx claude spawn`** — writes the transition log entry that downstream triage/review need. Never `--dry-run` in the loop.
3. **Accept rebase cost for parallel impl.** Serialize only when two PRs touch the same function; otherwise spawn both and let the rebase session handle the ~3–5 min merge.
4. **Admin-merge remains standard** until #1621 lands. Latest-run-SUCCESS + qa:pass + resolved threads = merge, regardless of `mergeStateStatus: BLOCKED`.
5. **Follow-up issues should cite the commit that produced them** so the retro can count per-sprint follow-up generation (sprint 41: 21 filed, 3 resolved same-sprint).

## Context

Sprint 41 shipped v1.7.1 — 18 PRs in 3h20m, the entire monitor Phase 1 core + every sprint-40 infra P0. Phase 2 is now structurally unblocked (cross-thread bridge, seq unification, backpressure, subscriber cleanup all live). Sites work has accumulated a post-teams-port bug cluster that's affecting production stability (sleep/wake crashes, compiled-binary startup failures). Sprint 42 sits at the intersection of "finish what Phase 1 started" and "stabilize what shipped." Good moment to also land #1621 and stop relying on `--admin` for every merge.
