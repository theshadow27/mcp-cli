# Sprint 59

> Planned 2026-05-20 00:48 EST. Target: 15 issues.

## Goal

Land `mcx pr` — the orchestrator-UX layer that consolidates Copilot
review-thread handling onto the now-stabilized `ctx.gh` foundation — and
close out the phase-script type-safety refactor (`GhResult` adapter +
position-based `gh()` arg parsing) with paired unit-test coverage. The
sprint also rolls up the small ctx.gh / daemon polish followups filed at
the tail of sprint 58, plus a handful of independent quick wins.

`mcx pr` (#1912) is the goal-anchor — first heavy/opus pick since the
ctx.gh foundation landed. The phase refactor pair (#2140 → #2145) and
the test coverage (#2152 + #2146) round out the goal; the fillers
distribute across non-overlapping files so they keep slots warm while
the anchor and the refactor chain serialize.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1912 | feat(mcx): `mcx pr` command — query daemon for thread state, resolve/reply inline (qa.md collapse) | high | 1 | opus | goal-anchor |
| 2140 | refactor: eliminate `GhResult` adapter layer between phase `-fn.ts` and `ctx.gh` | medium | 1 | sonnet | goal |
| 2169 | perf(gh-client): polish ctx.gh `checks()` and `GhPageCapError` per #2147 Copilot review | low | 1 | sonnet | goal-quick |
| 2166 | perf(daemon): use `Bun.which()` + stdio:ignore in startup binary checks (followup #2150) | low | 1 | sonnet | goal-quick |
| 2121 | investigations.md spawn template missing `--allow Bash` | low | 1 | sonnet | filler |
| 2145 | refactor(phases): replace position-based `gh()` adapter arg parsing with typed operations | medium | 2 | sonnet | goal |
| 2152 | testing: phase `-fn.ts` modules lack focused unit-test coverage | medium | 2 | sonnet | goal |
| 2146 | test(phases): add unit test coverage for inlined spawn timeout/SIGKILL escalation in done.ts | low | 2 | sonnet | goal-quick |
| 2130 | feat(orchestrator): auto-resolve Copilot review threads after fix-reply | medium | 2 | sonnet | goal |
| 2173 | dotw: add rule against `.js` extension in local TypeScript imports | low | 2 | sonnet | filler |
| 1682 | ci: add compiled-binary smoke test to catch embed regressions (follow-up to #1592) | medium | 3 | sonnet | filler |
| 1551 | test(opencode-server): add snapshot test for `OPENCODE_TOOLS` schema shape to prevent silent drift | low | 3 | sonnet | filler |
| 1528 | feat(events): heartbeat can fire up to 2× the interval after activity (deferred from PR #1519) | medium | 3 | sonnet | filler |
| 1527 | feat(events): add `openEventStream()` client integration tests (deferred from PR #1519) | low | 3 | sonnet | filler |
| 1370 | test(manifest): add coverage for `loadManifest` lstat ENOENT race path | low | 3 | sonnet | filler |

One `opus` pick (#1912 — the centerpiece). Everything else `sonnet`,
default `claude` provider. Scrutiny mix: 1 high, 5 medium, 9 low —
matches the 15%/25%/60% target.

## Dependency edges (translate to `addBlockedBy` at run time)

The phase refactor chain (#2140 → #2145 → #2152) is the main
serialization. The ctx.gh tail polish (#2169 + #2130) serializes on
`gh-client.ts`. Everything else is independent.

**Phase refactor chain — all touch the `-fn.ts` family:**
- #2145 blockedBy #2140 — same files (`done-fn.ts`, `qa-fn.ts`,
  `review-fn.ts`, `repair-fn.ts`, `needs-attention-fn.ts`). #2140
  removes the duplicated `GhResult` interface and consolidates it in
  `phase-types.ts`; #2145 then replaces position-based `gh()` arg
  parsing with typed `GhOp` operations. Serializing avoids a 3-way
  conflict on every `-fn.ts` file.
- #2152 blockedBy #2145 — adds focused unit-test coverage for the
  refactored `-fn.ts` modules. Test mocks need to target the post-#2145
  typed-operation surface, not the position-based one, otherwise the
  tests get rewritten twice. Serialize after #2145 lands.
- #2146 blockedBy #2140 — test for the inlined spawn timeout/SIGKILL
  in `done.ts:85-100`. Doesn't strictly conflict with #2140's
  `GhResult` extraction (different file region), but the spec file
  `done-phase.spec.ts` is the same target and serializing avoids
  collisions during test additions. Can also run parallel to #2145 if
  scheduling demands it.

**ctx.gh tail polish chain — both touch `gh-client.ts`:**
- #2130 blockedBy #2169 — both modify `packages/core/src/gh-client.ts`.
  #2169 is the smaller (`checks()` normalization + `GhPageCapError`
  context); land first. #2130 then adds the GraphQL
  `resolveReviewThread` mutation wrapper on top.

**`mcx pr` command — independent:**
- #1912 lands new files under `packages/command/src/commands/pr/` plus
  a new dispatch entry in `packages/command/src/main.ts`. No serial
  conflict with the refactor chain; runs in parallel.

All other picks (#2166, #2121, #2173, #1682, #1551, #1528, #1527,
#1370) are independent — different files or non-overlapping regions.

## Hot-shared file watch

- **`packages/core/src/gh-client.ts`** — #2169 anchor, then #2130
  rebases. Different sections (`checks()` vs new
  `resolveReviewThread` mutation), but small file, easy to break. The
  orchestrator should broadcast a targeted rebase directive when #2169
  merges.
- **`.claude/phases/{done,qa,review,repair,needs-attention}-fn.ts`** —
  #2140, #2145, #2152, #2146 all live here. Strict serialization:
  #2140 → #2145 → #2152, with #2146 either after #2140 (parallel to
  #2145) or after #2145 (serialized — orchestrator's call once #2140
  lands).
- **`packages/command/src/main.ts`** — #1912 adds a new `case "pr":`
  dispatch entry. No other sprint picks add dispatches; no logical
  conflict expected. But this is the historical "dispatch table"
  pattern that bit sprint 33; orchestrator should still scan #1912's
  PR for any unrelated dispatch additions.
- **`docs/phases.md`** — #2121 (1-line `--allow Bash` doc fix)
  doesn't conflict with anything; flag only.

## Investigation gate

**None this sprint.** The server-pool flake cluster (#2176, #2175,
#2112, #2083) needs an investigation gate per
[`references/investigations.md`](../skills/sprint/references/investigations.md),
and all four are deferred to sprint 60 where they can share a single
nerd-snipe diagnosis pass. Sprint 59's picks are all either fresh
feature work, well-scoped refactors, or test additions — no flaky /
recurring / unclear-mechanism issues.

## Batch Plan

### Batch 1 (immediate — anchor + refactor head + ctx.gh polish anchor)
#1912, #2140, #2169, #2166, #2121

### Batch 2 (backfill — refactor tail + ctx.gh polish + quick filler)
#2145, #2152, #2146, #2130, #2173

### Batch 3 (backfill — independent fillers)
#1682, #1551, #1528, #1527, #1370

## Excluded (and why)

These remain deferred to sprint 60+:

- **#1964** (cache backend for ctx.gh) — supports #1912 if rate-limit
  pressure shows up, but #1912 doesn't strictly require it. Deferring
  to sprint 60 to (a) keep sprint 59 to one heavy anchor, and (b)
  measure whether the production `mcx pr` workload actually hits the
  rate-limit cap before building the cache prophylactically.
- **#2022** (automation merge module) — sprint 58 cleared its
  dependencies (#2147, #2155 both landed). Defer to sprint 60 where it
  can sit on top of a stable `mcx pr` surface — the automation module
  consumes the same thread-state primitives.
- **#2176 / #2175 / #2112 / #2083** (server-pool / alias-bundle-tsc
  flakes) — need an investigation gate. Sprint 60 candidate as a
  cluster: spawn one nerd-snipe diagnosis pass against all four; if a
  shared mechanism emerges, the fix is one PR.
- **#2100** (Bun.sleep lint blocking) — 136 remaining violations.
  Multi-PR chip-away; pick up another small file or two in sprint 60.
- **#1942 / #1924 / #1939 / #1486 / #1611** — true epics; need design
  pass before any sprint commits.
- **#2024** (Temporal/Hatchet/Restate eval) — exploration, needs a
  spike session.
- **#1970** (long-term remote-control replacement spike) — spike,
  defer.
- **#2074** — labeled `needs-clarification`; skip per plan Rule 1.
- **#1750** — `[BLOCKED on #1748 + #1749]` in title.
- **#1602 / #1595 / #1453** — heavy sites / build-system refactors;
  defer.
- **#2153** (epic: silent `.catch` audit) — epic, defer.
- **#1831 / #1829** (TLS defense-in-depth, NODE_USE_SYSTEM_CA) — both
  daemon TLS work that can wait.

## Meta issues applied at plan time

- **#2177** (qa label hygiene on flaky-CI rerun) — applied via
  `meta/qa-label-hygiene-2177` branch + PR #2179 (auto-merge armed).
  Lands the rule from `feedback_qa_label_hygiene.md` into the
  canonical `references/run.md` so the orchestrator reads it from the
  skill, not just memory. Closes #2177 on merge.
- **#2140** — was labeled `meta` but is actually a code refactor of
  `.claude/phases/*-fn.ts` (not a `.claude/skills/**` edit). Removed
  the `meta` label at plan time; included as a regular code refactor
  pick.

## Quota note

7d cap was at **89%** at sprint 58 planning (2026-05-19 23:20). Sprint
58 used ~$14 sonnet-only. We're ~25h past that planning mark, so the
7d window has rolled forward ~15% of additional headroom. Sprint 59
adds one opus session (#1912 — the centerpiece), which will be
noticeably more expensive than the sprint-58 all-sonnet baseline.

Heuristic for sprint 59:
- If 7d utilization is ≥85% at run time, drop one or two Batch 3
  fillers (#1527, #1370, or #1551) before spawning.
- If utilization is ≥95%, defer #1912 entirely; the rest can run
  sonnet-only and we re-attempt the anchor in sprint 60.

## Context

Sprint 58 closed the `ctx.gh` foundation stabilization sweep — all
four hot-shared `gh-client.ts` follow-ups (#2147, #2149, #2154, #2144)
landed cleanly, plus two production-side races (#2135 PID race, #2155
merge-timeout guard). 15/15 issues closed, zero `needs-attention`,
zero adversarial reviews fired, $14 spend.

That stabilization was the prerequisite for #1912. Sprint 57's plan
called #1912 the "centerpiece candidate for sprint 58"; sprint 58
deferred it to land the foundation first. Sprint 59 picks it up now
that the surface is stable.

### Risks

- **#1912 scope creep**: `mcx pr` adds a CLI command, a daemon query
  surface, and a synchronous thread-state read path. The issue body
  enumerates `wait-for-copilot`, `comments`, and per-thread
  `--reply`/`--resolve` actions. If the worker tries to land all
  three subcommands in one PR, it'll oversize. Plan for the
  orchestrator to send a scoping directive at spawn time: "land
  `wait-for-copilot` and `comments` first as PR #1; `--reply` /
  `--resolve` follow in a stacked PR or a new issue."
- **#2140 → #2145 → #2152 serialization stall**: 3-deep chain on
  hot-shared `-fn.ts` files. If #2140 takes longer than median
  sonnet, batches 2/3's non-chain picks (#2169, #2130, #2173, #1682,
  #1551, #1528, #1527, #1370) need to absorb the idle slots. The
  orchestrator can pull anything not on the chain forward in launch
  order.
- **No investigation gate, but four flakes deferred**: if any
  sprint-59 PR's CI fails on `server-pool.spec.ts` or
  `alias-bundle-tsc.spec.ts`, that's a known flake — rerun + the
  sprint-58 label-hygiene rule applies. Don't escalate to
  `needs-attention` for a known-flake CI failure.

## Results

(filled in at sprint review time)
