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

### Merges

| # | PR | SHA | Path taken |
|---|----|-----|-----------|
| 3213 | #3287 | df4de055 | triage(low) → QA → done. No review round. |
| 3104 | #3295 | 9c10dde6 | triage(high, churn) → review(pass) → QA(pass) → done. |

### Plan deviations (recorded, not silent)

- **#3104 was planned lane-3 "independent" but touches `ws-server.ts`** — the
  lane-2 spawn-path hot file, contended with #3289. Reviews ran in parallel;
  the MERGES were serialized. #3295 merged first, and #3289's repair was told
  to rebase **after** its gate completed (never mid-gate), to resolve
  `ws-server.ts` on the merits, and to stop and ask if the conflict turned out
  semantic rather than adjacent-line. Lane-3 disjointness should be file-verified
  at plan time, not assumed from the "independents" label.
- **#3104 triaged high (churn 154, 5 files, 3 packages) though planned medium.**
  Took the stricter path (review + QA) rather than the plan's label.
- **#3013 needed a repair round** — adversarial review found two 🔴 merge-blockers,
  each confirmed by three second-opinion agents plus a driven repro:
  (1) TLS/hostname mismatch — from the three "version unknown" branches a later
  refresh onto a *patched* binary still handed it `ws://localhost`, the exact
  silent connect failure the PR's own comments said must never happen; this
  **refuted the implementer's load-bearing claim** that the wss listener was
  already up. (2) the re-probe was synchronous `spawnSync` on a thread hosting
  live sessions (~55s freeze), regressing the module's own "keep serving
  in-flight sessions" invariant. Design decision made by the orchestrator
  (fail closed on transport mismatch + non-blocking probe + negative caching)
  rather than delegated, per "no human gates mid-sprint".

### Additional issues filed

- **#3290** — `review.ts` contradicts run.md twice: hardcodes `--worktree`
  (ignoring `worktree_path`, which `qa.ts` already honors) and picks opus for
  review where run.md mandates sonnet *including* the gated class. Both silent
  under `mcx phase advance`; the first would put a reviewer on a scratch branch
  reviewing `main` and report a meaningless verdict. Hand-overridden all sprint.
- Data point added to **#2944** — `quota_status` served a **60.6-minute stale**
  snapshot while reporting `available: true` and confident percentages, because
  the upstream 429'd continuously from ~22:00. Quota gating (80% freeze / 95%
  pause) ran on a frozen number for an hour. It is neither the "call failed" nor
  the "unavailable" case run.md says to ignore — that is the gap.

### Merges (running)

| # | PR | SHA | Path |
|---|----|-----|------|
| 3213 | #3287 | df4de055 | triage(low) → QA → done |
| 3104 | #3295 | 9c10dde6 | triage(high) → review → QA → done |
| 3013 | #3289 | 93a55f6a | review r1 (2×🔴) → opus repair → review r2 → QA → done |
| 3042 | #3305 | d575d803 | triage(high) → review → QA → done |
| 3180 | #3299 | 4d55e035 | triage(high) → review → QA → done |
| 3110 | #3308 | a75ae11a | triage(low) → QA(authored test, verdict withheld) → independent verify → done |

### Enforcement events (worth keeping — these are the process working)

1. **#3013 review round 1 refuted the implementer's load-bearing claim.** The PR
   argued the wss listener was already up so no restart was needed; review proved
   that holds only for the three "patching needed" branches — from the three
   "version unknown" branches a refresh onto a *patched* binary still produced
   `ws://localhost`, the silent connect failure the module's own comments forbid.
   Driven repro, confirmed by three second-opinion agents. Second 🔴: the re-probe
   was synchronous `spawnSync` on a thread hosting live sessions (~55s freeze).
   Orchestrator made the design call (fail closed on transport mismatch +
   non-blocking probe + negative caching) rather than delegating it.
2. **#3110 QA authored a test on the PR it was judging.** Caught before it
   labelled. Test kept (it closed a real `--clean` mutation-check gap); verdict
   withheld; a fresh session verified the fix AND the new test by mutation. Cost
   one extra session, ~10 min. "Self-repair is allowed; self-approval never is —
   for any change, however small the edit looked."
3. **#3264 ran a second concurrent gate without the baton**, at load 27.5/12,
   degrading #3110's QA gate simultaneously. Gates were NOT killed (already-spent
   CPU; killing is the wrong instinct) — the session was corrected and held at the
   gate boundary until the box was serial again.
4. **#3264 scope: `mcx version` display removed.** The plan said expose via
   `_metrics`, NOT `--version` (#2981 = `mcpd --version` dumps a minified stack
   trace). The worker's instinct was good — client-vs-daemon commit is exactly how
   you catch this sprint's own stale-daemon hazard — so it was filed as **#3311**
   with that justification rather than refused. Waiving scope freeze because the
   orchestrator liked an addition would hollow out the rule being enforced on
   everyone else the same hour.
5. **#3180 dropped its v9 table rebuild** after being asked what it buys: nothing
   reads `foreign_key_list`, the constraint is unenforced, and a rebuild is what
   bricked daemons in #3152. Preserved #3210 as the sprint's only migration.
6. **#3210 corrected its own issue's premise**: defect 1's mechanism is real but
   its stated frequency is not (one `StateDb` in prod, no await between pre-check
   and write) — latent hardening, not a live race. Also found rename takes no path
   at all, so the planning phrase "refuse non-existent paths at add and rename"
   can only apply at add.
7. **#3299 merged only after clearing a thread on the linked issue** (surface 4)
   left by #3160's review. The PR did address the wider form — the catch now
   branches on error type — so a reply citing the commit went up first. The
   commenter's diagnosis was sharper than the issue's: the old
   `blocking.length === 0 → rethrow` escape hatch could never fire under
   `cascade: true`, because rollback left dependents non-empty every time.

### CI reliability is the sprint's real bottleneck

Three independent intermittent failure modes, all pre-existing, all documented
with dated evidence this sprint:
- **#2915** — our own deliberate Bun-segfault repro (`scripts/bun-segfault-repro/`,
  upstream oven-sh/bun#28415) detonates and bleeds into whatever spec runs next.
  **Reproduced on clean main at 431ccc50**, where it detonated twice and the
  built-in panic-retry did not rescue it. The issue's "(main green)" no longer
  holds. Bleed target is not fixed (hit `runner.spec.ts` here vs
  `acp-cost-tracking-evidence.spec.ts` before).
- **#3014** — `server-pool.spec.ts:1885` rate-limiting, 1 fail of 3640. Two
  branches, two unrelated diffs, same line, same day.
- **#3018** — ACP load-flake family; `acp-session.spec.ts` runs **24.6s against a
  5s per-file budget** and logs **"killed 12 dangling processes"** (a teardown
  leak — likely the *cause* of that family, not another victim).

Cost model: a CI failure escalates an item to high scrutiny and costs a repair
attempt unless someone proves it innocent, so each detonation burns orchestrator
time proving innocence. **Not fixed mid-sprint** — CI surgery under time pressure
is the "accommodating a failure" red flag; all three go to sprint-81 planning with
options written on the issues.

## Run log — 2026-08-25 04:00-04:20, toolchain directive

### Operator directive (mid-sprint, in-scope by explicit instruction)

> "are we still pinned on bun 1.3.14 here? all the tooling needs to move to bun
> 1.4.0 ASAP. and any segfault-assuming/testing stuff should be removed. No
> segfaults on 1.4.0 should be happening"

Answer on investigation: the **box** was never pinned — it has run 1.4.0 since
2026-08-20 01:00. **CI** was pinned to 1.3.14 in 7 `setup-bun` sites plus
`package.json` engines. Every sprint-80 gate therefore ran on a different
runtime than the one grading the PR, silently falsifying the CLAUDE.md
guarantee that "a local pass means a green PR".

Filed **#3333** (pins + delete the crash-tolerance machinery, two PRs),
**#3337** (TypeScript 5.9.3 → 7.x; `latest` is 7.0.2 and the native compiler is
GA — typecheck is ~73% of static gate time), **#3341** (expose gate-lease as
`mcx gate run --` so neighbour fleets can share host admission control).

### Orchestrator inventory error, corrected by the worker

The #3333 issue body listed 8 pin sites. It **missed the runtime floor**:
`MIN_BUN_VERSION` in `packages/core/src/bun-version.ts`, its spec, and
README.md:36. Cause: grepped the YAML key `bun-version`, not the constant.
Engines is advisory; `assertBunVersion` actually refuses to start — shipping
`>=1.4.0` in engines while the binary accepted 1.3.14 would have reproduced the
PR #2077 bug. Worker caught it and bumped all three.

The same issue body also listed #2744 and #2780 as "do NOT remove" guards. They
are **internal properties of the tolerance**, not guards beside it: with the
promotion branch deleted, `classifyCoverage` collapses to `code === 0` and a
single panic fails. Deletion is strictly stricter. Approved as subsumed.

### Bun 1.4.0 result (gate run 1, cold worktree, contaminated)

Steps 1-11 of 12 **all green on 1.4.0**. Failure count 0 across typecheck, lint,
the full rule sweep and all five test steps. **No segfault, no panic, no
worker-panicked cascade.** Step 12 (coverage) killed by the #3261 wall-clock
deadline at 300263ms with no output — a deadline abort, not a crash. Correctly
classified by the worker and NOT escalated as the #3333 stop signal.

Standing rule adopted for this task: a PASS under load is a strong pass; a
crash under load proves nothing about 1.4.0 — discard the conclusion, keep the
evidence, re-run quiet, escalate only on a clean reproduction.

### #3332 — orchestrator argument retracted on the evidence

An earlier comment argued contention could not explain the gate variance,
citing a "load inversion" (failed at loadavg 2.20, passed at 10.47). **That
argument is unsound.** It measured contention with loadavg, the instrument
`gate-lease.ts:50-70` rejects at length. Direct on-box measurement from
tonight's gate log at 04:14:

```
gate-lease: admitted on slot 0 after 257ms — cpu 42% < 60%, slots=1 (#2690)
uptime at the same instant: loadavg 7.60 / 12 cores = 63% of core count
```

63% vs 42%, same box, same moment. Cold-`tsc` and contention were never
competing explanations — they compound.

Better diagnosis (worker's, filed on #3332): gate-lease's headroom signal *does*
see foreign load, but its only lever is **delaying admission**. After `waitMs`
the run proceeds anyway; foreign load then slows **execution**, and execution
time is not credited to the deadline — only queue time is (`runner.ts`
`leaseCreditMs`). A fleet that never calls `acquireGateLease` cannot be queued
behind, only waited on and then run against. Fires only when a neighbour is
busy, which is why it reads as nondeterministic.

Constraint carried forward: whatever #3332 lands must be on the way **in**, not
a reaper — `gate-lease.ts:37-49` names the sprint 69/70 collapse
(#2597/#2632, reverted in #2637) as the cost of getting that wrong.

### Cross-project contention — orchestration finding

The gate baton serialises mcp-cli sessions only. `clrg-stats` and
`phoenix-octovalve` run their own fleets on the same 12 cores and cannot be
batoned or killed. **A free baton is not a free box.** `gate-lease` is already
host-global (`~/.mcp-cli/gate-locks/`, flock, crash-safe) and already measures
CPU-busy rather than loadavg — but `acquireGateLease` is not exported from core
and has no CLI surface, so neighbours have no way to participate. #3341.

### Merged

| Issue | PR | Notes |
|---|---|---|
| #3260 | #3328 | forgeable install marker — repair verified by mutation, `qa:pass`, MERGED 04:19:58Z |

QA on #3328 mutation-verified both directions (reverting the hash compare fails
4 new tests; relaxing the sha256 shape-check fails the legacy-marker test),
confirmed legacy hashless markers fail closed, measured the 373ms hash cost as
off the startup path, and checked install.sh↔TS digest parity end to end.

### Issues filed this window

#3332 (corrected), #3333, #3334, #3335, #3336, #3337, #3338, #3339, #3340, #3341

### Retro carry-forward

- `.claude/memory/cpu-wedge-test-workers.md` says "we run 1.3.14" — stale once
  #3333 lands.
- `.claude/memory/feedback_quota_status_staleness.md` + MEMORY.md reference the
  literal `[RATE LIMITED]`, renamed by #3104 to `[rate-limited Ns ago]`.
- Baton handoff should carry a host-load check, not just lease state (#3341).
