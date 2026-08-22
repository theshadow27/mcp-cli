# Sprint 79

> DRAFT — written 2026-08-22 during sprint 78's run. Revise against sprint 78's Results
> and its orchestrator's "what the design docs got wrong" report before committing.
> Target: 15 PRs.

## Goal

Land **epic C (trust)** — authority, envelopes, permit/deny/flag, and the console auth gate —
plus **epic I (spend + quota)**, the two sub-epics that unblock on A alone.

## Context

C is foundational, not a hardening pass: provenance cannot be retrofitted, and the console
in sprint 82 binds `0.0.0.0`, which is only reasonable *because* auth is mandatory. So C
lands two sprints ahead of the thing it protects.

C and I are the two remaining answers to the three gaps **none of the four prior generations
closed** — no authentication on any web surface (C), no cost or quota management (I), no
multi-project isolation (A, sprint 78).

Most of C is new files rather than edits to existing ones, so the collision surface is
unusually small for a sprint this size. The exceptions are noted below.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 3107 | claude: intercept `/goal` like `/clear`/`/model` + `spawn --goal` | medium | 1 | opus | goal |
| 3138 | gate-lease fails open and ADMITS — make it block, or make the fail-open loud | medium | 1 | opus | QoL |
| 3201 | rule: tests/guards that report healthy about code that never runs (shapes 1/2/4) | high | 1 | opus | rework |
| 3104 | `[RATE LIMITED]` is sticky for the whole turn | low | reserve | opus | filler |
| 3047 | trust: envelope + disposition core — `chainPermitsAt` as the containment predicate | high | 1 | opus | goal |
| 3055 | spend: per-domain rollup from `agent_sessions` | medium | 1 | opus | goal |
| 3048 | trust: tag-neutering + control-char escaping | high | 2 | opus | goal |
| 3050 | trust: default classifier — authority-parameterized, err toward flag | high | 2 | opus | goal |
| 3051 | trust: rings per sensor + `min_authority` on actions | medium | 2 | opus | goal |
| 3053 | trust: counters + `trust.deny_rate_threshold` | low | 2 | opus | goal |
| 3054 | console auth — one-time code, session cookie, refuse-to-bind | high | 2 | opus | goal |
| 3056 | spend: transcript scrape, deduped by `message.id` | medium | 2 | opus | goal |
| 3057 | spend: per-domain budget enforced at the spawn point | medium | 2 | opus | goal |
| 3049 | trust: the containment gate — content or stub, before the request is built | high | 3 | opus | goal |
| 3052 | `mcx trust ls\|flow\|show\|promote\|flagged` | medium | 3 | opus | goal |
| — | *(reserve ×2: sprint-78 spillover — likely #3044, #3042, or the #3063 fix if it slipped)* | — | 3 | opus | goal |
| — | *(reserve ×2: fillers from the sprint-77 remainder — #1939, #1964, #1829)* | — | 3 | opus | filler |

## Batch Plan

### The rework lane — #3201, and why it is not a QoL pick

Measured, not guessed: **14 of sprint 78's 18 repair rounds** cited this one defect class
as a driver of at least one blocker (78%); it **dominated 9 of 18** (50%); and it caused
**2 of 2 QA fails**. It also produced the rounds that made #3034 and #1249 the sprint's two
longest PRs. Both figures are a floor — only findings the orchestrator restated in his own
words could be classified.

So this is not orchestration quality-of-life, it is **the sprint's dominant cost centre**
and it comes out of goal budget, not the QoL budget. Use **9/18** for the conservative
claim in the retro and **14/18** for the remedy's target.

Four shapes: (1) tautological test — expectation derived from the same source as the code;
(2) guard or branch that cannot execute; (3) vacuously-satisfied success signal;
(4) assertion with no assertion power. **1, 2 and 4 are statically detectable and go in a
rule; only 3 needs brief prose.** That is *less* prose than the enumerate-every-call-site
clause and targets 14 rounds instead of 6.

Shapes 1-3 **recur across rounds within one PR** — the `domains.spec.ts` tautology was
found in round 2 and again in round 3. That recurrence is why PRs took four rounds instead
of two, which is where the wall-clock went.

Note also that line coverage is blind to it: `domain-server.ts` reports **98.29%** while
three of its guards are freely deletable with a green suite. The ratchet will not catch
this class.

### QoL budget note (2 of 2 spent)

**#3107** (`/goal` intercept + `spawn --goal`) and **#3138** (gate-lease fail-open).
#3104 drops to reserve — it is a display annoyance; #3138 taxes every gate run in the
remaining 5-6 sprints of the arc.

Why #3138 earned the slot, decided 2026-08-22 on evidence rather than on the morning's
guess: the lease does **not** serialize. It waits ~5 min and then admits **unleased**.
Three occurrences in sprint 78's own transcript (~06:45, ~07:35, ~19:0x), two of them in
the sprint's first 2h10m, so it is the steady state and not a tail event. Consequences:
(a) `slots=1` stays satisfiable at load 40 — this is the mechanism; (b) every
transcript-derived hours-lost figure is a **floor**, since an unleased admission is
invisible unless you grep two lines above a green `✅ all checks passed`; (c) *"the lease
will queue me, so starting is safe"* is false reasoning that a **careful** worker uses.

Fix direction is not capacity or threshold tuning: **make the lease block (refuse + retry),
or make the fail-open loud (non-zero exit / unmissable banner).** Two quiet lines above a
green result are indistinguishable from success. Not meta — `packages/core/src/gate-lease.ts`
plus `scripts/_runner/*` — so it is worker-eligible.

### Batch 1 (immediate)
#3107, #3138, #3201, #3047, #3055, plus sprint-78 spillover

### Batch 2 (opens when #3047 and #3055 merge)
#3048, #3050, #3051, #3053, #3054, #3056, #3057

### Batch 3
#3049, #3052, spillover, fillers

### Dependency edges (already wired as GitHub `blocked_by`)

- #3048, #3050, #3051, #3052, #3053, #3054 all blockedBy **#3047**
- #3049 blockedBy #3047, #3048 — the gate needs the neutering pass it calls
- #3052 blockedBy #3047, #3050 — `trust promote` runs the classifier
- #3056, #3057 blockedBy **#3055** — both consume the rollup's source-labelling contract

### Security rides alongside, outside the QoL budget

Operator, 2026-08-22: *"you can always do security fixes."* So these are **additional** to
the two QoL slots, not competing with them:

- **#3117** — `ContainmentGuard`'s Bash parsing never runs for the documented spawn line.
  Direction is *not* to deny `Bash` (withdrawn on operator guidance) but to get contained
  sessions into a mode whose own classifier gates commands, with the guard as second layer.
- **A `doing-it-wrong` rule that the spawn path can never emit
  `--dangerously-skip-permissions`.** Cheap, permanent, and it mechanizes the one mode the
  operator named as unacceptable. Good candidate to bundle with #3117.
- **Rename mcx's `PermissionStrategy.auto`** — it means *allow everything*
  (`permission-router.ts:48`) and is the default for every spawn, one word away from Claude
  Code's auto mode which means nearly the opposite. A name collision on the permissive
  default is a bug waiting to be written.

### Orchestration-reliability picks come first

**#3107 and #3104 are batch 1 ahead of epic C, deliberately.** Both are small, and both pay
off across every remaining sprint of the arc rather than only this one:

- **#3107** makes `/goal` bind an orchestrator's exit criterion in the harness instead of in
  a brief. Every mitigation for the stopped-orchestrator failure so far has been prose, and
  prose is what failed — sprint 77 sat stopped 19 days, sprint 78's orchestrator stopped 11
  minutes into batch 1 believing it was watching. This is the epic's own thesis applied to
  the orchestrators running the epic.
- **#3104** removes the false throttling signal that made sprint 77's freeze look
  unrecoverable and produced a false alarm again at sprint-78 launch.

Landing reliability fixes before the next four sprints of feature work is worth two slots.

### Hot-shared file watch

- **`packages/daemon/src/claude-session/ws-server.ts`** — #3107 edits `sendPrompt`
  (:1196-1217). Sprint 78's #3063 containment fix is in the same file. **#3107 blockedBy
  #3063** — do not launch it until that has merged, and brief a rebase check.
- **`packages/daemon/src/metrics.ts`** — #3053 only.
- **The daemon spawn gate** — #3057 puts the per-domain budget there. Epic E's `mcx loop
  on|off|pause` (#3078, sprint 81) puts the loop switch in the *same* place. #3057 must
  leave **one enforcement site that can carry two reasons**, not a bespoke budget check that
  #3078 then has to work around. Say so in the brief.
- **`packages/core/src/`** — C adds `trust.ts` and friends as new files; low risk, but #3047
  is the root and everything else in C imports its types, so serialize normally.
- Console auth (#3054) creates the auth module and a minimal authenticated endpoint. It must
  not grow the console page — that is #3091–#3099 in sprint 82.

### Pre-session clarifications required

- **#3047**: `chainPermitsAt` **is** the security property, so it is a pure exported function
  with an exhaustive case table, not a condition inlined at call sites. Empty chain → false
  (fail closed). High scrutiny → adversarial + QA.
- **#3049**: the reviewer must specifically look for the failure mode where someone
  "helpfully" adds the authority or the chain to the prompt so the model can decide better.
  **That change is a regression and it will look like an improvement.** Containment is
  reflexive: the model verifies nothing and spends no tokens on it. High scrutiny.
- **#3050**: the authority parameter is non-optional. An implementation that drops it still
  typechecks, still returns verdicts, and is wrong. Err toward `flag`, not `deny` — this is
  the one place the Claude Code prior art is deliberately not copied, because we have a human
  in the loop and it does not. High scrutiny.
- **#3054**: no `--no-auth`, no dev-mode exception, no localhost carve-out. A test must assert
  that no flag or config value produces an unauthenticated listener. High scrutiny.
- **#3057**: budget consumption must include **scraped** spend (#3056), or an operator blows
  through it by working in a terminal.

## Boundary work (78 → 79) — meta, orchestrator-driven, no worker slot

Done in the quiet window between sprints, while no phase machine is ticking. These
touch `.claude/phases/**` and `.claude/skills/**`, so they are unmergeable mid-sprint
and must never be dispatched to a sprint worker (meta-issue planning guard; #2331/#2570).

- **#3179 — `review:repaired`, the missing author-applicable state.** P1 for
  orchestration correctness. Today a repaired PR either carries no review label at all
  (phase-driven path — `review-fn.ts:257` erases `review:changes` on route-to-repair, so
  it reads as never-reviewed) or a stale `review:changes` (manual path — reads as
  unrepaired). The one true state is not representable, and the author's only available
  wrong move is to self-assert `review:pass`, which converts a reviewer gate into
  self-attestation. Caught in sprint 78 on #3168 only because the author wrote a
  paragraph about it instead of flipping the label.

  Strict ordering — gate before label, or a `review:repaired` + `qa:pass` PR merges
  clean without re-review: `phase-types.ts` (blocking) → `done-fn.ts` (merge gate) →
  `review-fn.ts` (set it) → tests → create the label → `docs/phases.md` →
  `.claude/skills/sprint/references/{run,review,retro}.md` →
  **`.claude/skills/bootstrap-sprint/{SKILL.md,references/lessons.md}`**.

  The bootstrap half is the load-bearing one: it builds the sprint skill for new
  projects, so a hole in the taxonomy there is inherited by every future project on day
  one. Include the staleness rule (a review label older than the current head is a lie)
  — without it, `review:repaired` just moves the lie one column over.

- **#3178 — `mcx mail` treats any unknown positional as a recipient.** Not meta
  (`packages/command/src/commands/mail.ts`), so this one *can* be a worker item — noted
  here only so it is not lost. Candidate filler for a later batch.

- **Starvation-signature guidance is hand-written into every dispatch — ~15 occurrences
  across ~10 briefs.** Each restates the same four symptom names (`handleWorkerCrash`,
  `findProcessesByCwd`, `reapWorktreeProcesses`, `ServerPool rate limiting`) and the same
  retry-once rule. A per-brief prose tax paid to compensate for #3138. Should be authored
  once in the impl/review phase scripts (`.claude/phases/*.ts` → meta, boundary work), and
  it can be deleted outright if #3138's fix makes the lease honest. Sequence it **after**
  #3138 so we do not mechanize guidance we are about to retire.

- **Standing reviewer clause: "verify by driving it, not by reading it."** Half of the
  #3201 defect class is authored by *reviewers*. #1510's QA fail was a reviewer declaring a
  path unreachable by reading it; QA tested it and it was reachable. From ~08:10 Dave began
  hand-writing that instruction into every brief, and it **visibly worked** — verdicts after
  ~13:30 read completely differently ("every finding was REPRODUCED against your head",
  "reproduced with a live probe", "re-measured with a stopwatch rather than accepted from
  the commit message"). A mid-sprint process change with a clean before/after, and the
  strongest single piece of evidence in the audit. Promote it from an ad-hoc per-brief
  correction to a standing clause in `.claude/phases/review-fn.ts` (meta → boundary work).
  It is what stops shapes 1-4 surviving into round 3.
