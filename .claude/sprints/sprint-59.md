# Sprint 59

> Planned 2026-05-20 00:48 EST. Refreshed 2026-05-23 (pre-run). Target: 14 issues.

## Goal

Land `mcx pr` — the orchestrator-UX layer that consolidates Copilot
review-thread handling onto the now-stabilized `ctx.gh` foundation — and
close out the phase-script type-safety refactor (position-based `gh()`
arg parsing → typed operations) with paired unit-test coverage. The
sprint also rolls up the small ctx.gh / daemon polish followups filed at
the tail of sprint 58, runs a **nerd-snipe investigation gate on the
recurring server-pool CI flake (#2112)**, and clears a handful of
independent quick wins.

`mcx pr` (#1912) is the goal-anchor — first heavy/opus pick since the
ctx.gh foundation landed. The phase refactor (#2145) and the test
coverage (#2152 + #2146) round out the goal; the fillers distribute
across non-overlapping files so they keep slots warm while the anchor
and the refactor chain serialize.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1912 | feat(mcx): `mcx pr` command — query daemon for thread state, resolve/reply inline (qa.md collapse) | high | 1 | opus | goal-anchor |
| 2112 | flaky(server-pool): disconnect/SIGTERM tests intermittently time out in CI — **investigation gate** | high | 1 | opus | goal-investigation |
| 2169 | perf(gh-client): polish ctx.gh `checks()` and `GhPageCapError` per #2147 Copilot review | low | 1 | sonnet | goal-quick |
| 2166 | perf(daemon): use `Bun.which()` + stdio:ignore in startup binary checks (followup #2150) | low | 1 | sonnet | goal-quick |
| 2145 | refactor(phases): replace position-based `gh()` adapter arg parsing with typed operations | medium | 1 | sonnet | goal |
| 2152 | testing: phase `-fn.ts` modules lack focused unit-test coverage | medium | 2 | sonnet | goal |
| 2146 | test(phases): add unit test coverage for inlined spawn timeout/SIGKILL escalation in done.ts | low | 2 | sonnet | goal-quick |
| 2130 | feat(orchestrator): auto-resolve Copilot review threads after fix-reply | medium | 2 | sonnet | goal |
| 2173 | dotw: add rule against `.js` extension in local TypeScript imports | low | 2 | sonnet | filler |
| 1682 | ci: add compiled-binary smoke test to catch embed regressions (follow-up to #1592) | medium | 3 | sonnet | filler |
| 1551 | test(opencode-server): add snapshot test for `OPENCODE_TOOLS` schema shape to prevent silent drift | low | 3 | sonnet | filler |
| 1528 | feat(events): heartbeat can fire up to 2× the interval after activity (deferred from PR #1519) | medium | 3 | sonnet | filler |
| 1527 | feat(events): add `openEventStream()` client integration tests (deferred from PR #1519) | low | 3 | sonnet | filler |
| 1370 | test(manifest): add coverage for `loadManifest` lstat ENOENT race path | low | 3 | sonnet | filler |

Two `opus` picks: #1912 (the centerpiece) and #2112 (the investigation
gate — nerd-snipe needs reasoning headroom). Everything else `sonnet`,
default `claude` provider. Scrutiny mix: 2 high, 4 medium, 8 low.

## Investigation gate (mandatory before any flake "fix")

**#2112 — server-pool disconnect/SIGTERM CI-timeout flake.** Per
[`references/investigations.md`](../skills/sprint/references/investigations.md),
this is a recurring CI-only flake and gets a nerd-snipe gate before any
impl. Spawn shape: `mcx claude spawn --worktree --model opus --allow Read
Glob Grep Write Edit Bash` with the persona inlined (NOT the Agent tool —
see #2009). The investigation's **first job** is to establish whether the
flake still recurs: pull CI failure history for `server-pool.spec.ts`
since PR #2163 (the pollUntil conversion) merged. If it has NOT recurred
in CI since #2163, the correct outcome is "close #2112 as resolved by
#2163" with the CI evidence attached. If it HAS recurred, produce root
cause + concrete fix plan, or hard-fail to `needs-attention`.

**Do not trust local green as evidence** — #2112 was prematurely closed
at plan time on 3 passing local runs on an M4 Max, which does not exercise
the CI contention/slow-runner conditions where the timeout fires. Reopened.
The duplicate trackers #2175 and #2176 were consolidated onto #2112.

#2083 (alias-bundle-tsc tsc-timeout flake) is a **different** failure
signature and stays deferred — if #2112's diagnosis surfaces a shared
contention mechanism, fold #2083 in then; otherwise it is a sprint-60
candidate.

## Dependency edges (translate to `addBlockedBy` at run time)

The phase refactor (#2145 → {#2152, #2146}) is the main serialization;
everything else is independent.

**Phase refactor — all touch the `-fn.ts` family** (`done-fn.ts`,
`qa-fn.ts`, `review-fn.ts`, `repair-fn.ts`, `needs-attention-fn.ts`):
- #2145 is the chain head. (Its former parent #2140 — the umbrella
  "eliminate GhResult adapter layer" issue — is **closed**: the GhResult
  dedup landed in #2170 / commit a3200c11; the remaining position-based
  arg-parsing work IS #2145. So #2145 now runs first with no blocker.)
- #2152 blockedBy #2145 — adds focused unit-test coverage for the
  refactored `-fn.ts` modules. Test mocks must target the post-#2145
  typed-operation surface, not the position-based one, otherwise the
  tests get rewritten twice.
- #2146 blockedBy #2145 — test for the inlined spawn timeout/SIGKILL in
  `done.ts`. Shares `done-phase.spec.ts` + `done.ts`/`done-fn.ts` with
  #2145; serialize to avoid collisions during test additions.

**ctx.gh tail polish — both touch `gh-client.ts`:**
- #2130 blockedBy #2169 — both modify `packages/core/src/gh-client.ts`.
  #2169 is smaller (`checks()` normalization + `GhPageCapError` context);
  land first. #2130 then adds the GraphQL `resolveReviewThread` mutation
  wrapper on top.

**`mcx pr` command — independent:**
- #1912 lands new files under `packages/command/src/commands/pr/` plus a
  new dispatch entry in `packages/command/src/main.ts`. No serial conflict
  with the refactor chain; runs in parallel.

**Investigation gate — independent:**
- #2112 produces a comment + possibly a small fix PR or a needs-attention
  outcome; no file-level conflict with the rest.

All other picks (#2166, #2173, #1682, #1551, #1528, #1527, #1370) are
independent — different files or non-overlapping regions.

## Hot-shared file watch

- **`packages/core/src/gh-client.ts`** — #2169 anchor, then #2130
  rebases. Different sections (`checks()` vs new `resolveReviewThread`
  mutation), small file. Broadcast a targeted rebase directive when #2169
  merges.
- **`.claude/phases/{done,qa,review,repair,needs-attention}-fn.ts`** —
  #2145, #2152, #2146 all live here. Strict serialization: #2145 →
  {#2152, #2146}.
- **`packages/command/src/main.ts`** — #1912 adds a new `case "pr":`
  dispatch entry. No other sprint pick adds a dispatch; no logical
  conflict expected. Still scan #1912's PR for stray dispatch additions
  (the sprint-33 pattern).

## Batch Plan

### Batch 1 (immediate — anchor + investigation + refactor head + ctx.gh polish)
#1912, #2112, #2145, #2169, #2166

### Batch 2 (backfill — refactor tail + ctx.gh polish + quick filler)
#2152, #2146, #2130, #2173

### Batch 3 (backfill — independent fillers)
#1682, #1551, #1528, #1527, #1370

## Excluded (and why)

These remain deferred to sprint 60+:

- **#1964** (cache backend for ctx.gh) — supports #1912 if rate-limit
  pressure shows up, but #1912 doesn't strictly require it. Measure
  whether the production `mcx pr` workload actually hits the rate-limit
  cap before building the cache prophylactically.
- **#2022** (automation merge module) — defer to sprint 60 where it can
  sit on top of a stable `mcx pr` surface (consumes the same thread-state
  primitives).
- **#2083** (alias-bundle-tsc tsc-timeout flake) — different failure
  signature from #2112; fold in only if #2112's diagnosis surfaces a
  shared contention mechanism, else sprint-60.
- **#2100** (Bun.sleep lint blocking) — ~130 remaining violations; a
  multi-PR chip-away.
- **#2153** (epic: silent `.catch` audit) — epic; broad daemon-wide
  touch; defer.
- **#1942 / #1924 / #1939 / #1486 / #1611** — true epics; need a design
  pass before any sprint commits.
- **#2024** (Temporal/Hatchet/Restate eval) / **#1970** (remote-control
  replacement) — spikes.
- **#2074** — labeled `needs-clarification`; skip per plan Rule 1.
- **#1750** — `[BLOCKED on #1748 + #1749]` in title.
- **#1602 / #1595 / #1453** — heavy sites / build-system refactors.
- **#1831 / #1829** — daemon TLS work that can wait.
- **#2182 / #2181** — docs/skill tooling filed after the original plan;
  #2182 builds a skill (orchestrator/meta territory). Revisit at retro.

## Pre-run board hygiene (this refresh, 2026-05-23)

- **#2121** (investigations.md spawn template missing `--allow Bash`) —
  it edits a `.claude/skills/**` meta file, so it cannot be a sprint
  worker task (Rule 5). Applied via `meta/issue-2121-investigations-allow-bash`
  + PR #2183 (merged to main). Removed from the issue table. Lands before
  run so the #2112 investigation spawns from the corrected template.
- **#2140** — CLOSED as superseded: GhResult dedup done in #2170; the
  remaining position-parse refactor is #2145 (kept). Removed as the
  refactor-chain head; #2145 is now the head.
- **#2112 / #2175 / #2176** — the server-pool flake cluster. #2112 kept
  OPEN as the canonical tracker and promoted into this sprint as the
  investigation gate; #2175 + #2176 consolidated (closed as duplicates of
  the open #2112, explicitly NOT "fixed").
- **#1247** — was briefly mis-closed during recon (a recon pass scrambled
  issue↔title mappings); reopened. Not in this sprint.

## Quota note

Re-check 7d utilization at run time. Sprint 59 carries **two** opus
sessions now (#1912 anchor + #2112 investigation), noticeably more
expensive than the sprint-58 all-sonnet baseline.

Heuristics:
- If 7d utilization is ≥85% at run time, drop one or two Batch 3 fillers
  (#1527, #1370, #1551) before spawning.
- If utilization is ≥95%, run the #2112 investigation but defer #1912 to
  sprint 60; the remaining picks can run sonnet-only.
- Near a quota-reset boundary, fire for effect so long as work won't
  overrun the reset (per `feedback_quota_end_of_block`).

## Context

Sprint 58 closed the `ctx.gh` foundation stabilization sweep — all four
hot-shared `gh-client.ts` follow-ups (#2147, #2149, #2154, #2144) landed
cleanly, plus two production-side races (#2135 PID race, #2155
merge-timeout guard). 15/15 closed, zero `needs-attention`, $14 spend.

That stabilization was the prerequisite for #1912 (`mcx pr`). Sprint 57's
plan called #1912 the centerpiece candidate; sprint 58 deferred it to land
the foundation first. Sprint 59 picks it up now that the surface is stable.

This plan was originally written 2026-05-20 and sat un-run for 3 days; the
2026-05-23 refresh reconciled it against board drift (above) and added the
#2112 investigation gate per the "kill the flake" sprint goal.

### Risks

- **#1912 scope creep**: `mcx pr` adds a CLI command, a daemon query
  surface, and a synchronous thread-state read path. The issue body
  enumerates `wait-for-copilot`, `comments`, and per-thread
  `--reply`/`--resolve`. Send a scoping directive at spawn: "land
  `wait-for-copilot` and `comments` first as PR #1; `--reply` / `--resolve`
  follow in a stacked PR or new issue."
- **#2112 investigation may hard-fail to needs-attention** — that is an
  accepted outcome for an investigation gate. Do not let it block the
  rest of the sprint; it runs independently.
- **#2145 → {#2152, #2146} serialization stall**: if #2145 runs long,
  pull non-chain picks (#1912, #2169, #2130 (after #2169), #2173, #1682,
  #1551, #1528, #1527, #1370) forward to absorb idle slots.
- **Known-flake CI failures**: if any sprint-59 PR's CI fails on
  `server-pool.spec.ts` or `alias-bundle-tsc.spec.ts`, that is a known
  flake — rerun + apply the sprint-58 label-hygiene rule. Don't escalate
  to `needs-attention` for a known-flake CI failure. (The #2112
  investigation itself is the exception — it is studying that flake.)

## Results

(filled in at sprint review time)
