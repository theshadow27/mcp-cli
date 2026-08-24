# Sprint 80

> Planned 2026-08-24 ~19:30 UTC. Started 2026-08-24 ~20:05 UTC. Target: 15 PRs. Quota at plan time: 5h 11%, 7-day 41%. Quota at run start: 5h 40%, 7d 47%. Concurrency: 4 sessions max (2 impl + 2 review/QA), per operator.

## Goal

Ship v2.0.0: close epic A (domains + mcx.db) with the integrity chain and the
release-infra exit criteria, clear the mcx-session P1 hazards, and end the
release hold. `/sprint review` at wind-down cuts **v2.0.0**.

Plan of record: the recovery comment on #3019 (issuecomment-5399823467).
Sprint 81 is NOT planned here — expected theme at its own boundary: the
reconciler loop (#3274/#3272/#3259) + the deferred tail below.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 3213 | adopt-domains: UPDATE OR IGNORE so one collision doesn't strand siblings | medium | 1 | opus | goal |
| 3013 | patch-update must unblock spawn without daemon restart | high (spawn path) | 1 | opus | P1 hazard |
| 3104 | `[RATE LIMITED]` sticky for the whole turn — expire vs retryAfterMs + rename | medium | 1 | opus | P1 hazard |
| 3264 | build-commit provenance in mcpd (expose via `_metrics`, NOT `--version` — #2981) | medium | 1 | opus | goal |
| 3042 | retire `mcx scope` (keep import-legacy's sidecar reader working) | medium | 1 | opus | goal |
| 3180 | deleteDomain `.immediate()` + drop decorative FK + stop catch laundering | high (DB) | 2 | opus | goal |
| 3110 | spawn-lifecycle: **sym3 only** (wrong `Worktree preserved:` path string) | low | 2 | sonnet | P1 hazard |
| 3260 | devBuild false-positive → install-time provenance marker | medium | 2 | opus | goal |
| 3246 | **secondary only**: normalizeDomainPath → INVALID_PARAMS on relative path | low | 2 | opus | goal |
| 3210 | domains add/rename transactional check-and-write + CHECK constraint | high (DB) | 2 | opus | goal |
| 3247 | **option 1 only**: migrate stamped mail senders on rename; delete policy | high (DB) | 3 | opus | goal |
| 3254 | **`work_items_delete` half only** (exact-id, per #3276 rules); merge-on-collision deferred | medium | 3 | opus | goal |
| 3140 | refuse spawn --cwd into a live session's worktree (+ --allow-shared-worktree) | high (spawn path) | 3 | opus | P1 hazard |
| 3265 | copyAtomic spec: **seed a pre-existing symlink** at the target (steps 1/2/4) | low | 3 | opus | goal |
| 3273 | rename StateDb→McxDb (~587 sites/74 files) + strings/fixtures/false-retry log | low | 3 | sonnet | goal |

Model notes (mechanical exceptions, reasons stated): #3273 — repo-wide rename,
sites enumerated, no design; #3110 — ~15-LOC string fix, diagnosis in the
issue. Everything else opus.

**Scrutiny-mix sign-off (required — 5/15 high, >20% cap):** #3180/#3210/#3247
change DB schema/lifecycle behavior; #3013/#3140 change the spawn path. All
gated-class by policy: adversarial review + QA, no auto-merge. The rest is
deliberately bounded (three picks are explicitly scoped to their small half)
so review concentrates on the gated third. **Operator sign-off:** granted 2026-08-24 by the `/sprint 80` run invocation (plan was reviewed at planning; run start is the approval).

**Design decisions made at planning (no human gates mid-sprint):**
- #3210 canonicalization: refuse non-existent local paths at add/rename
  (cheapest option; closes the drift class by construction).
- #3180 FK: delete the decorative unenforced clause; global
  `PRAGMA foreign_keys` enforcement is a 2.x decision, not this sprint.
- #3247: option 1 (rename-time sender migration + delete policy); option 2
  (id-keyed senders) is 2.x.
- #3254 delete tool: exact-id resolution ONLY — never by-PR inference
  (the #3276 trap must not be replicated).
- #3042: delete the command surface + `SCOPES_DIR` writer; the import-legacy
  reader keeps working (inline its path) — it is the 1.14.x→2.0.0 upgrade
  input.

## Sequence — three lanes, serial within each (THE load-bearing structure)

The sprint-78 failure was N high-scrutiny PRs stacked on one unmerged
foundation, all in flight at once. This sprint is structured so that can't
recur: **three lanes, each strictly serial (next item launches only on the
previous item's MERGE), lanes mutually disjoint at the file level
(recon-verified). At most 3 sessions running; at most 2 high-scrutiny items
in flight ever (the head of lane 1 + the head of lane 2), never touching the
same files. Nothing stacks on an unmerged base — no exceptions.**

**Lane 1 — DB/domains (the hard chain, one at a time):**
#3213 → #3180 → #3210 → #3247 → #3254 → #3273
- 3213 first: smallest (30 LOC, own file), warms the lane cheaply.
- 3180 before 3210 is semantic: 3210's fix mirrors the catch pattern 3180
  rewrites — reversed order means copying code that's about to change.
- 3247 edits the exact two functions 3180/3210 restructure — third in line.
- 3254 is work-items*, not state.ts — may overlap 3247 in wall-clock if lane
  3 is drained, but never precedes it past 3273's gate.
- **3273 (587-site rename) launches only when ZERO other sprint PRs are
  open** — one sitting, fresh main.
- This lane carries the sprint's only schema migration (#3210). One
  migration per sprint, in one PR.

**Lane 2 — spawn path (serial):**
#3013 → #3110(sym3) → #3140
- 3013 first — it un-strands spawning for the sprint itself.
- All three touch claude-session-worker.ts/ws-server.ts; never parallel.

**Lane 3 — independents pool (any order, one at a time, disjoint from
lanes 1–2):** #3104, #3264, #3042, #3246, #3260 → #3265
- Only internal edge: #3265 after #3260 (shared upgrade.spec.ts).
- All medium/low: this lane is the backfill that keeps slots warm while a
  lane-1/2 head sits in adversarial review.

### Batch Plan (launch-order view of the same sequence)

Batch 1 (immediate — the three lane heads + two pool items):
#3213, #3013, #3104 — then #3264, #3042 as pool slots free.
Batch 2 (merge-gated backfill): #3180, #3110, #3246, #3260, #3210.
Batch 3 (merge-gated backfill): #3247, #3254, #3140, #3265, #3273 (last, alone).
A "batch 2/3" item NEVER launches on batch membership — only when its
`blockedBy` edge clears (parent MERGED) and a lane slot is free.

Dependency edges (run phase → `addBlockedBy`; chained items launch only after
the parent PR **merges**):

- #3210 blockedBy #3180 (same state.ts domain block; #3210's fix mirrors the
  catch pattern #3180 rewrites — order is semantic, not just file-level)
- #3247 blockedBy #3210 (edits the exact two functions #3180/#3210 restructure)
- #3110 blockedBy #3013, #3140 blockedBy #3110 (claude-session-worker.ts chain)
- #3265 blockedBy #3260 (shared upgrade.spec.ts)
- #3273 blockedBy #3247 AND #3254 — and launches only when **no other sprint
  PR is open** (mechanical rename lands last and alone, one sitting, fresh
  main; a rename open across another merge is pure rebase cost)

Hot-shared file watch: `packages/daemon/src/db/state.ts` (#3180→#3210→#3247,
serial); spawn path `claude-session-worker.ts`/`ws-server.ts`
(#3013→#3110→#3140, serial; #3246's secondary is mail-server-side and safe);
`upgrade.spec.ts` (#3260→#3265); `work-items*.ts` (#3254 precedes #3273).
`docs/domains.md` gets one trailing docs commit per merge.

## Plan-time board actions (orchestrator, at approval)

- Close **#3152** as done (transactions re-armed on main: work-items.ts:258-314,
  pragma order fixed state.ts:87-88); re-file the doing-it-wrong rule as a
  fresh small issue.
- Close **#3255** as done (`nonEmptyImportedTables()` at import-legacy.ts:659,
  built better than asked); re-file #3239-N3's regression-test gap.
- Comment **#3036** needs-clarification (names `mcx card`/`sensor`/`loop`,
  which don't exist; real scope is track/mail/claude-ls) — defer.
- Comment **#3041** defer-to-epic-B, dedupe against #3192 (same lines, same fix).
- Comment **#3155** rescope (agent_sessions half already done on main; convert
  the remainder to a scoped verification list + static rule) — defer.
- File design issues for the deferred halves: #3110 sym1/2 (readiness signal
  changes the non-`--wait` return contract), #3246 primary (daemon-side cwd
  injection), #3254 merge-on-collision.

## Deferred (named)

- #3209 (repo_root ×5 — real, but carries an undecided re-key/sweep migration
  question and collides with #3042's scope.ts deletion; sprint 81 with the
  decision made), #3036, #3041/#3192 (epic B), #3155 (rescoped), #3247-opt2,
  #3110-sym1/2, #3246-primary, #3254-merge-half, #3231 (minimal scope later),
  #3104's #2918 sibling, MVP-2 (#3274/#3272/#3259), trust epic C.

## Context

The sprint-79 recovery landed today: run.md restored (PR #3275), daemon
rebuilt/restarted at HEAD with idle-shutdown + quota fixes live, patch gate
cleared, mcp-cli registered as domain #1 (daemon writes now exercise real
domain_id paths). The DB migration is DONE — recon confirmed two planned
ship-blockers (#3152, #3255) already fixed on main, which is why this sprint
is verify/fix/rename + release infra, then cut **v2.0.0**. Risks: the gated
third sits on two files (state.ts, spawn path) — the serial chains are
load-bearing; #3013 lands early or a mid-sprint claude auto-update can strand
spawns; #3273 is 7× bigger than its issue claims (587 sites) and must go last.

## Run log (orchestrator, live)

**Concurrency amendment (operator, at run start):** 4 sessions max — **2 impl +
2 review/QA** — overriding the plan's "at most 3 sessions". Lane ordering and
all `blockedBy` edges are unchanged; only the number of simultaneous impl lanes
is capped.

**Plan-time board actions: DONE.** Closed #3152, #3255 (both verified already
fixed on main, file:line cited). Commented #3036 (needs-clarification), #3041
(defer epic B + dup of #3192), #3155 (rescope). Filed splits: #3278 (DDL-in-txn
rule), #3279 (import-guard regression test), #3280 (#3110 sym1/2 readiness
design), #3281 (#3246 daemon-side cwd design), #3282 (#3254 merge-on-collision
design).

### Status

| # | Phase | PR | Session | Note |
|---|-------|----|---------|------|
| 3213 | qa | #3287 | impl 20df14e0 / qa 945b4cce | triage scored low (29/15, 1 src file) → QA direct, no review round |
| 3013 | impl | — | b89804ce | implemented, holds gate baton |
| 3104 | impl | — | ef3aa49b | launched with live repro captured this session |

### Issues filed during run (beyond the plan-time set)

- **#3284** — work-item poller re-emits actionable `ci.finished` for untracked
  items on long-merged PRs, **every poll cycle**, and the stale set **rotates**
  (it is exactly the six items destroyed by the #3240 untrack trap in sprint 79).
  Structural tell: `observedDurationMs: 0`. Orchestrator workaround is a grep
  exclusion on that field.
- **#3286** — `am-i-done` cannot fit its own 5m deadline on a shared box
  (steps 1-11 ≈3m20s + coverage ≈2m45s ≈ 6m05s; #3261/#3268 kills it mid-coverage).
- **#3285** — (from #3013's worker) stale patch blocks spawns that would use
  stdio and never touch the patch.
- **#3283** — (from #3213's worker) `OR IGNORE` rule, deliberately not bundled.
- Data points added to existing issues: **#3178** (mail: unknown positional
  sends an empty message — hit live), **#2690** (starvation signature, with full
  process ancestry proving a cross-repo cause), **#3284** (recurrence + rotation).

### Decisions

- **#3286 is NOT being fixed mid-sprint — deferred to sprint 81 planning.**
  The workaround (all 12 steps green across two invocations, never a subset)
  costs time but leaves nothing unverified, and CI on clean runners is the real
  arbiter. The actual question — whether 5m is the right deadline, whether it
  should be per-step, whether it should scale with load — is a design decision,
  and #3261/#3268 landed it only days ago. Bumping a wall-clock deadline under
  time pressure is precisely the "accommodating a failure" Red Flag; it gets
  decided at planning, not improvised by a worker mid-sprint.
- **Cross-repo contention is the sprint's dominant tax.** `clrg-stats` is
  running its own multi-lane sprint on this box and cycles gates continuously
  across worktrees. It cannot be batoned and must not be touched. Gates are
  released at load < 8 (evidence: a clean run was observed at 7.7), not at a
  quiet box, which never arrives.
- **`review-fn.ts:179` hardcodes `--worktree`**, ignoring `worktree_path`, so
  blind `mcx phase advance` would strand a reviewer on a scratch branch (the
  sprint-66 failure). `qa.ts` correctly honors `worktree_path`. Orchestrator
  must hand-build review spawns with `--cwd` until #1286 lands.
