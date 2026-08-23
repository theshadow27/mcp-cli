# Sprint 79

> Planned 2026-08-22 (evening, post-halt). Started 2026-08-22T23:38Z. Target: 12 issues across 3 lanes.
> **First sprint under the lane model** (`references/lanes.md`, PR #3219).
> Supersedes the pre-halt draft at `.claude/boss/sprint-79.md` (branch `meta/boss-state`).

## Goal

Finish epic A on main — drain the five partial partition PRs in the disposition's
merge order, serialized — while opening the trust (C) and spend (I) fronts on
disjoint surfaces.

## Context

Sprint 78 halted at 82% weekly quota with 6/17 merged. The five open PRs are
closer to done than their labels suggest: `sprint-78-disposition.md` re-scored
every finding under the merge-risk bar and found zero standing blockers on four
of them. The graph re-verification (comment pending on #3019) confirmed the
dependency map and corrected one edge: **epic C never needed B** — trust can
start now. Quota is the constraint this sprint, not capacity: models below are
chosen deliberately lean; the orchestrator is Fable, implementers default sonnet,
opus only where the work is genuinely design-heavy.

## Issues

| # | Title | Scrutiny | Lane | Model | Category |
|---|-------|----------|------|-------|----------|
| 3035 | `mcx domain` CLI (PR #3160: apply decision (c), verify, merge) | medium | 1.1 | sonnet | goal |
| 3043 | domain worker (PR #3181: rebase, gate, merge — review:pass) | low | 1.2 | sonnet | goal |
| 3039 | agent_sessions domain scoping (PR #3168: rebase + drive the #3199 fix once, merge) | medium | 1.3 | sonnet | goal |
| 3037 | work_items domain scoping (PR #3175: rebase + drive finding 1 once, merge) | medium | 1.4 | sonnet | goal |
| 3038 | mail domain partition (PR #3200: rebase + verify the 4 claimed (a)/(b) fixes, merge) | **high** | 1.5 | opus | goal |
| 3170 | import counters lie after rollback (on-main defect, same files as chain) | low | 1.6 | sonnet | goal |
| 3047 | trust: envelope core | **high** | 2.1 | opus | goal |
| 3048 | trust: tag-neutering | **high** | 2.2 | opus | goal |
| 3055 | spend/quota per domain (epic I entry) | medium | 3.1 | sonnet | goal |
| 3119 | auto-permission-mode fix (PR #3137: drive F3 once, then merge or simplify-once) | medium | 3.2 | sonnet | filler |
| 3212 | guard-reachability harness (mechanizes the QA mutation check) | low | 3.3 | sonnet | filler |
| 3066 | card store entry (no deps — slack) | low | 3.4 | sonnet | filler |
| 3223 | quota monitoring dead on Linux (keychain-only token source) | medium | 3.5 | sonnet | QoL |

> **Amendment 2026-08-23T00:4xZ (#3223, QoL 1 of 2):** filed during this
> sprint's own run — the orchestrator's quota gate is blind on this box
> because `readClaudeOAuthToken` is darwin-only, so `QuotaPoller.poll()`
> silently skips forever and `quota_status` reports the misleading
> "Quota monitoring not started". Operator: "that seems like an important
> fix." Overlap check (run.md amendment gate): surface is
> `packages/daemon/src/auth/keychain.ts`, `quota.ts`,
> `metrics-server.ts:196` — **overlaps in-flight PR #3222**
> (metrics-server.ts), so #3223 is blockedBy #3222's merge. No lane-1
> contact.

**Scrutiny-mix sign-off required (plan.md Step 3b):** 3 of 12 high (25%),
above the ~20% cap. Justification, per issue: #3038/PR#3200 carries four
(a)/(b)-class findings whose fixes are claimed but unreviewed on a
force-pushed branch (DB schema + mail partition = gated class); #3047 and
#3048 are the trust module — containment machinery, gated by definition.
Everything else in the sprint is mechanical and rides QA-only.
**Operator sign-off:** the operator launched `/sprint 79` at 2026-08-22T23:35Z
after this plan (including the 25% high mix) was presented, with the words
"let's try it... carefully". Read as consent to the mix, with "carefully"
operationalized as: lane 1 leads, quota checked before every opus spawn.

## Lane Plan

Per `lanes.md`: max 3 lanes, fresh subagent per phase, no lane starts before
its foundation is merged, no session idles hot.

### Lane 1 — the partition chain (STRICTLY SERIAL — one PR in flight, ever)

All six links share `state.ts` / `import-legacy.ts` / `ipc.ts` /
`docs/domains.md`. Order is the disposition's merge order:

**#3160 → #3181 → #3168 → #3175 → #3200 → #3170**

- 1.1 **#3160** first — critical path; decision (c) is recorded on the PR
  (one-shot import is real: delete the three retry-promise strings, `--force`
  is sole recovery). Close N1/N2 accordingly, run the gate, merge.
- 1.2 **#3181** — conflict is pure base drift; rebase, gate, merge. Fold the
  #3214/#3215 supervisor findings ONLY if the rebase already touches those
  lines; otherwise they stay filed (they're unreachable until #3044).
- 1.3 **#3168** — rebase; **drive** the #3199 `bye --all` fix against merged
  main (one command, not a review round); merge.
- 1.4 **#3175** — rebase; **drive** finding 1's ancestor-root case once;
  merge. Risk call per disposition, recorded there.
- 1.5 **#3200** — high scrutiny: the four (a)/(b) fixes are claimed, none
  verified, and the reviewed SHAs are gone (force-push). Fresh adversarial
  pass against the current head (panel allowed, round 1 only), then QA with
  guard-mutation. Verify #3216 and #3217 die with this merge; close them
  citing the commit, or re-scope them if they survive.
- 1.6 **#3170** — the on-main `summarize()` defect, fixed after the chain
  drains (same files).

### Lane 2 — trust entry (disjoint: new module + docs/trust.md)

**#3047 → #3048**, serial within the lane. Opus implementers, adversarial +
QA, full gated-class treatment. Design authority is `docs/trust.md` + the
epic C body (#3023): permit/deny/flag chain, host-side only, no crypto
signing on one box. #3048's neutering follows the `claude` binary prior art
(nested wrapper tags neutered, `\uXXXX` escaping) captured in trust.md.

### Lane 3 — spend + hygiene (disjoint, small)

- 3.1 **#3055** — epic I entry; touches quota.ts/budget-watcher, no chain contact.
- 3.2 **#3119/PR#3137** — disposition: drive F3 (restore-path denial) once;
  if it reproduces, simplify-once; if not, merge. Oldest open PR, DIRTY.
- 3.3 **#3212** — guard-reachability harness; mechanizes qa.md's mutation
  check. Every rule it ships needs bypass fixtures (`@expect 1`).
- 3.4 **#3066** — slack only; start it if lanes 2–3 drain early. Never
  borrow lane-1 capacity for it.

## Dependency edges

- #3181 blockedBy #3160 (chain order — merge order, not code dependency)
- #3168 blockedBy #3181, #3175 blockedBy #3168, #3200 blockedBy #3175,
  #3170 blockedBy #3200 (chain)
- #3048 blockedBy #3047 (envelope before neutering)
- No cross-lane edges — lanes 2 and 3 touch no lane-1 file. Re-run the
  overlap check on any amendment (plan.md Step 4).

## Explicitly excluded (and why)

- **#3036, #3041, #3042, #3044, #3045** — dependents of unmerged lane-1 work.
  Foundation-first: they are sprint 80's candidates, not backfill.
- **#3209** (repo_root five ways) — real on-main defect, but its surface IS
  the lane-1 chain's surface; adding it mid-chain is the amendment-collision
  pattern. Sprint 80, first chain link.
- **#3103** (migrate phoenix/clrg/work) — descoped from epic J by operator.
- **#3218** — hardening checklist for #3181, unreachable until #3044; stays filed.
- **Accreted defect reports** (#3155, #3158, #3156, #3144, #3164→#3170, etc.)
  — verified real, kept open, sequenced into sprints 80+ with the A-tail.

## Quota & model policy (sprint-specific)

Weekly quota is ~82% consumed. Hard rules for this sprint: no opus outside
#3200/#3047/#3048; reviews are sonnet except gated-class; check
`quota_status` before starting each lane-1 link; if weekly utilization is
critical at run start, run lane 1 only (it is mostly verification and
merges, the cheapest path to "epic A done"). The orchestrator ends its turn
whenever all lanes are waiting — no idle-hot polling.
