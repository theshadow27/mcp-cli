# Sprint 58

> Planned 2026-05-19 23:20 EST. Started 2026-05-19 23:35 EST. Ended 2026-05-20 01:22 EST. Target: 15 issues.

## Goal

Stabilize the `ctx.gh` tail — fix the 3 deferred Copilot findings from PR
#2136 (which auto-closes the #2148 statusCheckRollup regression), pay down
sister bugs in gh-client.ts, and fix the production-side races from sprint
57 fallout (#2135 PID race, #2155 merge timeout). Round out with
orchestrator-UX quick wins (monitor flags, daemon startup perf, doc/CI
hygiene). No heavy goal-anchor this sprint, no investigation gate — this
is a low-risk stabilization sprint by design.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2147 | fix(gh-client): address 3 deferred Copilot findings from PR #2136 (auto-closes #2148) | medium | 1 | sonnet | goal |
| 2135 | connectFn → PID race in ensureConnected: childPid cached as null | medium | 1 | sonnet | goal |
| 2155 | bug(done-fn): merge timeout recovery polls PR state without transactional guard | medium | 1 | sonnet | goal |
| 2122 | docs/phases.md: Phase handler API table missing ctx.signal row | low | 1 | sonnet | goal-quick |
| 2127 | bug: ci.yml detect job comment says .claude/** but pattern is .claude/* (non-recursive) | low | 1 | sonnet | goal-quick |
| 2144 | refactor(alias): deduplicate GhResult interface across done-fn, qa-fn, review-fn | low | 2 | sonnet | goal |
| 2149 | bug(gh-client): silent JSON.parse swallowing in classifyResponse masks malformed GitHub error bodies | low | 2 | sonnet | goal |
| 2154 | meta(ctx.gh): lazy Proxy handle defers auth/repo validation to first method call | low | 2 | sonnet | goal |
| 2143 | feat(monitor): add --all-repos escape hatch to restore global event stream | low | 2 | sonnet | filler |
| 2150 | perf(daemon): parallelize startup binary 'which' checks | low | 2 | sonnet | filler |
| 2142 | chore(test): convert server-pool.spec.ts poll loops to pollUntil | low | 3 | sonnet | filler (Bun.sleep arc) |
| 2129 | false-positive Edit/Write permission_request events flooding monitor stream | low | 3 | sonnet | filler |
| 2151 | bug(memory audit): spawnCapture loses stderr context, parseHaikuResponse failures dump 50KB+ to stderr | low | 3 | sonnet | filler |
| 2128 | refactor(test): import MAIL_SENT constant in event-bus.spec.ts instead of hardcoding string | low | 3 | sonnet | filler |
| 2137 | monitor: strengthen --until help text to reflect glob semantics | low | 3 | sonnet | filler |

All `sonnet`, all default `claude` provider. No opus this sprint — no
heavy goal-anchor and no investigation gate. Selection is bug-fix and
polish, well-suited to a wide parallel sonnet fleet.

## Dependency edges (translate to `addBlockedBy` at run time)

Hot-shared file: `packages/core/src/gh-client.ts` is touched by **four**
picks — serialize them so each rebases on the prior. #2147 is the anchor
(largest scope, adds the `merged` field to `RawPr`, fixes Findings 3/4/5).

- #2149 blockedBy #2147 — same file (`gh-client.ts`); #2149 is a small
  localized fix at `classifyResponse` line 305 that can rebase trivially
  after #2147 lands its broader changes.
- #2154 blockedBy #2147 — same file (`gh-client.ts:897-924` Proxy
  constructor); rebases after #2147's `RawPr.merged` field is in.
- #2144 blockedBy #2147 — overlaps in `.claude/phases/done.ts`. #2147
  Finding 4 modifies `done.ts:82` to use the new `merged` field; #2144
  factors `GhResult` out of `done-fn.ts` / `qa-fn.ts` / `review-fn.ts`.
  Serialize to avoid logical conflicts in the phase glue.
- #2155 blockedBy #2144 — both touch `.claude/phases/done-fn.ts`. #2144
  extracts `GhResult`; #2155 wraps merge+cleanup in a transactional guard.
  Serialize #2155 after #2144 so the type extraction has already moved.

Monitor command file:
- #2143 blockedBy #2137 — both modify `packages/command/src/commands/monitor.ts`.
  #2137 is a 1-line help-text change; serialize #2143 after so the new
  `--all-repos` flag merges into the already-clarified help block.

All other picks (#2135, #2122, #2127, #2150, #2142, #2129, #2151, #2128)
are independent — different files or non-overlapping regions.

## No investigation gate this sprint

Per `references/investigations.md`, the gate fires when the sprint
includes a `flaky` / recurring / unclear-mechanism issue. The only such
candidate (#2112 server-pool disconnect SIGTERM flake) was diagnosed in
sprint 57's investigation gate (#2103), and the production race split out
(#2135) is now a confirmed mechanism, not an open investigation. No gate
needed.

## Batch Plan

### Batch 1 (immediate — production fixes + ctx.gh anchor)
#2147, #2135, #2155, #2122, #2127

### Batch 2 (backfill — ctx.gh tail polish + perf)
#2144, #2149, #2154, #2143, #2150

### Batch 3 (backfill — remaining quick wins)
#2142, #2129, #2151, #2128, #2137

## Hot-shared file watch

- **`packages/core/src/gh-client.ts`** — #2147 anchor, then #2149 and
  #2154 rebase. Orchestrator must broadcast targeted rebase + "check for
  duplicate methods you may have added to GhClient in parallel" when
  #2147 merges (sprint 33 logical-dispatch-conflict pattern).
- **`.claude/phases/done.ts` + `.claude/phases/done-fn.ts`** — #2147
  (Finding 4) lands first in `done.ts`. Then #2144 extracts `GhResult`
  across `*-fn.ts` files. Then #2155 wraps merge+cleanup in `done-fn.ts`.
  Serialize via blockedBy edges above.
- **`packages/command/src/commands/monitor.ts`** — #2137 (help text)
  lands first, then #2143 (--all-repos flag) rebases. Different sections,
  serialize anyway to keep diffs clean.

## Excluded (and why)

These remain deferred to sprint 59+ — the rationale is to stabilize
ctx.gh's REST/GraphQL adapter surface in sprint 58 before building the
next layer on top:

- **#1912** (`mcx pr` command) — heavy IPC + cache-invalidation feature.
  Sprint 57 plan named it "centerpiece candidate" for sprint 58; deferring
  to sprint 59 because #2147's adapter fixes need to settle first, and
  current ctx.gh has 4+ open follow-ups (#2147 / #2148 / #2149 / #2154).
  Building `mcx pr` on a stabilized surface beats building it on a moving
  one.
- **#1964** (`perf(daemon)`: cache backend for `ctx.gh`) — same logic;
  caching an unstable API surface is premature.
- **#2022** (automation merge module) — #2018 dependency is closed, so
  this is technically unblocked. Defer anyway because (a) it depends on a
  4-surface check primitive whose semantics are exactly what #2147 is
  fixing, and (b) #2155 transactional-merge work overlaps. Land sprint 59
  once both stabilize.
- **#2140** (eliminate GhResult adapter layer — full refactor) — large
  cross-phase refactor of `done-fn` / `qa-fn` / `review-fn` /
  `repair-fn` / `needs-attention-fn` interfaces. #2144 ships the
  `GhResult` dedup subset this sprint; #2145 and the full position→typed
  rewrite defer to sprint 59 where they can be one focused PR.
- **#2145** (replace position-based `gh()` adapter arg parsing) — depends
  on #2140's typed-operation surface.
- **#2146** (test coverage for inlined spawn timeout/SIGKILL in done.ts)
  — test-only, defer; pair with #2152.
- **#2152** (phase `-fn.ts` modules unit-test coverage) — adds 4 new
  `*-fn.spec.ts` files; large test addition. Defer to a coverage-focused
  sprint or pair with #2140/#2145.
- **#2100** (Bun.sleep lint blocking) — 138 violations, grinding multi-PR
  task. #2142 chips one file off; rest deferred.
- **#1861** (coverage for excluded files) — still blocked on #1856/#1857
  per body.
- **#1924 / #1939 / #1611 / #1942 / #1486** — true epics; need design
  pass before any sprint commits.
- **#2024** (Temporal/Hatchet/Restate eval) — exploration, needs a spike.
- **#2074** — labeled `needs-clarification`; skip per Rule 1.
- **#1750** — `[BLOCKED on #1748 + #1749]` in title.
- **#1602** (slim builds) — heavy build-system refactor; defer.
- **#1595** (cookie auth) — heavy sites feature; defer.
- **#2153** (epic: silent `.catch` audit) — epic, defer.
- **#1077** open PR (Bun segfault repro) — DO NOT MERGE in title;
  unrelated to sprint.

## Meta issue applied at plan time

- **#2131** (wire `mcx memory audit` into retro.md memory-pruning step)
  — applied via `meta/retro-memory-audit-2131` branch + PR #2157
  (auto-merge armed). Verbatim content from the issue body, lands on main
  before this sprint runs so the sprint-58 retro picks up the new audit
  flow.

Two other `meta`-labeled candidates (#2140, #2154) are actually code
changes, not `.claude/skills/**` edits — they remain in the sprint
backlog. #2154 included this sprint; #2140 deferred (large refactor).

## Quota note

7d cap was at **89%** at planning time. Sprint 57 used a user-granted
overage to push to 100%. Sprint 58's smaller, all-sonnet plan is sized to
fit within remaining 7d headroom; if the orchestrator approaches 95% mid-
sprint, drop batch 3 fillers rather than overrunning the cap.

## Context

Sprint 57 landed the `ctx.gh` foundation (PR #2136) and the deferred
sprint-56 work (macOS support window #2092, resume recovery #2113/#2114,
monitor cleanup, server-pool flake investigation #2103 → #2138 + #2135).
The investigation gate succeeded — root cause was a `childPid===null`
race in `ensureConnected`, not the originally-hypothesized SIGTERM timing
window. Sprint 57 fix was test-only (#2138); sprint 58 picks up the
production-side fix (#2135).

Sprint 57's wind-down surfaced #2148 (statusCheckRollup REST/GraphQL
adapter mismatch — orchestrator had to manually merge PR #2139). #2147
fixes that root cause + 2 sister findings. #2155 covers a merge-timeout
race noted during introspection.

### Risks

- **ctx.gh tail bundling**: #2147 fixes 3 findings in one PR. If the
  worker scope-creeps into Finding 5 = full GraphQL `statusCheckRollup`
  reimplementation, narrow to "augment REST `checks()` with
  `/commits/{sha}/statuses` merge" (the minimal compatible fix) and file
  a follow-up for the GraphQL migration.
- **Serialization chain**: #2147 → #2149 → #2154 + #2147 → #2144 →
  #2155 creates a 3-deep dependency. If #2147 takes longer than median
  sonnet, batches 2/3 stall on the gh-client.ts blockers. Mitigation:
  orchestrator can pull non-gh-client.ts fillers (#2150, #2142, #2129,
  #2128, #2137) to keep slots warm while #2147 lands.
- **No opus**: this sprint has no heavy goal-anchor; if a "should have
  been heavy" issue surfaces (e.g., #2147 turns out to need GraphQL
  rewrite), it gets re-classified mid-sprint and may need an opus
  promotion. Acceptable risk — current scope estimates are conservative.

## Results

- **Released**: v1.10.1 (sprint container PR #2158, tag at merged sha post-retro)
- **PRs merged**: 14 (#2159 #2160 #2161 #2162 #2163 #2164 #2165 #2167 #2168 #2170 #2171 #2172 #2174 #2178)
- **Issues closed**: 15/15 planned — all 15 sprint issues closed (14 via PR merge, #2122 closed-as-already-resolved by PR #2136 from sprint 57)
- **Issues dropped**: 0
- **New issues filed**: 4 — #2166 (perf followup for #2150 — Bun.which + stdio:ignore), #2169 (gh-client polish followup from #2147 Copilot review), #2173 (DOTW rule for `.js` extension in local imports — sister of #2144), #2176 (flaky `server-pool.spec.ts` timeouts surfaced during #2143 QA), #2177 (process gap: orchestrator merged #2143 with stale `qa:fail` label after rerun cleared CI; should have flipped label to `qa:pass` first)
- **QA rounds**: 4 PRs needed repair (#2151, #2143, #2149, #2154); two were single-round (`#2151`, `#2154`); two ran two rounds (`#2143` flaky-CI cleared on rerun, `#2149` needed default consoleLogger to avoid no-op warn). No `needs-attention` exits.
- **Notable**: zero `needs-attention` exits; the ctx.gh tail (#2147 → #2144/#2149/#2154/#2155) all landed cleanly with serialized rebases; the planned hot-shared-file conflict on gh-client.ts surfaced once (#2174 went DIRTY after #2154 merge) and the repair session rebased successfully on a single send.
