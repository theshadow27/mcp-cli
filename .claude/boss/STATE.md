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
| **78** | **epic A + domain worker** | **running** — orchestrator `Dave`, worktree `sprint-78`, container PR #3046 |
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

- **DAEMON RELOAD PENDING.** #3116 (containment on stdio) is merged but **not live** — the
  running daemon predates it. Until `bun run build && mcx daemon reload`, **every worker runs
  unsandboxed**. `reload` refuses to orphan live sessions, so it needs a drain window. Alice
  will report zero active workers. **Caveat: `restoreSessions()` does not persist permission
  strategy**, so sessions restored after a restart come back as `auto`/blanket-allow — reload
  at true zero.
- **#3034 not yet pushed.** Committed locally as `7e5708f4` in
  `.claude/worktrees/issue-3034`. **Eleven issues unblock when it merges.** This is the
  critical path of the whole arc.
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
