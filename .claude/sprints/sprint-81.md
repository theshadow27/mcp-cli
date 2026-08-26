# Sprint 81

> Planned 2026-08-26. Target: **10 PRs** (operator cap — see Capacity below).
> **Started 2026-08-26 19:55 UTC** at main `f2352e84`.
> Quota at run start: 5h **12%**, 7d **27%**, extra-usage 32% — normal, no gating.
> (Plan-time note said quota was not readable; `mcx call _metrics quota_status` works — #3182 is the missing `mcx quota` CLI surface, not a missing metric.)
> Concurrency: 3 lanes, serial within each.

## Goal

**Ship v2.0.0 and end the release hold.** `/sprint review` at wind-down cuts the release.

**The goal is checkable against this issue list, and was checked.** The ten issues
below contain every remaining MVP-1 exit criterion from the plan of record (the
2026-08-24 recovery comment on #3019), re-verified after the #3155 audit closed on
2026-08-25. Nothing on the exit-criteria list is deferred out of this sprint.

This check is the direct response to sprint 80's central failure: its goal promised
to cut v2.0.0 while its own **"Deferred (named)"** section deferred six exit
criteria in the same file. A perfect sprint 80 could not have shipped. Any amendment
to this plan must re-run the check.

### How the exit criteria moved during planning

The nominal list was nine open blockers. Three were not work:

- **#3041** — duplicate of #3192 (same lines, same fix, per the operator's own
  2026-08-24 comment). **Closed.**
- **#3231 / #2993** — already done. `release.yml` pins `bun-version: "1.4.0"` at both
  setup-bun sites (PR #3346 hit the release workflow, not just CI); sub-issues (a)(b)(c)
  closed or landed via #3263/#3241/#3267. **#2993 closed; #3231's MVP-1 slice is
  "cut the release", which is `/sprint review`.**
- **#3155** — the audit ran at planning time rather than in-sprint, precisely so its
  discoveries could not re-block the release at wind-down. **Closed.**

And the audit added two:

- **#3352, #3353** — both meet the pre-declared cut line (production writing to, or
  reading across, the wrong domain on main today), both reproduced.

## Issues

| # | Title | Scrutiny | Lane | Model | Category |
|---|-------|----------|------|-------|----------|
| 3209 | phase-state repo_root derived 5 ways → one `workItemStateRoot` | **high** | 1 | opus | goal |
| 3352 | monitor events stamped with the daemon's domain, not the item's | medium | 1 | opus | goal |
| 3192 | daemon binds automation manifest + repo detection to `process.cwd()` | **high** | 1 | opus | goal |
| 3273 | rename StateDb→McxDb — **last, alone, zero other sprint PRs open** | low | 1 | **sonnet** | goal |
| 3246 | `normalizeDomainPath` → INVALID_PARAMS (secondary half only) | medium | 2 | opus | goal |
| 3036 | `-d <domain>` resolution across the CLI | medium | 2 | opus | goal |
| 3353 | `pr-merged-to-done` advances an arbitrary domain's work item | **high** | 3 | opus | goal |
| 3265 | copyAtomic rename-over-symlink spec (steps 1 and 4) | low | 3 | opus | goal |
| 3332 | pre-push gate deadline 300s → 600s, matching CI | low | 3 | opus | protect |
| 3351 | flaky shared-worktree-guard assertion (already red on PR #3350) | low | 3 | opus | protect |

**Model notes.** #3273 is sonnet: a repo-wide mechanical rename, 74 files in
`packages/daemon` plus one in command and one rule, sites enumerable by grep, no
design. Everything else is opus. Fable appears nowhere. Review and QA are sonnet
per run.md — **including the gated class** (fixed in #3290; `review-fn.ts` used to
inherit the plan's *implementation* model and spawn opus reviewers).

### Scrutiny-mix sign-off (required — 3/10 high, over the ~20% cap)

**Operator sign-off: granted 2026-08-26, explicitly, at planning.**

Per-issue justification, as the rule requires:

- **#3209** — re-keys phase state. Carries an undecided migration question that can
  strand existing rows. DB keying is gated-class.
- **#3192** — changes daemon startup and cross-domain automation dispatch. Wrong
  behaviour here is a silent write into another project. Isolation is gated-class.
- **#3353** — production writing to another domain's partition. This *is* the
  containment failure, not a proxy for one.

None is high for being large. #3273 is the biggest diff in the sprint (~610
occurrences across 75 files) and is **low** — mechanical, no behaviour change, and
review budget spent there is waste.

### Design decisions made at planning (no human gates mid-sprint)

- **#3036** — ticket rewritten at planning against commands that exist. The original
  named `mcx card`/`sensor`/`loop`, which do not. Scope is the six surfaces that reach
  a `domain_id` table; `extractDomainFlag` (`parse.ts:209`) and `resolveDomainForPath`
  already exist and must be reused, with `mcx monitor -d` as the reference behaviour.
- **#3352** — the in-code justification for injecting the daemon's `repoRoot`
  ("`work_items` has no `domain_id` writer yet — #3036/#3037") is **stale**: #3037 is
  closed and the writer exists. Remove the injection; do not preserve it behind a flag.
- **#3353** — the rule must read the event's domain. `findByPr`'s cross-domain
  exemption is correct at the query; the defect is one caller away, in
  `derived-rules.ts:34-58`. Fix the caller, not the query.
- **#3246** — secondary half only. The primary half (daemon-side cwd injection) is
  #3281, `design`, unresolved resolution order — explicitly **out** of MVP-1.
- **#3273** — rename only. The importer **ships** in 2.0.0; it is the 1.14.x→2.0.0
  upgrade path. Deleting it is a later-2.x decision.

## Sequence — three lanes, serial within each

Nothing stacks on an unmerged base. A dependent launches only when its parent has
**merged**, never on batch membership.

**Lane 1 — `packages/daemon/src/index.ts` (the hard chain, strictly serial):**
`#3209 → #3352 → #3192 → #3273`

All four touch `index.ts` — #3209 at the `automationRepoRoot` derivation (:1001),
#3352 at the three producer injections (:1156-1162, :1541-1544, :1589-1601), #3192 at
:653/:864/:957/:966/:1001, #3273 at :1527/:558. Never parallel.

- #3209 first: it lands the single derivation *before* anything else churns those lines.
- #3352 second: a live data-correctness bug, and it inherits a stable `repoRoot` story.
- #3192 third: it rewrites the block #3209 just corrected, so it goes after and
  inherits `workItemStateRoot`.
- **#3273 last and alone** — launches only when **zero other sprint PRs are open**.
  One sitting, fresh main. A 610-site rename open across another merge is pure rebase cost.

**Lane 2 — core/domain + CLI (serial):** `#3246 → #3036`

Both touch `packages/core/src/domain.ts` resolver semantics. #3036 additionally
touches `commands/track.ts`, which #3209 also touches.

**Lane 3 — independents pool (any order, one at a time, disjoint from lanes 1–2):**
`#3353`, `#3265`, `#3332`, `#3351`

- #3353 → `derived-rules.ts`; #3265 → `upgrade.spec.ts`; #3332 → `scripts/_runner/runner.ts`;
  #3351 → `cli-orchestration.spec.ts`. Mutually disjoint and disjoint from L1/L2.
- This lane is the backfill that keeps slots warm while an L1/L2 head sits in review.
- **Launch #3332 first in this lane** — it raises the gate deadline every other
  session in the sprint will run against.

### Dependency edges (run phase → `addBlockedBy`; parent must be MERGED)

- `#3352 blockedBy #3209` — same `index.ts` block; #3209 lands the derivation first
- `#3192 blockedBy #3352` — rewrites the block #3209/#3352 just corrected
- `#3273 blockedBy #3192` — **and** launches only when no other sprint PR is open
- `#3036 blockedBy #3246` — shared `core/src/domain.ts` resolver semantics
- `#3036 blockedBy #3209` — shared `packages/command/src/commands/track.ts`

### Hot-shared file watch

`packages/daemon/src/index.ts` (#3209→#3352→#3192→#3273, serial — the whole of lane 1).
`packages/core/src/domain.ts` (#3246→#3036). `packages/command/src/commands/track.ts`
(#3209→#3036). `packages/daemon/src/db/state.ts` + `db/work-items.ts` + `mail-server.ts`
(#3273 renames these; nothing else in the sprint touches them, which is why the rename
goes last).

**Re-run this overlap analysis on every plan amendment.** Predict the amendment's
touched files, cross-reference against all ten above, and add a `blockedBy` edge or
push it to a later slot before launching. Sprint 73 skipped this and forced a manual
merge-order intervention.

## Capacity

**Cap: 10 issues, operator directive.** Sprint 80's retro action 7 asked for
NTE 10 "until the degradation is root-caused and fixed" — the last three sprints all
closed without finishing their work. This is the first sprint under the cap.

**Deliberately dropped to hold it:** #3211 (a killed `git push` orphans its gate,
which keeps running to no purpose). With pre-commit now static-only — measured at
**20.6s** on this box after #3347 and the TypeScript 7 move — and pre-push going
through the `gate-lease` admission control, the orphan window is materially narrower
than when the issue was filed. It goes to the top of the sprint-82 bench, alongside
**#3226** (pre-push test-changed is not diff-scoped: a core-barrel change selects
221/387 spec files). #3226 is the larger throughput win but its core-barrel import
churn fights #3273's rename for the same files, so it waits until the rename has landed.

## Wind-down deliverable: cut v2.0.0

**Budgeted as sprint scope, not a free action.** The release covers sprints 66–80 —
everything since v1.14.6 on 2026-07-13, which is ~15 sprints of changelog. It is also
the **first real exercise of the versioned-install machinery**, which landed dormant
(`~/.mcp-cli/bin/`) and has never run.

Breaking change justifying the major bump: the `mcx.db` schema replaces `state.db`.
The legacy importer ships as the upgrade path.

## Context

Sprint 80 merged 13 PRs (11 of 15 planned, plus two operator-directed toolchain
items) and its three-lane serial structure held — nothing stacked on an unmerged
base, so the sprint-78 failure mode did not recur. Two more PRs merged after its
retro was written (#3349 closing #3247, and #3350 moving to TypeScript 7.0.2).

The board is 417 open issues; the survey covered the newest 250. The largest arc by
far is the #3019 harness epic (~94 issues, slices #3044–#3103), which is **dormant by
design** behind MVP-1 — do not pull from it. The live clusters worth knowing about:
gate/CI self-execution (~25, of which this sprint takes two), containment-bypass
security (#3117 + #3126 are the two distinct defects; #3109 is a dup of #3117),
GH-token scoping (#3141 is architectural and the only one that *defeats* the model;
#3108 is the coverage gap), and flaky tests (7 of 11 share one root cause and #3262
is the actual fix — bumping their timeouts would be the classic wrong move).

### Risks

- **Lane 1 is four items deep and strictly serial.** It is the critical path. If
  #3209 stalls, the whole lane stalls. Watch it first; the L3 pool exists to keep
  slots warm while it moves.
- **#3036 is the largest unknown.** Its ticket was rewritten today, so no session has
  ever worked it. Scope is threading, not new design, but it touches a hot dispatch file.
- **The release cut is unbudgeted work if treated as free.** It is named above so it
  is not.

### Plan-time board actions (completed at approval)

- Closed **#3041** (dup of #3192), **#2993** and **#3231(d)** (already done — `release.yml`
  pinned by #3346), **#3282** (already done — `resolveKeyConflicts` shipped in #3348, an
  unrecorded sprint-80 scope expansion), **#3155** (audit complete),
  **#3004 / #2313 / #2210** (Bun 1.3.14 crashes; the repo runs 1.4.0 everywhere).
- Rewrote **#3036**'s body against commands that exist.
- Commented **#3231** with its full checklist status.
- Commented **#3259**: its part 4 is unbuildable (no merge queue on this plan) and its
  motivating evidence — the unleased `bun run test:coverage` in pre-commit — was fixed
  by #3347. Recommended retitle-or-close; left open for the operator.
- Applied meta fixes **#3290, #3297, #2893** and the two sprint-80 retro actions
  (delete the hand-run gate baton from run.md; ban bespoke briefs) via PR #3359.
  **#3061's 828→350 distillation is NOT done** — run.md is still ~980 lines; the issue
  stays open for a focused pass.
- Did **not** file the `core.hooksPath` issue from retro action 5: the premise is
  false. `core.hooksPath` is `.git-hooks`, **relative**, resolved per working tree —
  so each worktree runs its own checked-out hook, the opposite of what the retro
  concluded.
