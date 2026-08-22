# mcx-boss — live state

**Read this first after a compaction or a session restart.** Written 2026-08-22 by the
meta-orchestrator session (`mcx-boss`) driving epic #3019. Update it when the situation
changes; it is the only durable record of *operational* state, as opposed to the plan
(GitHub) and the lessons (`~/.claude/projects/-home-ubuntu-github-mcp-cli/memory/`).

## The job

Ship **#3019 — domain-scoped mcx**. Decomposed into 10 sub-epics (#3021–#3030) and 59
implementation issues, all filed with `blocked_by` edges. **The full map and sprint
sequencing is a comment on #3019** — that is the authoritative plan and it survives
everything.

Scope note from the operator: shipping means **getting the harness working here**, on
mcp-cli as domain #1. Migrating phoenix/clrg/work (#3103) is **out of scope**, unlinked
from epic J.

Role: I do not implement and I do not orchestrate a sprint directly. I decompose, plan,
spawn one orchestrator per sprint, unblock, and make the calls that cross session
boundaries. `.claude/boss/sprint-79.md` is the next sprint's plan, ready to go.

## Sprint sequence

| Sprint | Contents | State |
|---|---|---|
| 77 | pre-#2000 gems | winding down — orchestrator `Alice`, worktree `sprint-77`, container PR #2923 |
| **78** | **epic A + domain worker** | **running** — orchestrator `Dave`, worktree `sprint-78`, container PR #3046. **#3034 MERGED 2026-08-22 15:19 as `88b78bf5`** — the foundation is on main and all 11 dependents are unblocked. Also merged: #1459, #1510, #935. |
| 79 | epic C (trust) + epic I (spend) | planned — `.claude/boss/sprint-79.md` |
| 80 | epic D (cards) + B tail | not planned |
| 81 | epic E (reducer) + F (sensors) | not planned |
| 82 | epic H (console) + G (email) | not planned |
| 83 | epic J minus migration | not planned |

## Standing operator grants

- **Security fixes are always in scope**, outside the QoL budget.
- **Two QoL fixes per sprint**, max. Planned spend is in `feedback_qol_budget_per_sprint.md`.
- **`.claude/sprints/**` + `.claude/diary/**` writes granted per orchestrator worktree** —
  I must add `settings.local.json` to *each* new sprint orchestrator's worktree. Note it
  only applies to sessions spawned **after** it exists; permission sets are read at session
  start and never re-read.
- Operator's read on permission modes: Claude Code **auto mode is good**, approve and
  dangerous modes are problematic. Do **not** "fix" containment by denying `Bash`.

## Merge policy — the gated class

**No auto-merge. Adversarial review + QA before merge**, for anything touching
**security, isolation/containment, auth, the DB schema, or the spawn path.**

Currently gated: **#3034, #935, #3043, #3039**, plus my own #3119/#3137.
Everything else keeps the auto-merge default.

Decide this **at dispatch time**. Telling a worker to arm auto-merge forfeits the gate —
I did that on #3063 and #3116 landed mid-review.

## Live decisions I have made (do not re-litigate)

1. **#935 precedence overridden to deselect-only.** Repo `.mcx.yaml` may set `profile: null`
   but may **not** name a profile. The pinned order let repo content choose credentials for
   an auto-approve agent; combined with a 16-level manifest ascent and a porous
   `RESERVED_SPAWN_ENV_KEYS`, that is credential exfiltration (`ANTHROPIC_BASE_URL` +
   inherited token) and RCE (`LD_PRELOAD`) from a `git clone`. Do **not** "fix" it by
   blocking `ANTHROPIC_BASE_URL` — redirecting to Bedrock is the point of #935.
2. **#2964's 🔴1 mechanized as a `doing-it-wrong` rule**, not a test seam in production code.
   The window is ~2µs and undrivable; a static rule catches the class.
3. **`state.ts` is owned exclusively by #3034 this sprint.** #3034 replaces the DB outright
   with a new `mcx.db`, so any migration on the legacy chain is superseded within the sprint.

## Open operational items

- **DAEMON RELOAD PENDING — deferred to the sprint-78 boundary.** #3116 (containment on
  stdio) is merged but **not live**; the running daemon predates it, so **every worker runs
  unsandboxed** until `bun run build && mcx daemon reload`. `reload` refuses to orphan *any*
  live session, and sprint 78 has ~8 with hours to run — so this waits for sprint 78 to drain,
  not sprint 77. Corrected 2026-08-22: I had told Alice to signal at zero workers, which was
  wrong; a per-sprint drain is not a daemon-wide drain. **Caveat: `restoreSessions()` does not persist permission
  strategy**, so sessions restored after a restart come back as `auto`/blanket-allow — reload
  at true zero.
- ~~#3034 not yet pushed~~ **DONE — merged as `88b78bf5`.** It cost four review rounds, a QA
  fail and five partial-fix corrections. Every round found something real: the `aliases`
  partition (one domain would have overwritten another's phases), an import that committed rows
  it could not seal, a recovery path that did not work in two different forms, a cursor clamp
  that silently skipped live events, and a cleanup that could poison the daemon's connection.
  **Holding it for review was the highest-value decision of the run.**

- **Rebase wave in progress.** #3160/#3035, #3037, #3039, #3040 were all stacked on the
  pre-merge branch. #3160's is non-trivial — it edits `import-legacy.ts`, which the merge
  rewrote.
- Two worktree collisions tonight (`issue-1328`, `issue-935`) — two live sessions in one
  worktree, both nearly destructive. Guard filed as **#3140**. Always check `mcx claude ls`
  for a live session in a path before spawning `--cwd` there.

## Coordination

- **Shared box.** Second project `phoenix-octovalve`, session `phoenix-boss`, capped at 2
  lanes, reachable by `SendMessage`. I have CPU priority but am the noisy neighbour.
- **The `am-i-done` gate lease is scoped per repo, not per host** (#2690). `slots=1` can be
  satisfied while the box sits at load 40. **`uptime` is the honest signal; the lease is
  not.** Gate under load dies in a starvation cascade (SIGSEGV / "worker panicked") that is
  not a code bug — wait for 1-min load < 12 and retry.
- **Never** fix load with a killer/reaper/watchdog (#2637) or a timeout bump.

## Watching

- Deck watch monitor: stalled orchestrators (idle >6m), frozen workers (tokens flat >13m),
  PR transitions, dead sessions, and the **`boss` mailbox**.
- **Every worker brief must carry the escape hatch**:
  `echo "..." | mcx mail -s "blocked: ..." boss`, or agent-message `mcx-boss` if `mcx` is
  denied. Say explicitly that using it carries no penalty. Three workers used it tonight and
  each one caught something I would otherwise have missed.

## 2026-08-22 ~17:00 UTC — #3179, the taxonomy hole (user flagged as serious)

The review label set has **no author-applicable state**. All four labels
(`review:changes`, `review:pass`, `qa:fail`, `qa:pass`) are verdicts rendered by
someone other than the author, so an author who has just pushed a repair has no
truthful move. Two paths, two lies: phase-driven erases `review:changes`
(`review-fn.ts:257`, correct anti-replay per #2649) so the PR reads as never-reviewed;
manual leaves it so the PR reads as unrepaired.

The state is *not* missing from the system — `work_items.phase` = repair,
`review_round`, `previous_phase` are all correct in SQLite. It is missing from the PR,
which is the surface every human and every non-phase-driven session actually reads.
Sprint 78 ran largely hand-orchestrated, which is why it surfaced now.

**Disposition: meta → 78/79 boundary window, orchestrator-driven, no worker slot.**
Surface is `.claude/phases/**` + `.claude/skills/**`. Recorded in
`.claude/boss/sprint-79.md` under "Boundary work" with the strict ordering
(gate before label — otherwise `review:repaired` + `qa:pass` merges clean without
re-review) and the bootstrap-sprint requirement (new projects inherit the hole
otherwise).

Caught on #3168 because Bob declined to self-assert `review:pass` and wrote a paragraph
explaining why. Reply sent endorsing the call — that judgment is the behaviour to
reinforce, not tolerate.

Also filed **#3178** — `mcx mail <unknown-verb>` sends an empty message to a mailbox
named after the verb, exit 0. I did it to myself (`mcx mail read 46` created message 47
in mailbox `read`). Not meta; worker-eligible filler.
