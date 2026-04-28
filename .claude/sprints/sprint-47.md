# Sprint 47

> Planned 2026-04-28 00:50 EDT. Target: 10 PRs (Phase 6 wave + first waitForEvent migration + 2 orchestrator-DX fillers).

## Goal

**Close out Monitor Epic Phase 6 and prove the `ctx.waitForEvent` consumer path works end-to-end.** Phase 6 has been deferred from sprint 44 → 45 → 46 → 47; sprint 45 made `ctx.waitForEvent` feature-complete on the producer side, but no orchestrator code uses it yet. This sprint lands the trio (#1586 daemon lifecycle, #1587 budget, #1610 rich session metrics) on the producer side AND migrates `triage.ts` to the consumer side. After this sprint, the orchestrator's per-tick decision loop runs on real events instead of polling `mcx claude wait`, and sprint 48 onward feels the compound benefit (no false `session:stuck` interruptions on bun-test runs already gone via #1799; now also no manual `mcx call _metrics quota_status` reads, no token-count-stalled guesswork, no log-grepping for daemon restarts).

The 2 fillers (#1822 surface gh pr view failures, #1824 phase resolvedFrom prefer valid) close sprint-46 followups that touch orchestrator paths the orchestrator runs through every cycle.

**Note:** #1808 components 4/6/7 (daemon wiring for the patched binary) are intentionally *not* in this sprint — those are proceeding in the user's parallel session and will land outside the autosprint flow.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1586** | Phase 6: daemon lifecycle events (worker.ratelimited, daemon.restarted, daemon.config_reloaded) | high | 1 | opus | monitor-epic — **anchor of Phase 6 serialization** |
| **1659** | feat(coalesce): max-key cap + oldest-flush eviction on CoalescingPublisher | medium | 1 | opus | monitor-epic — independent file, parallelizable |
| **1832** | feat(orchestrator): migrate triage.ts from `mcx claude wait` to `ctx.waitForEvent` | medium | 1 | opus | monitor-epic — **first waitForEvent consumer** |
| 1737 | rename copilot.inline_posted → pr.review_comment_posted (or restrict scope) | low | 1 | sonnet | monitor-epic — text fix |
| 1788 | docs: liveBuffer byte cap uses UTF-16 code units, not UTF-8 | low | 1 | sonnet | monitor-epic — docs only |
| **1587** | Phase 6: budget events (cost.session_over_budget, cost.sprint_over_budget, quota.utilization) | high | 2 | opus | monitor-epic — **deps: #1586 (event-publish path)** |
| 1681 | test(monitor): integration test — session.result carries cost+preview via /events SSE | low | 2 | sonnet | monitor-epic — test |
| 1822 | fix(pr): surface gh pr view failures immediately during `--wait` polling | low | 2 | sonnet | sprint-46 followup, completes the `mcx pr merge` story |
| **1610** | feat(agent): rich session metrics on by default (directory footprint, r/w ratio, command buckets) | high | 3 | opus | monitor-epic — **deps: #1587 (event-publish path)** |
| 1824 | phase: resolvedFrom should prefer valid candidate when work_items.phase + log tail disagree | low | 3 | sonnet | sprint-46 followup, completes the #1802 fix story |

**Model mix:** 4 opus + 6 sonnet.
**Scrutiny mix:** 3 high (Phase 6 trio — adversarial reviews expected on each), 2 medium, 5 low.

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": one TaskCreate per issue, with `addBlockedBy` edges from the dependency edges below.

### Batch 1 — 5 unblocked picks (start immediately)
#1586, #1659, #1832, #1737, #1788

3 opus + 2 sonnet. #1586 anchors the Phase 6 file-serialization chain (#1587 + #1610 wait on it). #1659 is independent (different file — CoalescingPublisher is its own module). #1832 (the waitForEvent migration) is also independent — it's a consumer of Phase 5's already-shipped event interface, doesn't touch the producer-side event-publish path. #1737 + #1788 are docs/text fillers.

### Batch 2 — 3 picks (start as Batch 1 unblocks file serializations)
#1587, #1681, #1822

#1587 starts when #1586 merges (same event-publish file region). #1681 is a test that may want to run against newly-published events from #1586 — practical rather than strict dep, but easy to start later anyway. #1822 is independent of the Phase 6 chain entirely (touches `pr.ts`).

### Batch 3 — 2 picks (start last)
#1610, #1824

#1610 starts when #1587 merges (continues the same event-publish file region). #1824 is independent but kept here as ballast — drop first if mid-sprint pressure rises.

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1587 blockedBy #1586** — both touch the daemon's event-publish path (likely `packages/daemon/src/monitor/event-publish.ts` or adjacent). Serializing avoids the merge-conflict cycle that would otherwise force every PR through rebase.
- **#1610 blockedBy #1587** — same file region. Same reason.
- *(no other edges — #1832, #1659, #1737, #1788, #1681, #1822, #1824 are all independent of each other)*

## Hot-shared file watch

- `packages/daemon/src/monitor/<event-publish path>` — #1586 + #1587 + #1610 all add new event-type publishers in the same file (or two adjacent files). Serialized via the dependency edges above. **The orchestrator may need to broadcast a targeted rebase directive** when each merges, since later PRs in the chain will see merge-base shifts.
- `packages/core/src/event-filter.ts` — #1832 (consumer side of waitForEvent) reads filter logic; #1586/#1587/#1610 may add new event-type literals to a shared union. Independent regions in the same file → low risk but watch for duplicate-entry-on-merge per the planning rule (sprint 33 #1291/#1293 lesson).
- `packages/daemon/src/coalesce.ts` (or wherever CoalescingPublisher lives) — #1659 only.
- `.claude/phases/triage.ts` — #1832 only.
- `packages/command/src/commands/pr.ts` — #1822 only (sprint 46 territory).
- `packages/command/src/commands/phase.ts` — #1824 only (sprint 46 territory, post-#1802).

## Pre-session clarifications required

Visible to workers via Step 1a in `.claude/commands/implement.md` (PR #1804).

- **#1586 (daemon lifecycle events)**: emit at minimum `worker.ratelimited` (when a tool call returns 429), `daemon.restarted` (during startup, after orphan-reaper finishes), `daemon.config_reloaded` (when `~/.claude.json` or `.mcp.json` watcher fires). Use the existing event publisher path; don't invent a new mechanism. Tests must cover each event type firing on its trigger.
- **#1587 (budget events)**: prefer reading thresholds from existing config rather than hardcoding. `cost.session_over_budget` should fire once per session crossing the threshold, not per turn after. `quota.utilization` should fire on threshold *crossings* (e.g., 80%, 95%) — not on every poll.
- **#1610 (rich session metrics)**: "on by default" means current opt-in path becomes default-on. Watch for performance regressions — directory-footprint computation could be expensive on large worktrees; cache + invalidate on FS-event signal rather than re-stat'ing per metric tick.
- **#1659 (CoalescingPublisher max-key cap)**: when the cap is hit, evict the oldest-flushed entry — not the oldest-inserted. Tests must cover: (a) cap not hit → no eviction, (b) cap hit with all entries pending flush → reject vs evict (issue body specifies, follow it), (c) cap hit with some entries flushed → evict the oldest flushed.
- **#1832 (waitForEvent migration)**: target ONLY `triage.ts`. Don't touch `impl.ts`/`qa.ts`/`review.ts`/`repair.ts`/`done.ts` even if it looks tempting. Confirm Phase 5's #1720 integration coverage runs against the new consumer pattern before declaring done. The `mcx claude wait` CLI command stays — only the phase-script call site changes.
- **#1737 (rename copilot.inline_posted)**: pure rename across producer + consumers + tests. Grep for the literal string. No semantic change.
- **#1681 / #1788**: contained tests/docs.
- **#1822 (gh pr view failure surfacing)**: when `gh pr view` returns non-zero during `--wait` polling, log the error and exit nonzero immediately — don't silently retry until timeout. Tests cover: auth-expired exit, rate-limit exit, transient network hiccup (1 retry max).
- **#1824 (resolvedFrom valid candidate)**: when `work_items.phase` and the log tail disagree, prefer the *valid* one — i.e. the one that's a member of the current manifest's phase set. If both valid, prefer the column (consistent with #1802). If neither valid, surface the error rather than silently picking one.

## Excluded (with reasons)

- **#1808 components 4/6/7** (daemon spawn-target wiring + TLS gating + auto-update detection) — proceeding in the user's parallel session outside autosprint flow.
- **#1827, #1829, #1831** (claude-patch hardening + TLS strict-mode + cert validation) — coupled to #1808 wiring; held until that lands.
- **mcx agent UX cluster (#1602-#1609)** — sprint 48 candidate after this sprint's monitor-epic close clears the agent surface for cleaner work.
- **Containment flaky symlink dups (#1770, #1689, #1743, #1687, #1794)** — needs a dedicated test-infra mini-sprint.
- **#1810 / #1820** (liveBuffer flaky duplicates) — close one as dup of the other at plan time; defer the survivor (separate from this sprint's arc).
- **#1818 (hasActiveToolCall test coverage)** — small, deferred to sprint 48 or whenever there's filler space — not the highest-leverage filler vs #1822/#1824 which both touch orchestrator paths.
- **#1812 (sites edge cases)**, **#1825 (offline git-remote flaky)**, **#1811 (server-pool SIGTERM flaky)** — sprint-46 followups, not on the critical orchestrator path.
- **VFS/clone arc** — stalled 8+ sprints; no change.

## Risks

- **Phase 6 trio is the first set of high-scrutiny picks since sprint 44.** Expect 1–2 adversarial reviews to flag real issues; budget for 1 round of self-repair per. Total adversarial-cost estimate: ~$10–15.
- **Serialization on the event-publish path is unavoidable.** #1586 → #1587 → #1610 must run in order. Each rebase will cost ~30s of orchestrator time. If #1586 takes >20 min to merge, consider sending #1587 to start drafting against the unmerged branch and rebasing-on-merge (low-cost in this case since both PRs add only).
- **#1832 (waitForEvent migration) might surface a Phase 5 contract gap** that wasn't visible until a real consumer used it. If so: file as a sprint-48 issue, fall back to keeping `mcx claude wait` in `triage.ts` for this sprint, and don't block the sprint on it.
- **#1610 (rich session metrics on by default) is a behavior change.** If the directory-footprint computation is expensive on large worktrees, this could regress orchestration UX during the rest of the sprint (sessions getting `mcx claude ls` slowdowns). Watch for it; revert to opt-in if observed.
- **Quota.** Sprint 46 ended at 14% / 5h. Sprint 47 has 4 opus picks (+ 3 high-scrutiny adversarial reviews). Estimate ~25–30% utilization at end. Not a constraint.
- **Time pressure.** Sprint 46 took 2.5h orchestrator-active. Sprint 47 with one fewer pick but more high-scrutiny work should land in similar time — call it 2–2.5h.

## Retro rules applied (carried forward from sprint 46)

1. **One TaskCreate per issue** with `addBlockedBy` edges — not Batch grouping tasks. (Sprint 41 lesson; sprint 43 regression; permanent rule in run.md.)
2. **Override triage to adversarial review when the plan calls high scrutiny.** Phase 6 trio is high scrutiny — trust the plan.
3. **Reviewer self-repair when findings are 1-3 contained edits.** Same pattern as sprint 46 (paid for itself 4× across #1768, #1800, #1802, #1746).
4. **Long-lived sprint-{N} branch + worktree.** Same pattern as sprint 46. One container PR (`sprint-47`) that accumulates plan + Started/Ended timestamps + Results + retro diary + release commit.
5. **Daemon restart in pre-flight.** Sprint 46 ran the entire sprint on the pre-#1797 daemon and needed `force=true` on every transition. Sprint 47 must `mcx shutdown && mcx status` after `bun run build` so the daemon picks up #1797's `wq[$].has` fix + #1798's `printInfo` for cleaner bye output + #1799's stuck-detector fix.
6. **Apply meta-fixes between sprints on a `meta/<descriptor>` branch.** #1807 + #1816 applied at sprint-47 plan time via `meta/fix-run-md-doc-bugs` (PR #1833) → improves orchestrator's reading material immediately.

New rules carried out at sprint-47 plan time:

7. **Out-of-band P1 PR ingestion is a documented pattern.** Sprint 46 pulled in 2 user-authored PRs mid-sprint via `mcx track <issue> + force phase=qa + spawn opus QA`. Pattern works; not codified into a skill yet but kept in mind for sprint 47 + beyond.

## Tentative sprint 48 outline

For continuity. Will be fleshed out at the end of sprint 47.

> Sprint 48 — "mcx agent UX revival + sprint 46/47 followup cleanup." Target: 10–12 PRs, ~75 min, v1.9.0 (minor — new top-level agent commands).

| # | Title | Scrutiny | Model | Notes |
|---|-------|----------|-------|-------|
| 1602 | Slim builds: carve out mcx agent / mcx call as standalone binaries | high | opus | minor bump anchor |
| 1603 | mcx agent claude ls cwd hint when other scopes have results | low | sonnet | |
| 1605 | mcx agent claude wait stable header line | low | sonnet | |
| 1606 | mcx agent claude send --if-idle | medium | sonnet | |
| 1607 | mcx agent claude interrupt --reason | low | sonnet | |
| 1608 | mcx agent claude universal @path notation | medium | opus | |
| 1609 | mcx agent claude status one-shot | low | sonnet | |
| 1818 | test(daemon): hasActiveToolCall direct assertions | low | sonnet | sprint-46 followup |
| 1812 | fix(sites): handleBrowserStart edge cases | low | sonnet | sprint-46 followup |
| 1810/1820 | liveBuffer flaky (dedup + fix) | low | sonnet | close one as dup, fix the other |
| 1737 (if missed) | copilot.inline_posted rename | low | sonnet | only if sprint 47 doesn't land it |

Mix: ~3 opus + 7-8 sonnet. 1-2 high-scrutiny.

## Context

Sprint 46 shipped v1.8.0 — 10 PRs (8 sprint + 2 out-of-band P1 components). The Monitor Epic dropped to ~13 open issues post-sprint-46; this sprint targets ~6 closes (#1586, #1587, #1610, #1659, #1832, #1737, #1681, #1788) which would bring it to ~5 — effectively the closing arc on the original Monitor Epic charter.

Sprint 47 is the second of the back-to-back pair. The orchestrator-pain noise reducers from sprint 46 (#1797 vq[$].has, #1798 bye Error: prefix, #1799 session.stuck false-positives) are in main; the daemon restart at pre-flight will pick them up so this sprint runs in a measurably quieter room.
