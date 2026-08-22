# Dave — sprint-78 orchestrator — shutdown state

- **Session:** `e3007101` (name: Dave). Role: orchestrator, not an implementer.
- **Branch:** `sprint-78`, head **`9bc1b157`**, **PUSHED** (clean tree, nothing ahead of origin).
- **Container PR:** #3046, still **draft**, CONFLICTING (expected — it resolves at retro, which never ran).
- **Shutdown at:** 2026-08-22 ~22:15Z. Sprint started 05:28Z. ~16h45m elapsed.

---

## 1. Outcome

**6 of 17 issues merged.** All 6 verified `MERGED` with `mergedAt` set, not auto-merge-queued.

| Issue | PR | Merged |
|---|---|---|
| #1459 sites 500 retry | 3111 | 06:18:09Z |
| #1510 scoped GH_TOKEN | 3113 | 08:50:55Z |
| #935 spawn profiles | 3125 | 13:59:14Z |
| **#3034 mcx.db schema** | **3143** | **15:19:38Z** ← epic A foundation |
| #1249 vfs progress | 3127 | 17:07:53Z |
| #3040 alias_state/event-log/automation | 3169 | 22:12:07Z |

**5 open, all with work pushed by their authors (nothing of mine is unpushed):**

| PR | Issue | Head | Labels | Mergeable |
|---|---|---|---|---|
| 3160 | #3035 domain CLI | `dea17202` | review:changes | MERGEABLE |
| 3168 | #3039 sessions | `ac7e21e0` | review:changes | CONFLICTING |
| 3175 | #3037 work_items | `f9c5835a` | qa:fail, review:changes | CONFLICTING |
| 3181 | #3043 domain worker | `7a59b17a` | **review:pass** | CONFLICTING |
| 3200 | #3038 mail | `8677900f` | review:changes | CONFLICTING |

Four went CONFLICTING when #3169 merged at 22:12. They need rebasing onto new main.

**#3181 carries `review:pass` and is the closest to merge.** Its two open blockers (A, B)
are — in my judgement under the operator's final (a)/(b)/(c) bar — **not merge-blockers**:
both are defects in code nothing calls in production yet. See §4.

---

## 2. Exactly where I stopped

Awaiting the operator's per-PR disposition under the review freeze (issued 22:09Z).
I had just delivered a triage of every open finding against the new blocking bar
(data loss / security / regression-to-shipped). **My last action would have been:
merge #3181 and #3168 if the disposition agreed, since neither has a qualifying finding.**

Nothing was mid-flight from me. Three repairs were mid-flight from workers:
- #3037 (Oscar, `5f90b339`) — **simplification pass**, dispatched 21:44, supersedes repair round 4
- #3043 (Tess, `3baf78c0`) — focused A+B repair, dispatched 21:49
- #3035 (June, `10710e27`) — focused N1/N2/N6 repair, dispatched 21:25

---

## 3. **UNFILED FINDINGS — this is the section that matters**

None of these are on GitHub. They exist only here.

### 3.1 The phase machine was never in the execution path (HIGHEST VALUE)
`mcx phase run <phase> --work-item` was called for `impl` and `triage` only. After the
05:30 P1 broke `--worktree` spawns, every phase-emitted `command` was unusable, and I
conflated "the emitted command is wrong" with "the phase run is not useful" — so I stopped
calling it entirely for review/repair/qa and hand-dispatched with `mcx claude spawn`.

Consequence: `REVIEW_ROUND_CAP` (review ≤2, repair ≤3, qa:fail ≤2) lives in `review-fn.ts`
and **only evaluates when `mcx phase run review` executes**. It never executed. #3160
reached **nine** review rounds against a documented cap of two. ~$923 spent across 30
review/QA rounds with no stopping rule.

**Verified at 22:10 that the machine works** — `mcx phase run review --work-item "#3039"`
returns `approved: triage → review` and `{"action":"wait", "round": 1}`. Round 1, after
five actual rounds. Not a bug; it was never called.

**Fix for 79:** run `mcx phase run` for *every* transition even when overriding the emitted
command. Mechanical guard worth building: **a work item with an open PR that has not left
`triage` for >1h**. That would have fired on all six by 07:00.

### 3.2 Everything else I did by hand that the phase machine owns
1. Round caps — never evaluated (§3.1).
2. `needs-attention` routing — I wrote it into briefs as prose; never executed a transition. No item has ever been in that phase.
3. Transition legality (`mcx phase why`) — never used.
4. The QA **artifact-boot mandate** — the `qa` phase emits it; after I stopped running `qa` I hand-copied the text into briefs. It survived on my memory.
5. The merge gate — ran `done` once (#1459). Every other merge gated by hand.
6. Per-phase model selection — hand-picked.
7. **The tick loop itself** — `run.md` says drive off the `mcx monitor` stream and tick per event. I rebuilt it as bash `while` loops polling `gh pr view`. Slower, loses event enrichment, and **has no place for a cap to live**.

### 3.3 Duplicate-reviewer dispatch: my collision check was scoped wrong
I checked for worktree-*name* collisions. `review-3175-r2` and `review-3175-r3` are
distinct names and identical roles, so the check passed while producing **two reviewers of
record on the same SHA reaching opposite verdicts three minutes apart** (21:25 APPROVED,
21:28 CHANGES REQUESTED). Correct check: group live sessions by **PR number extracted from
the worktree name**, not by path. Same duplicate pairs existed on #3160 and #3168; I
retired the stale ones at 21:44.

### 3.4 Orchestrator broadcasts starve workers' actual tasks
Three PRs (#3160, #3181, #3175) pushed commits that **did not touch their open findings** —
verified by diff each time. In every case the author was doing work I had sent: safety
broadcasts, partition audits, the `--force`/`--cascade` test, the rename decoupling. Each
request was individually correct; collectively they were a denial-of-service on the
workers' actual jobs, and the cost showed up as review rounds that looked like code
failures. **Broadcasts and per-PR work need different channels** — right now both arrive as
`mcx claude send` and a worker cannot distinguish "drop everything" from "queue this."

### 3.5 Labels are not head-scoped (partially in #3031, instances not recorded)
Three distinct failures from one cause today:
- `qa:pass` applied 14:54:49 to head `2f1cf7b4`; head moved to `a1bf0b0f` at 15:05:21. I nearly merged the arc's foundation on it.
- `review:pass` on #3143 was two commits behind its head.
- `review:changes` on #3168 meant "repaired, awaiting re-review" — the opposite of what the board showed.

**A `qa:pass`/`review:pass` older than the head should be treated as ABSENT, not flagged.**
Flagging invites a judgement call, and every failure tonight was something reporting
healthy while not being healthy.

### 3.6 The partition-recovery invariant (encoded as edges, not filed as an issue)
> **No PR may close a partition whose recovery command has not landed.**

Discovered via #3200: it would have broken the boss mailbox on the next daemon restart with
no user action, and its error text recommends `mcx domain ls` / `add` — which ship in #3035
and do not exist on main. 56 mail rows, 36 addressed to `boss`, unreachable.

I encoded `blocked_by` edges on GitHub (#3038→#3035, #3037→#3035, #3041→#3035, all verified)
but **the invariant itself is not written down as an issue**.

**The mechanical discriminator that decides it** (worth more than the invariant):
grep the diff for `listDomains()` / `domains.length` used as a **behavioural switch**.
- **Global** (one row anywhere flips behaviour for a caller who did not ask) → needs its recovery command on main first. Only #3200 has this shape.
- **Per-caller** (keys on *this* caller's resolved domain) → independent.
I ran this across all six open PRs; the only other hits were backfill early-outs in
`stampImportedDomainIds` and `adoptSessionsIntoDomains`, which gate no read or write.

### 3.7 #3041 has a design conflict with the ring-0 decision (NOT filed)
#3175 established: **daemon-internal readers are ring 0, read unscoped, dispatch per row's
`domain_id`.** #3041's issue text says make the `AutomationDispatcher` **per-domain**. Read
naively those are opposite instructions. Concretely both touch
`index.ts:848 automationRepoRoot = resolveRealpath(resolve(process.cwd()))`. #3041's issue
was written before the ring-0 decision existed and its author will not know.

### 3.8 Verification of session-lifecycle code trades against blast radius (NOT filed)
The standard I enforced all sprint was "drive it, don't read it." For #3168 that standard
would have **ended every session on the box** — the code under test is `mcx claude bye`.
I had to instruct the verifier to assert on emitted args without dispatching, which is
weaker. **The domain worker and session-lifecycle PRs need an isolated-daemon fixture**, or
verification quality will keep trading against blast radius.

### 3.9 The scoped-box testing gap (NOT filed) — "luck, not design"
Three separate blockers were invisible on this box for the same accidental reason: **mcp-cli
itself is not a registered domain**, and the one sidecar present (`gerald.json`) resolves
elsewhere. #3200's mail lockout, #3039's upgrade-blinds-`ls`, and #3037's ring-0 partition
all only manifest with a domain registered over the caller's repo. **Epic A will ship
correct-on-this-machine and detonate on the first user with two domains** unless CI gets a
matrix entry that *is* scoped.

### 3.10 Two named defect patterns (reviewers found these; worth mechanizing)
**A. "Two states collapsed into one value"** — 4+ instances today:
- `toDomainFilter` → `undefined` for both "no scope requested" and "scope requested, unresolved" (the machine-wide `bye`, #3199)
- `classifyAgentTool` → `null` for both "not my server" and "my server, unscoped tool" (deleted `domain` from every MCP server's args — `mcx call atlassian` broken)
- `getSessionPath` short-circuiting on **presence** not **resolution** (a bare worktree *name* in a path chain swallowed the rest)
- stranded-rows report gating on the **filtered** count instead of "domain holds nothing"

**B. "A test that supplies what production doesn't"** — 5+ instances:
- injected `DomainSource` always returned a root; production returns NULL 99.97% of the time (this alone produced a "99% healthy" claim for a 19.87%-effective feature)
- a fixture whose incidental hyphen made a parser guard pass
- a test asserting a constant was *passed* rather than a bound *enforced* ("bounded at 2s", measured 15,212ms)
- equal maxima that could not distinguish two code paths
- a test that **locked in** a bypass as intended behaviour

**The method that finds B, stated cleanly enough to mechanize:** delete the guard, run the
**concrete-class** specs. If nothing goes red the guard is unreachable — either it or the
fake is wrong. *Mutation against a fake-based spec only proves the fake is wired to the
guard.* This found a fully deletable guard on #3200 with all 216 tests still passing.

**C. Rules inherit the disease.** THREE `doing-it-wrong` rules were found passing on the
exact input they were written to catch (`domain-mutation-invalidates-resolver`,
`domain-scoped-queries`, and `guards: "sealed"` reporting a marker rather than verified
inability to listen). **Every rule needs bypass fixtures asserting `@expect 1` on the inputs
it must catch**, or the mechanism meant to replace prose reports green instead.

---

## 4. Per-PR handoff detail

### #3181 (#3043 domain worker) — `review:pass`, CLOSEST TO MERGE
Two open blockers, **neither qualifying under the final (a)/(b)/(c) bar** — both are in code
nothing calls in production yet:
- **A** — `ensure()` drops a `restarting` server → crash budget resets → unbounded churn (`domain-supervisor.ts`)
- **B** — `giveUp()` overwrites terminal `stopped` with `failed` after `stop()` resolved, firing a wrong `onPermanentlyFailed`. Needs `if (this.stopped) return` before it sets `workerState`. **Byte-identical across two heads** — never touched.

`guards: "sealed"` must mean *verified cannot listen*, not a marker — **#3045 will land a
rule asserting the worker serves no HTTP, and if `sealed` is a marker that rule passes on a
worker that CAN listen.** That is the fourth-rule-inherits-the-disease case waiting to happen.

### #3160 (#3035 domain CLI) — CRITICAL PATH, MERGEABLE
Ships `mcx domain ls|add|show|which|rename|rm|import` = **the recovery command for the whole
epic**. #3037 and #3038 are `blocked_by` it.
- **N1** — `import` without `--force` asserts the marker is set *without checking*, then prints `rm` recovery text on that assumption → qualifies **(a)**
- **N2** — the retry-contract contradiction. `import-legacy.ts:23-24` documents "a failed table leaves the marker unset so the next start retries", and the two mechanisms in the file contradict. **Design call already made and posted on the PR:** first establish factually whether partial commits happen; if NO the *documentation* is the defect (reword `:23`, `:167`, `:172`); if YES make the error path atomic. **The lifecycle-row carve-out was explicitly rejected** — a guard that lies about emptiness is the same defect wearing a different hat. → qualifies **(a)**
- **N6** — host-bound path never validated: `mcx domain add weird 'a:b'` and `'C:\work'` register phantom hosts → **file and drop**
- Verifier corrected its own ✅ on "`ls`+`add` from outside every domain": verified in-process against a *live current* daemon, did **not** cover the two states an operator reaching for a recovery command is actually in.

### #3168 (#3039 sessions) — best fix of the sprint, now CONFLICTING
Head `ac7e21e0` closes #3199 at the **root**: `resolveDomainFilter` returns a discriminated
`none | unresolved | domain`; callers set `requireScope` and the boundary **refuses rather
than widens** — failing closed. Its commit message names why the easy fix was wrong: *"A
guard inside `claudeByeAll` would have fixed this verb and left the collapse standing for
the next destructive caller."* No known qualifying finding outstanding. Needs a rebase.

### #3175 (#3037 work_items) — `qa:fail`, **in simplification pass**
Three rounds, three sites, one shape — *a reader and a writer disagreeing about the key*:
1. phase-state namespace: reader used caller's id spelling, writer used stored id
2. daemon readers bound at startup from `process.cwd()`, writers scoped per request
3. phase-state reads key on the domain's registered path, writes key on `findGitRoot(cwd)`

Round 3 is the fix for the silent-empty defect **reintroducing it one directory level up**.
Simplification brief sent 21:44: find one shared key-builder both readers and writers call.
The legality that keeps biting: `mcx scope add` stores `root: cwd` with **no git-root
check** (`commands/scope.ts:104`) and `resolveDomainForPath`/`isPathWithin` permit a domain
path to be a **strict ancestor** of the caller's repo — so "domain registered at a parent of
the repo" is legal and reachable. Any design assuming `domain.path == git root` will keep failing.
Coverage shape that let round 3 through: `domain-scope.spec.ts:114-132` asserts only that
`domainStateRoot` returns `getDomainById(id).path` **against a hand-built fake** — it pins
the implementation to itself and can never fail.

### #3200 (#3038 mail) — four reds, most qualify
- **RED1** — breaks the boss mailbox on next daemon restart, no user action. `importScopesAsDomains` auto-creates a domain from any `~/.mcp-cli/scopes/*.json` at boot; this box has `gerald.json`. Once it lands, every mail call from outside `~/github/gerald` throws; 56 rows / 36 to `boss` unreachable; recovery text names commands that ship in #3035. → **(a)+(c)**
- **RED2** — DROP/CREATE INDEX inside `applyV1Schema()` with no version bump; ladder is at 7 so it never runs on a box that booted a #3143 binary. Fresh test DBs take that path and stay green forever while prod drifts. `state.ts:330-338` JSDoc forbids this verbatim. → **(a)**
- **RED3** — **data exfiltration, not spoofing**: `evil@beta@alpha` to a bare local recipient parses to local `evil@beta`, stores `crossDomain: false` so it reads as ordinary local mail, and the *victim's reply* routes to `beta` with the body. Neither party typed `user@domain`. The sender's domain suffix was validated; the local part was never checked for an embeddable address. → **(b)**
- **RED4** — `markRead` discards the boolean `state.ts` computes, so cross-partition mark-read returns success. `replyToMail` 25 lines above does it correctly. → **(a)**
- Its author independently reproduced RED1 on a faithful clone and reported it against his own interest.

---

## 5. Sprint-level facts not written down elsewhere

- **Three authors answered the partition invariant YES against their own interest**, with reproductions rather than reasoning (#3200, #3037, #3040). **None of those was found by review.** Author self-testing against a stated, mechanical invariant is a far cheaper discovery channel than a review round.
- **The gate-lease does not serialize gates.** It delays ~5 min then admits you **unleased** (#3138 / #2690). "The lease will queue me, therefore starting is safe" is the reasoning a *careful* worker uses and it is false. The tell is two log lines above an otherwise **green** result. This taught everyone the wrong instinct for three sprints.
- **`uptime` is the wrong load signal** — trailing 1-min average including IO wait. Use `awk '{print $4}' /proc/loadavg` (runnable) + `ps --sort=-pcpu` for concurrent gates. Two concurrent gates survivable; four produces the 5000ms enumeration timeouts.
- **Contention signatures** (environment, not code): SIGSEGV, "worker panicked", timeouts in `findProcessesByCwd` / `reapWorktreeProcesses` / `handleWorkerCrash`, `ServerPool rate limiting` (#3014), `ensureSelfSignedCert`, and a truncated log with **zero `(fail)` lines** after the 60-worker repro test (#2915).
- **A coordinated gate hold works**: load 9.0 → 2.6 in two minutes and a worker that had lost three pushes landed immediately. It only works if everyone actually stops, including `git commit` (the pre-commit hook runs the full suite — that is the one that catches people).
- **Every worker on this box died simultaneously twice** on platform transport failures (~17:26 and ~20:48). A stopped worker and a working one are indistinguishable from outside. The mitigation that works: **mail before your turn ends on a wall.**
- **Sequenced-but-not-spawned work is invisible to every recovery check.** #3038 was lost that way for ~9h; #3181 sat green-and-undispatched for 2h20m. Neither has a live session, so `mcx claude ls` and PR heads both show nothing. **Correct resume check: open PRs that are CI-green with no live session in a matching worktree.**

## 6. Things I did NOT do

- **Retro never ran.** No diary entry, no Results section on `.claude/sprints/sprint-78.md`, no `mcx untrack`, no `mcx gc`. The `.active` sentinel at `<repo-root>/.claude/sprints/.active` still reads `78` and should be removed by whoever closes this out.
- **No release / semver decision.** A **major** is due when epic A lands (new DB file, new partition key, `mcx scope` removal) — #3034 merged, so that decision is now owed.
- **Sprint 79 was not planned** (correctly — a program-manager session owns that).
- `.claude/sprints/**` was Write/Edit-gated for this session; the operator authorized the Bash-heredoc route for it. The one commit I made that way is `9bc1b157`, and it says so in its message.
