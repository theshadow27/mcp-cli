# Sprint 50 — Tentative outline

> Drafted 2026-04-30 alongside sprint-49 plan. Not a planning artifact — a
> sketch for the sprint-49 retro to read. The actual plan lands at
> `/sprint plan` time and may diverge based on sprint-49 outcomes.

## Goal candidate

**"Milestone sprint — anchor on slim builds (or perf), absorb sprint-49 fallout, run the meta retro pass."**

Sprint 50 is a numbered milestone, the first sprint after the new
monitor-stream playbook (sprint 48's #1871) gets real-use battle-tested
in sprint 49. The structural pull is **half capacity goes to sprint-49
fallout** (test stabilization second-pass, repair-loop residue, security
finding extensions, papercuts surfaced by the new playbook). The other
half goes to one of two anchors that have been deferred multiple times.

## Capacity allocation (15 PRs target)

- **~7-8 slots reserved for sprint-49 fallout** (50%). Cannot enumerate
  ahead of time — fills in at sprint-49 retro from:
  - Repair-loop followups for picks that needed >1 round (likely
    candidates: #1899 security extensions, #1687/#1552 timing-test
    second-pass)
  - New issues filed during sprint-49 (orchestrator + workers — sprint
    48 filed 7, sprint 47 filed 4)
  - Monitor-stream playbook papercuts (dispatch table misses, payload
    drift, exit-code edge cases)
  - Status-bundle (#1903+04+05+06) UX feedback if any surfaces
- **~7-8 slots for anchor + planned picks** (see Bucket 1-3)

This 50/50 split is intentional: sprint 49's primary goal is *stabilize
the test suite* and *exercise the new playbook* — both produce work that
matures in the sprint that follows them. Earmarking capacity now keeps
sprint 50 from over-committing on net-new initiatives.

## Bucket 1 — Anchor (high scrutiny, 1-2 picks)

Pick ONE based on sprint-49 retro signals:

- **#1602 slim builds** (carve standalone `mcx agent`, `mcx call`
  binaries) — candidate sprint-47 anchor, deferred twice. Now tractable
  once: (a) a design doc lands first (multi-entry Bun build vs
  separate `entries/` files), (b) sprint 49's status-bundle
  consolidation reduces rebase overhead. ~60-90 min orchestration,
  high-scrutiny adversarial review.
- **#1865 async gh in phase ticks** — perf, 6 phase scripts touched,
  daemon-side gh cache. Real measured pain (rate-limit exhaustion noted
  sprint 43+). Medium-high scrutiny. Better choice if sprint-49 surfaces
  more phase-tick latency complaints.
- **#1611 mcx agent epic** — long-form orchestration primitives (team /
  roster / naming / handoff). Big, but the agent-UX cluster from sprint
  48 (#1603/06/07/08/09) sets up the foundation. Pick only if user
  wants to push agent capability forward over reliability.

Recommendation pre-retro: **#1602 with design doc** if no surprise
emerges from sprint 49; **#1865** if the new monitor-stream playbook
exposes phase-tick perf as the next bottleneck.

## Bucket 2 — Older bugs continuation (3-4 picks)

Sprint 49 made a dent in the >3-sprint-stale list. Bucket continues:

| # | Title | Scrutiny |
|---|-------|----------|
| 1684 | agent_sessions.repo_root not canonicalized (#1526 sister) — verify still needed | low |
| 1683 follow-ups | if sprint-49 #1683 surfaces sibling fixture leaks | low |
| 1772 follow-ups | if sprint-49 #1772 surfaces other formatter cliffs | low |
| 1604 | mcx claude spawn help text correction (carry-over backup) | low |
| 1819 | agent.ts/claude.ts success message Error: prefix (followup #1798) | low |
| 1395 | dedupe pollMailUntil/emitMailEvent between claude.ts and agent.ts | medium |

## Bucket 3 — Test infra + lint hardening (2-3 picks)

Building on sprint-49 momentum:

| # | Title |
|---|-------|
| 1900 | lint: flag unbounded args[++i] without bounds check |
| 1673 | lint: extend check-test-timeouts.ts to flag Bun.sleep in test files |
| 1632, 1633 | check-test-timeouts regex misses (multi-line setTimeout, callback pattern) |
| 1686 | extend check-test-timeouts.ts to flag Bun.sleep in test files |

(#1673 + #1686 may be dup-resolvable into one PR.)

## Bucket 4 — Meta retro pass (orchestrator-applied, no spawn slots)

Sprint 50 is the right cadence to clear meta debt that's been deferred
across multiple retros. Not in-sprint picks — applied between sprints
49→50 or at retro time:

- **#1867 introspection cadence** — sprint 50 hits the every-10-sprints
  cadence (47 was the last; next due **57**, but sprint 50 should
  prep the prompt template at `.claude/skills/sprint/references/introspection.md`
  + add the retro hook).
- **#1863 memory audit automation** (`mcx memory audit`) — code, not
  meta. Move to Bucket 1 if user wants it.
- **#1860 core.bare flip root cause** — code epic, not meta. Move to
  Bucket 1 if user wants it as the anchor.
- **#1806 skip CI on docs-only branches** — likely tractable in 2-3
  hours; reconsider if sprint container PRs become >3 min CI cost.
- **#1912 mcx pr command** — collapses qa.md Step 5b to one line; would
  obsolete the #1907 inline-dismiss path. Code, not meta. Move to
  Bucket 1 if user wants the orchestrator-DX win.

## Bucket 5 — Stretch (only if anchor fits)

- **#1517 Atlassian OAuth DCR** (P0 for users; production-broken since
  sprint 41) — kept slipping. Sprint 50 should pick this up if the
  anchor doesn't consume the full slot.

## Risks

- **Half capacity is reserved for unknowns.** Plan for 7-8 carry-over
  slots, but if sprint 49 surfaces fewer issues than expected (clean
  flaky-test fixes + clean security review), pull from Bucket 2-3 to
  fill. If sprint 49 surfaces *more* (e.g., security #1899 spawns a
  cluster), shed Bucket 1 entirely and run sprint 50 as pure
  cleanup-and-stabilize.
- **Sprint 50 is a milestone** — natural moment to release v1.9.0 if
  changes warrant. Watch the release-notes shape during retro.
- **Anchor + 7-8 carry-over may exceed 1 quota block.** Sprint 49 is
  estimated low-utilization (~20-25%); sprint 50 with #1602 anchor
  could hit ~40-50%. One block likely sufficient unless the security
  pick (#1899) or test fixes leave deep repair-loop residue.

## Target

- **PRs**: 12-15 (50% reserved for fallout)
- **Time**: ~3-4h orchestrator-active
- **Models**: 1-2 opus anchor + 11-13 sonnet
- **Risk concentration**: anchor pick (slim builds OR perf refactor)
  + carry-over volume

## Process notes (carry-forward from sprint 48 + 49)

1. **Reviewer self-repair** on contained findings — promoted to skill, expect to use heavily.
2. **Bundled PRs** for related issues (sprint 49 used 2 bundles successfully — keep doing).
3. **Verify merge with `state == MERGED && mergedAt != null`** (permanent rule).
4. **One TaskCreate per issue (or per bundled-PR)** with addBlockedBy edges.
5. **No Bun.sleep in test fixes** (deterministic synchronization only).
6. **Plan-time issue audit** — sprint 49 closed 12 issues at plan time with no spawn cost. Continue.
7. **Apply meta-fixes between sprints on `meta/<descriptor>` branches** if any surface during sprint-49 run.
