# Sprint 78 schedule audit

**Auditor:** Mel (read-only) · **As of:** 2026-08-22 16:46 UTC · **Sprint clock:** plan committed
`0bfb3859` 05:25Z → now = **11h21m**

---

## Verdict

**Slower than it should be — but not because of the sprint's size or its dependency graph:
31% of the sprint was an unattended stall (only a third of which was real quota), and 64% of
all code commits are rework.**

---

## First: a premise correction

The brief says #3143 merged at "11:19 UTC" and that nothing has merged for "5h+".

`88b78bf5` merged at **15:19:37 UTC**. `11:19:37-04:00` is the same instant — `-04:00` is the
committer's recorded offset, which `git log --date=iso-strict` prints verbatim. STATE.md line 28
already has it right ("MERGED 2026-08-22 15:19").

**The merge drought is 1h27m, not 5h+.** Main is not frozen. Three of the six open PRs received
review verdicts in the last ~15 minutes (`#3175` ≈16:38, `#3160` ≈16:41, `#3169` ≈16:43). The
sprint is behind; it is not stalled *right now*. That distinction matters because it changes what
you'd intervene on.

*(Caveat on my own evidence: `gh` and the daemon socket are both unreachable from this session —
network and out-of-repo exec are blocked by the sandbox. Everything below is derived from local git
objects/reflogs and from the orchestrator's own transcript
`…/projects/-home-ubuntu-github-mcp-cli--claude-worktrees-sprint-78/dc1a5b12-….jsonl`, which is the
record of what Dave actually saw. Times inside the transcript are interpolated from a
line→timestamp curve; PR-event times are ±5 min, git times are exact.)*

---

## The numbers

### Bucket breakdown — 11h21m of sprint wall-clock

| # | Bucket | h:mm | % | Evidence |
|---|---|------|---|----------|
| A | Startup lost to a broken spawn path | 0:18 | 2.6% | 3 sessions "died at 05:30-05:31Z with 0 tokens each, leaving locked empty worktrees"; fell back to manual worktree + `--cwd`; first worker commit 05:43 |
| B | **Active work** (impl + review + repair + QA + CI) | **7:35** | **66.8%** | 05:43–09:52 and 13:20–16:46 |
| C | Genuine quota exhaustion | 1:08 | 10.0% | Dave hit the session-limit wall at 09:52; quota reset 11:00Z |
| D | **Dead air after quota reset — nothing woke anyone** | **2:20** | **20.6%** | first message after the wall is a `queue-operation dequeue` at **13:20:02Z**: *"stalled on a session-limit wall at 09:52; quota reset at 11:00 UTC and it is now 13:20. Nothing woke either of us."* |

C + D = **3h28m (30.6%) of the sprint with the orchestrator dead**. Repo-wide the silence is even
wider: **zero commits on any branch between 09:42 and 13:49 (4h07m)**.

### Where bucket B actually went

Of the 7h35m of active time, the foundation PR was in the review/repair loop for
**5h31m — 73%** (06:20→09:52 = 3:32, plus 13:20→15:19 = 1:59), with eleven issues behind it.
Everything else — three fillers landing, all of batch 2's implementation, and batch 2's first
review rounds — fits in the remaining **2h04m**.

### Rework

| Metric | Value |
|---|---|
| Code commits on issue branches | 28 |
| — initial implementation | 10 |
| — **repair commits** | **18 (64%)** |
| Mean review rounds per reviewed PR | **2.0** |
| PRs that passed review on the first pass | **1 of 10** (`#3111`/#1459) |
| QA fails | 2 (`#3113`/#1510, `#3143`/#3034) |
| Median review turnaround (repair pushed → verdict labelled) | ~36 min (n=5: 41/36/45/18/42) |
| Median repair turnaround (verdict → repair pushed) | ~35 min (n=6, excluding stall-spanning) |
| **One full review↔repair loop** | **~71 min** |
| Total loop cost | 18 × 71 min ≈ **21 lane-hours** |

### Cycle time — the whole finding in two rows

| | Cycle time | Rounds |
|---|---|---|
| The one PR that passed review first time (`#3111`/#1459) | **0h35m** | 0 |
| The three merged PRs that didn't (`#3113`, `#3125`, `#3143`) | **4h14m mean active** (2:59 / 4:11 / 5:31, stall removed) | 2 / 2 / 4+QA-fail |

**Rework multiplies cycle time by ~7×, and 9 of 10 PRs needed it.**

### Per-PR ledger

| PR | Issue | Scrutiny | First commit | Rounds | Outcome |
|---|---|---|---|---|---|
| #3111 | 1459 | low | 05:43 | 0 | **merged 06:18** (0h35m) |
| #3113 | 1510 | med | 05:51 | 2 + qa:fail | **merged 08:50** (2h59m) |
| #3125 | 935 | high/gated | 06:20 | 2 | **merged 13:59** (7h39m elapsed / 4h11m active) |
| #3143 | 3034 | high/gated | 06:20 | 4 + qa:fail | **merged 15:19** (8h59m elapsed / 5h31m active) |
| #3127 | 1249 | **low** | 06:00 | **5, open** | **10h46m and counting** |
| #3160 | 3035 | med | 14:25 | 2, open | review:changes |
| #3175 | 3037 | med | 15:19 | 1, open | review:changes |
| #3168 | 3039 | med/gated | 14:45 | 1, open | review:changes |
| #3169 | 3040 | med | 14:38 | 1, open | review:changes |
| — | 3043 | high/gated | 16:20 | — | committed, not pushed |
| — | **3038** | med | — | — | **never dispatched (see below)** |

*(#3137/#3119 is the boss's own PR, not Dave's — his transcript says so explicitly.)*

### Serialization — inherent, and not the problem

11 of the 12 arc issues are `blocked_by` #3034. That is inherent: epic A *is* the partition key.
But it did **not** cause idleness — Dave correctly stacked batch 2 on #3034's pre-merge branch
(five lanes committing 14:25–15:19, before the 15:19 merge), exactly as batch 1 ran five lanes from
05:43.

**The serialization cost was #3034 spending 5h31m of active time in review/repair, not the
dependency edges.** Two fewer rounds on it and batch 2 starts ~2h earlier — and the rebase wave
STATE.md flags as "non-trivial" for #3160 gets cheaper, because the branch it was stacked on would
have been rewritten twice instead of five times.

### Orchestrator overhead / lost capacity

- **The sprint launched into an existing rate limit.** At ~05:30 all six live sessions showed
  `[RATE LIMITED]` and five more were `disconnected`. Dave, at dispatch: *"sprint 77 died on quota,
  that's the risk I'm carrying into this sprint."*
- **Nothing watched the orchestrator.** Worker supervision is genuinely good — Max was caught
  "frozen at 671 tokens" within ~5 min, and an ~08:45 freeze alarm was correctly diagnosed as a
  gate-run artifact rather than acted on. The deck-watch monitor in STATE.md watches workers. It
  does not watch Dave, and Dave is the one that died for 3h28m.
- **Host contention — mechanism corrected, see the ADDENDUM at the end of this file.** ~14 of ~40
  `uptime` probes showed 1-min load > 12 (Dave's own admission threshold) on a 12-core box shared
  with phoenix; peaks 25.99 / 22.48 / 21.35. Dave managed it correctly with an explicit gate-hold
  directive. It remains smaller than buckets 1 and 2 — but I originally wrote that the gate lease
  "delays each gate run by minutes", and that is wrong. **The lease does not queue anyone. It waits
  ~4m48s and then admits unleased.** Confirmed three times in this sprint's own logs.
- **Spend:** 11+ named worker sessions. Final observed: Kurt $52.07, Bob $51.97, June $50.51,
  Pam $47.31, Oscar $42.99, Tess $36.45, Max $22.32 — order **$350–450** of worker session cost for
  4 merged PRs so far.

---

## Top 3 causes, ranked by hours

### 1. The unattended stall — 2h20m of pure dead air, plus a dropped issue (20.6% of the sprint)

Dave hit the session wall at 09:52. **Quota reset at 11:00.** Nothing resumed until **13:20:02**,
by an external message. Only 1h08m of the 3h28m was actual exhaustion; **2h20m was nobody knowing
to come back.** The `resetsAt` timestamp was available in `quota_status` the whole time.

The second-order cost is worse than the hours. Dave had sequenced batch 2 at ~08:25
(*"#3038 and #3039 after that"*). The 13:20 resume prompt named the PRs that were in flight —
#3125, #3127, #3137 — and **#3038 (mail scoping) was never picked back up.** It has no worktree, no
branch, no PR, and no mention after the stall. One of six batch-2 goal issues fell through the gap
and nobody has noticed yet.

### 2. Rework — 18 repair rounds, 64% of commits, a 7× cycle-time multiplier

**And it is one repeating class, not scattered one-offs.** Across three independent issues, the
round-1 blocker was *a safety invariant applied at some call sites but not all, or a failure path
that falls open*:

- **#1510** → `"a malformed MCX_GH_TOKEN_* var denies instead of inheriting"` → `"least-privilege
  default, real deny, fail-closed config"`
- **#935** → `"close the profile fail-open paths and the key-name leak"` → `"refuse to guess a
  restored session's profile"`
- **#3034** → `"sweep the seal-or-nothing and path invariants to every site"`; STATE.md's own
  summary: *"an import that committed rows it could not seal, a recovery path that did not work in
  two different forms"*

Same defect, three times, three different authors. That is a brief problem, and it is fixable —
these three account for roughly 6 of the 18 rounds.

Note what this is **not**: the rounds were not noise. STATE.md is right that "every round found
something real" on #3034 and that holding it for review was the correct call. The finding is that
the *first* submission should not have had them.

### 3. Orchestrator-authored scope churn on the lowest-value issue in the sprint

**#3127/#1249 — scrutiny `low`, a filler — has 5 repair rounds, 10h46m elapsed, and is still open.
It has now consumed more review rounds than the foundation epic.**

At least two of those rounds are self-inflicted. Dave asked the implementer for a `guardInterrupts`
SIGINT handler during a repair round; round 3 came back with *"one blocker, and it's in
`guardInterrupts` — **the signal handler I asked for**"*; Dave then cut it:
*"#3127 is having `guardInterrupts` cut — I withdrew the SIGINT handler I'd asked for."* Two rounds
spent adding and removing a feature nobody asked for, on the sprint's cheapest issue, while eleven
issues waited behind the foundation.

*Supporting mechanism (real, but I can't cleanly price it):* reviewers edited the sticky review
comment **in place** across rounds, which produces no timeline entry. Dave hit this repeatedly on
#3127 (*"the reviewer edited round-1 in place"*, *"EDITED IN PLACE across rounds — open the FIRST
comment"*, *"went idle at 49 turns — checking its verdict (likely another in-place sticky edit)"*)
and attributes a five-hour stall to it. It is the same failure mode as the standing
`feedback_verdict_must_reach_the_pr` program note, one level deeper: the verdict reached the PR,
but not as a new event.

---

## What would actually change next sprint's throughput

**1. Arm a wakeup at `resetsAt` on the wall, and put a watchdog on the orchestrator itself.**
The moment any session reports the session-limit wall, schedule a resume at the `resetsAt` already
in the `quota_status` payload. Recovers 2h20m — 20% of this sprint — and would have kept #3038 in
the batch. Pair it with a heartbeat on *Dave*: the deck watch monitors workers going quiet, and the
thing that went quiet for 3h28m was the orchestrator. A stalled worker costs one lane; a stalled
orchestrator costs the sprint.

**2. Put the repeating defect class into the brief as an acceptance criterion.**
Every medium/high-scrutiny brief ends with: *"Enumerate every call site of the invariant you are
adding, and show that sweep as a table in the PR body. For every failure path you touch, state what
it does when it fails — and it must fail closed."* This targets the exact class that took #1510,
#935 and #3034 into round 2, i.e. roughly a third of the sprint's rework.

**3. Freeze scope at review round 1, and cap fillers at 2 rounds.**
No orchestrator- or reviewer-requested *new behaviour* during repair — after the first verdict,
new behaviour is a new issue, not another round. And a `low`-scrutiny filler that hasn't landed in
two rounds goes back to the backlog. #1249 would have been closed out at ~09:45 instead of eating
five rounds, two reviewer dispatches and a lane for eleven hours.

*(Cheap add-on to #3, no budget required: reviewers post each round's verdict as a **new** PR
comment. Never edit a prior round's sticky. Dave has already written this directive into his own
briefs today — make it a standing rule.)*

---

## Revised sprint projection

**Arithmetic**

- Program: **59 implementation issues** across sub-epics #3021–#3030 (per STATE.md / the #3019 plan
  comment).
- Sprint 78 carries **12 of them** (#3034–#3045); the other 5 sprint issues are non-arc fillers.
- Landed so far: **1** (#3034). In review: 4. Implemented-not-pushed: 1. Not started: 6
  (#3038 + all of batch 3).

**Sprint 78 to completion.** Batch 2 needs ~2 more rounds each at ~71 min/round across ~5 lanes
≈ **2h30m**. #3038 + batch 3 = 6 issues from scratch: ~1h30m implementation + 2 rounds ≈ **4h**.
Finish ≈ **23:00–24:00Z → ~18h total for 17 issues ≈ 1.05h/issue** — assuming no second quota wall,
which at a 5h window cadence (reset 11:00 → 16:00 → 21:00) is not a safe assumption.

**Remaining program.**

| Scenario | Sprint-78 arc yield | Remaining ÷ per-sprint | Sprints after 78 | **Total** |
|---|---|---|---|---|
| 78 lands all of batch 3 | 12 | 47 ÷ 12 = 3.9 | 4 | **5 (78–82)** |
| 78 drops batch 3 to capacity | 8 | 51 ÷ 10 | 5.1 | **6 (78–83)** |

**6–7 sprints remains credible; 6 is the realistic centre, and 5 is reachable if items 1 and 2
above land.** The projection is *not* at risk from issue count — sprint 78 is clearing the arc at
roughly the planned rate even with a 31% stall and a 2× rework tax.

It is at risk from **wall-clock per sprint**. At ~18h/sprint plus boss planning between, six
sprints is ~5 working days of continuous machine time. Each sprint currently loses ~20% to an
unattended quota stall and runs a ~2.0-round rework tax. Fix those and six sprints is comfortable —
plausibly five. Leave them and 18h/sprint drifts toward 22h+ and the arc slips to **7–8**.

**One structural caution on the projection:** sprint 78 had the most favourable parallelism in the
whole program — epic A unblocked eleven issues at once. Epics C/D/E/F/G/H have their own internal
chains and will not fan out as wide. I'd hold 6 rather than bank 5.

---

## Sources

- `git log --all` (author + committer dates), `git reflog show origin/main`, worktree mtimes under
  `.claude/worktrees/` — all exact.
- Orchestrator transcript `dc1a5b12-31d9-4f6e-9c35-feb776cd1afc.jsonl` (2306 messages, 05:26–16:45Z)
  — label-state probes (`3143=[review:changes]`), `uptime` samples, `mcx claude ls` cost rows,
  dispatch briefs, and the 13:20 resume message.
- `.claude/sprints/sprint-78.md`, `.claude/boss/STATE.md`.
- Not available to this session: `gh` (network blocked), `~/.mcp-cli/*.db` and `mcx` (out-of-repo
  exec blocked). PR-event timestamps are therefore transcript-derived, ±5 min.

---

# ADDENDUM — 19:25Z: the gate lease fails open, and it invalidates part of my §3

Added after the boss's 19:10–19:25Z host-wide gate hold. The hold worked (load 9.0 → 2.6 in two
minutes; the blocked worker landed `3a5a8d21` on #3169 after two prior contention failures). In
the debrief the boss surfaced **#3138**, which corrects a mechanism I got wrong above.

## What I got wrong

I wrote that host contention "delays each gate run by minutes." That assumed the `am-i-done`
gate-lease **queues** contending gates. It does not. It waits ~4m48s and then **admits you anyway,
unleased**:

```
gate-lease: waiting for a free slot (all 1 busy) — 271983ms elapsed, 16319ms before fail-open (slots=1 …)
gate-lease: no admission within 288302ms — proceeding unleased (fail-open, #2690)
```

So the reasoning "the lease will queue me, therefore starting is safe" is **false**, and it is
precisely the reasoning a *careful* session uses. A conscientious worker waits five minutes, is
silently admitted into the contention it was waiting for, adds load while believing it is being
polite, then fails on `handleWorkerCrash` / `findProcessesByCwd` / `reapWorktreeProcesses` at
exactly 5000ms or `ServerPool rate limiting` — and retries.

## Sprint-78 evidence for #3138

Grepping the orchestrator transcript for the fail-open signature:

| Where | ≈Time | Event |
|---|---|---|
| L700 | ~06:45Z | 7 `waiting for a free slot` lines, then `no admission within 288302ms — proceeding unleased` |
| L899 | ~07:35Z | second `proceeding unleased (fail-open)` |
| L2880 | ~19:0xZ | `211795ms elapsed … no admission within 283601ms — proceeding unleased` (tonight's blocked worker) |

**At least three unleased admissions in sprint 78, two of them inside the first 2h10m.** Also
≥1 CI-level failure on the signature at ~15:25Z — `ServerPool rate limiting > throttles a burst
beyond the window budget` FAILED at 225.61ms — tracked as flake #3014.

Two consequences for the numbers above:

1. **My ~35%-of-probes-above-threshold figure measures a symptom that is partly self-inflicted.**
   Some of that load is unleased gates the lease admitted while reporting `slots=1`. STATE.md
   already says "`slots=1` can be satisfied while the box sits at load 40" — this is the mechanism
   for why.

   *Added 21:5xZ:* the lease is blinder still. Phoenix's ~6 live sessions turn out **not to be
   daemon-managed at all** — they are plain `claude` sessions, never registered via `mcx claude
   spawn`, so they hold no `agent_sessions` row. The lease therefore cannot see them **even in
   principle**, not merely because it is scoped per repo. A whole class of load-generating work on
   this box is invisible to the admission control that is supposed to govern it. This does not
   change the load figures — `uptime` measures every process regardless of who spawned it — but it
   does upgrade "`uptime` is the honest signal, the lease is not" from a heuristic to a structural
   fact.
2. **The measured hours are a floor, not an estimate.** An unleased admission is invisible unless
   you grep for two log lines above an otherwise green `✅ all checks passed`. Three sprints of
   this went unnoticed. I can only count what got logged into a transcript I can read.

## A finding I missed the first time

Dave writes the starvation-signature guidance **by hand into essentially every dispatch** — ~15
occurrences across ~10 distinct briefs (L870, 876, 878, 899, 1159/1165/1166, 2002, 2058, 2075,
2097, 2110, 2173/2182/2183), each restating the same four symptom names and the wait-and-retry-once
rule. That is a per-brief tax the orchestrator is paying to compensate for #3138/#2690 in prose.
It is not hours, but it is on the critical path of every dispatch, and it is the kind of thing that
should be one line in a phase script rather than re-authored ten times.

## Does this re-rank the top 3?

**No.** Provable cost here is ~15 min of fail-open waiting plus a handful of failed gate runs and
one CI retry — real, but an order of magnitude below the 2h20m stall (cause 1) and the 18 repair
rounds (cause 2). I am leaving the ranking as written.

What changes is **what to do about it**, and it is now a much better candidate for a sprint-79 QoL
slot than I implied: the fix is not "add capacity" or "tune the threshold", it is *make the lease
actually block, or make the fail-open loud*. A fail-open that prints two lines above a green result
is indistinguishable from success, which is why this survived three sprints. Given the standing
2-per-sprint QoL budget, **#3138 is the one I would spend a slot on** — it is small, it is
mechanical, and every sprint in the remaining 5–6 pays this tax on every gate run.

## Operating rule I am carrying forward

`uptime` before any full gate; above ~8 on this 12-core box expect contention failures. Two
failures on those four signatures is the limit — **do not take a third**; run the implicated specs
in isolation first (to pin it to the box rather than the diff), then mail `boss` for a window. That
escape hatch is what produced tonight's hold, and the hold is what landed `3a5a8d21`.

*Scope note on holds, for my own record:* a gate hold stops suite-running work only —
`am-i-done`, `bun test`, `bun build`, `git commit`, `git push`. Reading, reviewing, drafting,
filing issues and `git add` all continue. I over-applied it tonight by treating the hold as a
general stand-down; the instinct was right, the scope was wider than needed.

*Standing hazard, unchanged:* ~1 leaked `bun test/echo-server.ts` per suite-running session
(15 alive / 762MB / oldest 14h), reopened as **#2413**. **Do not kill them** — it is a teardown bug
being fixed at the spawn site, and the killer/reaper reflex is what caused the 69/70 collapse.

---

# ADDENDUM 2 — how much of the rework is "a check that reports healthy about something that does not run"

Boss question, 19:25Z. Answer: **most of it.** This is a sharper and better-named class than the
"fail-open / partial sweep" framing I used in cause 2, and it subsumes a large part of it.

Method: I classified each of the 18 repair rounds by the *review findings Dave quoted in his own
words* when he read the verdict and wrote the repair brief — not by the commit subject, and not by
reading the diffs (which I can't gate-run anyway).

## The number

| | Rounds | Share |
|---|---|---|
| Class cited as a driver of ≥1 blocker in the round | **14 of 18** | **78%** |
| Class is the *dominant* driver of the round | **9 of 18** | **50%** |
| QA fails caused by it | **2 of 2** | **100%** |

**Both QA fails in this sprint were this class.** So were the rounds that made #3034 and #1249 the
two longest-running PRs.

The four rounds with **no** instance of it, for contrast — this is what the residue looks like:

- #1249 round 3 — cut `guardInterrupts` (orchestrator scope churn, cause 3)
- #935 round 1 — "close the profile fail-open paths and the key-name leak" (true fail-open)
- #3034 round 4 — "sweep the seal-or-nothing and path invariants to every site" (partial sweep)
- #3035 round 1 — `--help`, malformed locations, single delete decider (ordinary correctness)

## It has four recognisable shapes

**1. Tautological test — the expectation is derived from the same source as the code.** The most
common, and the one that *recurred across rounds*:

- `domains.spec.ts:190-191` — *"compares three hardcoded literals against each other — nothing
  reads the database"* (#3034 r2). It came back in r3: *"tautology — CONFIRMED BY READING …
  matching round-2 finding 🟡4."*
- `domain-resolver.spec.ts:99-105` — *"loops 2000 paths then asserts `idForPath(...) === 3` —
  **which passes identically if the loop never ran**"* (#3040)
- #3035 r2 — *"your emptiness check is derived from `IMPORTED_TABLES`, **the same constant
  `copyEverything` iterates**"*
- #935 r2 — *"tautological test replaced by one that actually detects the regression"*

**2. A guard or branch that cannot execute.**

- `progress.ts:137` — *"unreachable `current < previous` reset **whose comment describes a path
  that cannot execute**"* (#1249 r1)
- #1510 r2 — *"unreachable with a real token, because trailing newlines are trimmed rather than
  rejected"*

**3. A success/terminal signal that is vacuously satisfied.**

- #1249 r2 — *"vacuously (no `started`, so no terminal owed) … **a clone that wrote every file and
  committed is reported as a failure with zero terminal events**"*
- #3034 — the import reaching `ran:true / totalCopied:0 / marker-written`; the cursor clamp that
  *"silently skipped live events"*

**4. An assertion with no assertion power.**

- #3039 r1 — *"tests nothing."*
- #3040 r1 — *"asserts nothing about the bound"*
- #1249 r5 — *"test both sides of its crossover"* (the prior test exercised one side)
- #1510 r1 — *"**vacuous assertions shipped here reading as coverage**"*

## The half nobody briefed for: reviewers do it too

The class has a second face, and it is why instances *survive* a repair round. #1510's QA fail at
~08:12 was exactly this: a reviewer declared a path unreachable **by reading it**, and QA
*"tested it and it's reachable."*

Dave found this himself and fixed it mid-sprint. From ~08:10 onward, every brief carries
*"reproduced by RUNNING, not reading. Hold your repair to the same standard — reproduce each fix,
do not reason that it works"* and later *"Verify that by driving it, not by reading it, **and state
in the PR body that you verified it**."*

**It visibly worked.** Verdicts after ~13:30 read differently: *"every finding was REPRODUCED
against your head"*, *"every finding was reproduced with a live probe"*, *"reproduced it myself
twice — once at the unit seam, once end-to-end"*, *"re-measured with a stopwatch rather than
accepted from the commit message"*, *"REPRODUCED against a legacy DB built from the real main
DDL, so treat them as facts, not opinions."* That is a mid-sprint process change with a legible
before/after, which is the strongest evidence in this whole audit for anything.

## What this changes about the next brief

It makes cause 2's remedy **cheaper and more mechanical than I proposed this morning.** Three of
the four shapes are statically detectable and belong in a `doing-it-wrong` rule, not in prose —
consistent with this project's stated preference and with the boss's own #2964 precedent
("mechanized as a rule, not a test seam"):

1. **tautological test** — expected value derived from the same module/constant the code under test
   consumes
2. **unreachable guard / dead branch**
3. **assertion with no assertion power** — `expect` on a literal; a loop whose body never feeds the
   assertion

Someone already proposed this inside the sprint, at L754: *"A lint or helper that requires a sink
be non-trivially populated before switching…"* — i.e. the mechanization was identified on day one
and never filed.

Shape 4 (vacuously-satisfied success signal) is semantic and does need a brief clause. And the
reviewer-side clause — **reproduce by running, not reading; state in the PR body that you drove
it** — should be promoted from Dave's ad-hoc mid-sprint correction to a standing rule, because it
is the thing that stops shape 1–4 from surviving into round 3.

## Why it survived three sprints: line coverage is structurally blind to it

Added by the boss, 19:4xZ — I did not have this and it closes the obvious objection to everything
above. On **#3181**, `domain-server.ts` reports **98.29% line coverage while three of its guards
are freely deletable with a green suite.**

That is the whole explanation for how a class this common went unnamed. The coverage ratchet is the
control we would naively expect to catch it, and it *cannot*: a tautological assertion, an
unreachable guard and a vacuously-satisfied success signal all **execute the line**. Coverage
measures that a line ran, not that anything would have noticed if it hadn't. Every one of the four
shapes is invisible to it by construction.

Corollary for the ratchet: a rising coverage number is not evidence against this class, and on
#3181 it was actively camouflage. That is an argument for the shape-1/2/4 detectors specifically —
they measure assertion *power*, which is the axis coverage does not have.

## The reframe that actually explains the wall-clock

Shapes 1–3 recur **within a single PR, across rounds** — the `domains.spec.ts` tautology was found
in round 2 and found again in round 3 ("matching round-2 finding 🟡4"). Four-round PRs are where
the hours went (#3034 at 5h31m active, #1249 at 10h46m and counting), and this is the mechanism.

So the remedy's target is **not "fewer defects" — it is "defects that do not survive round 2."**
That is a different and much cheaper objective: it does not require the first submission to be
clean, only that a round-2 fix actually retires the finding instead of relocating it. Both the
detectors and the reviewer clause serve that target directly; the "enumerate every call site"
clause I proposed this morning served the more expensive one.

## Caveats on this number

- **It is a floor, same as everything else here.** I can only classify findings Dave restated in
  his own words. Findings that stayed in the PR sticky comment and were never paraphrased are
  invisible to me.
- **Denominator drift.** 18 rounds as of 16:46Z. #3169's R7 and #3127's round 6 have landed since;
  Dave's transcript has grown ~2306 → ≥2880 lines. Re-check the ratio at sprint close.
- **Rounds bundle findings.** "Class cited in the round" (14) is not "the whole round was this
  class" (9). Both numbers are given above; use 9/18 if you want the conservative claim and 14/18
  if the question is "would a rule have touched this round."

---

# RE-RUN SPEC — for sprint close

Five figures to re-derive, all currently stale as of 16:46Z:

1. repair-round denominator (was 18)
2. class-cited ratio (was 14/18) and class-dominant ratio (was 9/18)
3. per-PR ledger
4. merge-drought / cycle times
5. **round-2 recurrence rate before vs after the reviewer clause** — new, requested 19:5xZ

## On (5): what I can and cannot honestly measure

The question is whether the "reproduce by running, not reading" clause changed *outcomes* or only
*verdict language*. It is the right test of the strongest claim in this audit and I should not be
the one who grades it leniently. Three problems, stated in advance:

**a. The split point is contaminated.** The clause entered the briefs at **~08:10–08:15**, right
after #1510's QA fail. What changes at **~13:30** is reviewers *reporting* that they reproduced.
Splitting at 13:30 means splitting on the treatment's own output — circular. The defensible split
is per-round: *did the brief for this round carry the clause?* That is checkable in Dave's
transcript, dispatch by dispatch, and it is what I will use.

**b. Right-censoring will manufacture a favourable result if I let it.** Pre-clause PRs (#1510,
#1249, #935, #3034) ran 4–5 rounds each; post-clause PRs (#3035, #3037, #3039, #3040) have had 1–2.
A finding can only recur if a round N+1 exists. A naive rate comparison would show "improvement"
that is pure censoring. Fix: compare **matched round-1→round-2 transitions only** — n≈4 vs n≈4.

**c. A confound I cannot remove, and it is a real alternative explanation.** The post-clause cohort
is all "scope table X by domain" — a homogeneous, near-template task, following a merged reference
implementation. That alone predicts lower recurrence, independent of any reviewer clause. The
cohorts also straddle the 3h28m stall and are largely *different sessions*. **With n≈4 per arm and
this confound, I will not be able to separate the clause from the task homogeneity.** Any result
here is suggestive, never decisive, and I will label it that way even if it favours the clause.

## What would make (5) decisive

Per-finding disposition: for each finding in round N, did it reappear in round N+1. That lives in
the PR sticky review comments, which I **cannot reach** — no `gh`, no network. Dave's paraphrases
name a recurrence only when he happened to flag it (the `domains.spec.ts` 🟡4 case was explicit;
others may not be).

**Concrete ask, if this figure is wanted at better than "suggestive":** someone with `gh` dumps the
review-comment bodies for the sprint's PRs to a file inside the repo — e.g.
`build/sprint-78-reviews.json` — before close. Then it is a real measurement instead of a proxy.
Otherwise I will report the matched-pairs proxy with the confound stated alongside it.

## Corpus assessment — `build/sprint-78-reviews.json`, validated 19:5xZ

Delivered by the boss at 19:37Z (653KB, 18 PRs). **Verdict: the measurement is feasible.** Better
than I expected, with one gap that matters.

**What is there.** 74 comments across 14 PRs, each with `body`, `created_at`, `id`. Rounds are
explicitly labelled in the bodies and findings carry 🔴/🟡 severity markers, so I can count
*findings*, not just rounds. Volume per PR: #3160 fourteen, #3143 nine, #3127 eight, #3168 and
#3181 seven each, #3113 and #2964 six.

**The in-place-editing fear was overstated.** I expected the sticky-edit hazard to have destroyed
the round-1 record. It did not: #3127 — the PR Dave explicitly flagged as edited in place — has
eight *distinct* comments carrying round markers 1 through 6. The per-round record is largely
recoverable.

**Three gaps, one of which is load-bearing.**

1. **`updated_at` is absent from the schema** (fields are `body, created_at, id, line, path, state,
   user`). This is the one that matters. Without it I cannot tell whether a body was rewritten
   after posting — and if a round-1 body *was* edited, its original findings are gone from the
   record entirely (GitHub's REST API exposes no comment edit history). A finding erased that way
   reads as "did not recur." **That biases the recurrence rate downward — favourably — in exactly
   the direction I pre-registered against.** One extra field on the refresh closes it.
2. **`review_comments` and `reviews` are empty arrays on all 18 PRs.** Consistent with the workflow
   — a "sticky review" posted via `gh pr comment` is an issue comment, so there is no separate
   review stream to miss. Noting it because the dump was described as carrying inline `path`/`line`
   findings and it does not.
3. **`user` is `theshadow27` on all 74** — every session pushes as the shared identity, so author
   attribution cannot separate reviewer verdicts from orchestrator notes from repair delta tables.
   I will classify by body content (severity markers, "delta table", round labels), which is
   inference rather than metadata. Reliable here, but it is a judgement layer and belongs on the
   record.

**Availability note:** the pre-clause arm (#3111, #3113, #3125, #3143 — all merged) is already
final and could be banked before close; only the post-clause arm is still moving. Held for a single
consistent pass to avoid method drift between arms.

## `updated_at` refresh, 20:0xZ — the hazard was real, and it forces a design change

8 of 74 comments were edited after posting. Two are minute-scale typo fixes (#3168, 18:46→18:47 and
18:50→18:56) and are trustworthy. **Six are long-gap rewrites, and every one of them is the FIRST
comment on its PR:**

| PR | posted → edited | gap |
|---|---|---|
| #3143 | 07:57 → 09:39 | 1h42m |
| #3113 | 06:55 → 08:00 | 1h05m |
| #3125 | 07:04 → 13:43 | 6h39m |
| #3127 | 07:14 → 13:38 | 6h24m |
| #2964 | 22:37 → 07:23 | 8h46m |

That is exactly the pattern Dave described — the reviewer editing round 1's sticky in place once
later rounds existed. GitHub exposes no edit history, so those round-1 findings are unrecoverable.

**The problem this creates: #3113, #3125, #3143 and #3127 ARE the entire pre-clause arm.** Excluding
compromised round-1 bodies does not weaken the comparison, it deletes one side of it. A
round-1→round-2 design is dead on arrival.

**The fix, and it is a better design anyway: match on round-2 → round-3 transitions, not
round-1 → round-2.** Only the first comment on each PR is compromised; rounds 2+ are clean
throughout (the sole exceptions being #3168's two typo fixes, which are trustworthy). Depth is
adequate on both arms — #3160 has 14 comments, #3143 nine, #3127 eight, #3168 seven.

And R2→R3 is a *closer* match to the actual question. The boss's reframe is "defects that do not
survive round 2" — that is literally the R2→R3 transition. The R1→R2 design was measuring one
transition earlier than the thing we care about.

## Executable classification scheme

Written out so the re-run does not depend on this session surviving, and so both arms are scored
under one scheme rather than drifting between passes.

1. **Type each comment** by body content (author metadata is useless — all 74 are `theshadow27`):
   `REVIEW_VERDICT` = ≥1 severity marker (🔴/🟡) plus `file:line` citations, not self-labelled a
   delta table · `REPAIR_DELTA` = contains "delta table" or per-finding what-changed structure ·
   `QA_VERDICT` = QA pass/fail language · `ORCHESTRATOR_NOTE` = short, no markers, no findings.
2. **Assign a round** from the explicit label in the body ("round 2", "round-2", "ROUND 3"). Where
   several appear, take the highest in the first 500 chars — that is the round being *reported*.
   Tie-break on `created_at` order within the PR.
3. **Extract findings** from `REVIEW_VERDICT` bodies: one per severity marker, keyed as
   **`(PR, file, symbol-or-line-bucket)`** — deliberately *not* the free text, which gets reworded
   between rounds and would understate recurrence.
4. **Recurrence** for a matched R2→R3 pair = `|R3 findings whose key matches an R2 finding| / |R2
   findings|`. Same key counts as recurred regardless of wording.
5. **Arm assignment is per-round**, on whether that round's dispatch brief carried the
   reproduce-by-running clause (checkable dispatch-by-dispatch in Dave's transcript) — **never on
   wall-clock**, per confound (a).
6. **Trust filter:** exclude every first-comment body on #3143, #3113, #3125, #3127, #2964 from
   finding extraction. Report n before and after.

Confound (c) is unchanged by any of this: the post-clause cohort is still homogeneous
"scope table X by domain" work following a merged reference implementation, and n≈4 per arm cannot
separate the clause from task homogeneity. **The corpus fixes the measurement problem, not the
inference problem. Report suggestive, especially if it favours the clause.**
