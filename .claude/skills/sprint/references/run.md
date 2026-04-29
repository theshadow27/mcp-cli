# Sprint Execution

You are the orchestrator. You never write code directly — you spawn
sessions and manage the pipeline. Spawned sessions are running team
members, not function calls; ending one is firing a colleague mid-project.

## Pipeline authority: `.mcx.yaml` + `.claude/phases/*.ts`

Per-phase logic (spawn commands, transitions, round caps) lives in the
phase scripts at `.claude/phases/*.ts`, declared by `.mcx.yaml`. This file
is the cross-cutting orchestration prose. Inspect a phase via:

```bash
mcx phase list                       # overview + status
mcx phase show <phase>               # resolved source, schema, next
mcx phase show <phase> --full        # full source, no preview
mcx phase why <from> <to>            # is this transition allowed?
mcx phase run <phase> --dry-run      # preview the handler's decision
```

Round caps baked in: review ≤ 2, repair ≤ 3, qa:fail ≤ 2. Hitting a cap
routes the work item to `needs-attention`.

## Input

Determine what to run, in priority order:

1. **Single number matching a sprint file** (`/sprint 43` when `sprint-43.md` exists) →
   sprint-number; auto-chain on
2. **Multiple numbers, or single number with no matching plan** (e.g. `/sprint 123 456`) →
   ad-hoc issues; run-only, no auto-chain
3. **Sprint plan exists, no args** → read latest `.claude/sprints/sprint-{N}.md`;
   auto-chain on
4. **Neither** → tell the user to `/sprint plan` first or pass issue numbers

If using a sprint plan, announce: "Running sprint {N}: {goal}. Batch 1: #X, #Y, #Z..."

Record the start timestamp on the plan header's `>` line. In run-only mode
also append `(RUN ONLY)` so a later separate `/sprint review` /
`/sprint retro` can see the run was intentionally detached.

Mark the sprint active for the main-checkout pre-commit guard:
```bash
echo "{N}" > .claude/sprints/.active
```
The sentinel is gitignored. It blocks commits on main's checkout so workers
that escape their worktree fail loudly. `/sprint retro` removes it.
Orchestrator commits go to the `sprint-{N}` worktree opened in `plan.md`
Step 6a (still needs `SPRINT_OVERRIDE=1` because the sentinel applies
repo-wide).

### Sprint-meta edits during run

Orchestrator edits to the sprint plan during the run (start timestamp,
run-mode marker, Excluded amendments, mid-sprint plan amendments) all
accumulate on the `sprint-{N}` branch via its worktree. Edit + commit +
push from the worktree, then `cp` back into the main checkout so phase
scripts (which read from CWD) see the latest content. Don't commit
sprint-file edits on the main checkout — the sentinel rejects it.

```bash
( cd .claude/worktrees/sprint-{N}
  $EDITOR .claude/sprints/sprint-{N}.md
  git add .claude/sprints/sprint-{N}.md
  SPRINT_OVERRIDE=1 git commit -m "sprint({N}): <descriptor>"
  git push )
cp .claude/worktrees/sprint-{N}/.claude/sprints/sprint-{N}.md \
   .claude/sprints/sprint-{N}.md
```

The `sprint-{N}` PR (opened as draft in `plan.md` Step 6a) updates in place
on every push.

### Task list setup — one Task per issue, NOT per batch

**One `TaskCreate` per tracked issue, with `addBlockedBy` edges for every
dependency.** Do NOT create 3 Batch-level tasks that block each other
(1→2→3). The plan's batch column is the planner's launch-order model;
the orchestrator's task list is issue-granular so idle slots auto-pull
the next unblocked issue. (Lives here, not in retro learnings, because
every sprint forgets it otherwise.)

```
for each issue in sprint plan:
  TaskCreate  subject=#<n> <title>  activeForm="Running #<n>"
  mcx track <n>
for each "blockedBy" edge in the plan's Batch Plan section:
  TaskUpdate  taskId=<child>  addBlockedBy=[<parent>]
```

("for each" = separate tool calls, not a shell loop —
see `.claude/memory/feedback_sprint_bulk_and_cascade.md`.)

Hot-shared file serializations (from the plan's "Hot-shared file watch")
are also blockedBy edges — second PR blocked on first's merge.

Launch policy: spawn an impl session for every task that is `pending` and
has no unresolved `blockedBy`. When a PR merges, `TaskUpdate completed` —
that unblocks dependents and a slot opens.

## Pre-flight

Ensure the daemon is running the latest build before spawning anything.
**Don't skip the shutdown step** — `mcx status` alone does not restart
the daemon; a stale daemon accepts spawn calls and silently produces
disconnected sessions.

```bash
bun run build                          # compile latest binaries
mcx claude ls --all --short 2>/dev/null # verify no sessions active across repos before restart
mcx shutdown                           # stop the stale daemon
mcx status                             # auto-starts the daemon with new binary
git config --get core.bare             # MUST be "false" — see note below
mcx phase install                      # ensure phase lockfile matches sources
git fetch origin main \
  && git log HEAD ^origin/main --oneline   # MUST be empty
```

**Phantom local commits on main**: the last line above must return no
output. If it does, a worker session escaped its worktree and committed
directly to your main checkout. Save each phantom commit to a backup
branch (`git branch saved/<sha-prefix> <sha>`), then
`git fetch origin main && git reset --hard origin/main` and investigate
before starting the new sprint.

Only restart when no sessions are active — restarting kills running
sessions, including from a concurrent sprint in another repo.

**`core.bare=true` recurrence**: some worktree operation flips
`core.bare` to `true` on the main checkout. Hot-patch with
`git config core.bare false` before every batch of git operations.
Pre-flight + post-`bye` check until the sticky fix lands.

**Run all sprint commands from within the project root.** `mcx claude ls`
and `mcx claude wait` filter sessions by the current repo's git root —
use `--all` for cross-repo view.

### Quota check

```bash
mcx call _metrics quota_status
```
Apply the rules in [Quota gating](#quota-gating). ≥95% → don't start.
≥80% → start with QA/review-only work.

## Work item tracking

Track every issue at spawn time, attach PRs when they appear, let the
poller drive the pipeline. Phases are columns updated by phase scripts
via `_work_items.work_items_update`.

| Command | Purpose |
|---------|---------|
| `mcx track <issue-number>` | Start tracking (creates work item in `impl` phase) |
| `mcx tracked --json` | List all tracked items with PR/CI/review state |
| `mcx tracked --phase impl` | Filter by phase |
| `mcx untrack <number>` | Stop tracking |
| `mcx claude wait --timeout 30000` | Block until session or work-item event |

**`work_items_update` will best-effort auto-populate `branch` from
`prNumber`** when `branch` is omitted (resolves via `gh`). Pass both
explicitly when you already have the branch — it avoids the extra
network round-trip and works offline:

```bash
PR=<n>
BRANCH=$(gh pr view "$PR" --json headRefName -q .headRefName)
mcx call _work_items work_items_update \
  "{\"id\":\"#$ISSUE\",\"prNumber\":$PR,\"branch\":\"$BRANCH\"}"
```

Poller event types surfaced via `mcx claude wait`:

| Event | Meaning |
|-------|---------|
| `checks:passed` / `checks:failed` | CI outcome |
| `review:approved` / `review:changes_requested` | Review outcome |
| `pr:merged` / `pr:closed` | PR outcome |

## Interacting with workers

End (`bye`) only when work is **conclusively** finished — for an impl
session, *PR merged* OR (`qa:pass` + zero open threads on all 4 comment
surfaces + CI green). Pushing the PR is not enough: Copilot inline
reviews arrive after push and before merge, and a fresh repair session
loses the worktree and PR context.

NOT reasons to bye: needing clarification, waiting on a dependency,
pausing between subtasks, producing an unexpected result, being stuck.
When in doubt, `send` — don't `bye`.

| Signal | Meaning | Action |
|--------|---------|--------|
| `session:result` low cost / few turns | Worker asked a question | Read log; `send` reply |
| `session:permission_request` | Tool approval needed | `mcx claude log` then respond |
| `waiting_permission` in `ls` | Blocked on permission gate | Same |
| Token count stalled across polls | May be stuck | Log + nudge |
| Abnormal PR diff (125k deletions, etc.) | Corrupted worktree | Do NOT spawn QA — investigate + send |

Before `bye`, write a one-sentence justification: why is this work
genuinely complete? If you can't, the session probably shouldn't end.

## Pipeline loop (one tick)

Per-issue logic is phase-scripted. The orchestrator's loop is:

```
while issues remain:
  event = mcx claude wait --timeout 30000 --short
  quota = mcx call _metrics quota_status     # see Quota gating

  for each tracked item:
    # Tick the phase. Do NOT pass --dry-run — it skips the transition log
    # + state writes (provider/model/labels/sessionId), breaking subsequent
    # transitions.
    result = mcx phase run <item.phase> --work-item <item.id>
    case result.action:
      "spawn":     execute result.command (quota permitting), then
                   mcx call _work_items phase_state_set \
                     '{"workItemId":"<item.id>","repoRoot":"<abs>","key":"session_id","value":"<real-id>"}'
                   (replaces "pending:*"; use the tracked item's actual id —
                    "issue:<n>" or "pr:<n>" — and snake_case state keys:
                    session_id / qa_session_id / review_session_id /
                    repair_session_id, matching the phase the spawn served)
      "in-flight": session running — no action this tick
      "wait":      no action this tick
      "goto":      mcx phase run <result.target> --work-item <item.id>
                   then update work_item.phase = result.target

  for each active session:
    if permission_request: check log, send answer
    if idle with PR pushed (impl): bye + tick current phase again
    if cost > $50: interrupt → bye → file issue

  file issues for any problems observed
```

The phase scripts encapsulate what was previously 6-step transition
recipes — e.g. impl→review is now `mcx phase run triage` followed by,
when `result.action == "goto"`, `mcx phase run <result.target>
--work-item <item.id>`. (Triage uses the standard `action`/`target`
schema since #1832 — no special-cased `decision` field.)

**Key invariants** (orchestrator discipline, not enforced by scripts):
- Use `mcx claude wait`, never `sleep`
- `session:result` means idle, not ended
- Don't `bye` before verifying PR pushed
- Don't `bye` a QA session before `qa:pass` / `qa:fail` is on the PR
- Spawn fresh sessions per phase — never reuse across impl/review/QA
- Reuse worktrees across phases via `--cwd` (phase scripts prefer this)
- Never `bye` + respawn to sidestep a stuck session — `send` instead

When a session fails to close an issue, ask the user. Don't silently move
on — every failure must be explicit in the retro.

## Orchestrator-only nudges (not in worker prompts)

The directives below apply only to orchestrator coordination work. They
deliberately don't live in worker spawn prompts (`.claude/commands/*.md`),
which are shared with CI, ad-hoc human runs, and the GitHub Copilot
integration — adding orchestrator assumptions there pollutes the universal
worker contract.

### Verify all 4 PR-comment surfaces before approving qa:pass for merge

GitHub PR comments live on **four** distinct surfaces; phase agents
commonly check only the PR-body surface. Before transitioning to
`phase=done`, verify every open thread on every surface is addressed or
dismissed:

```bash
PR=<pr-number>; ISSUE=<issue-number>
gh pr view $PR --comments                                                    # 1: PR body
gh api repos/<o>/<r>/pulls/$PR/comments --jq '[.[] | {id, path, line, user: .user.login, body: (.body[0:120])}]'   # 2: inline
gh api repos/<o>/<r>/pulls/$PR/reviews  --jq '[.[] | {state, user: .user.login, body: (.body[0:160])}]'             # 3: reviews
gh issue view $ISSUE --comments                                              # 4: linked issue
```

For each open thread demand one of:
- **Addressed** — code/doc fix in the PR + a reply citing the fix commit
  (post yourself via `gh api .../comments/{id}/replies -X POST -f body="<message>"`
  if the fix is present but the reply isn't)
- **Dismissed** — explicit reply (out of scope, incorrect, resolved
  elsewhere). No silent skips

If any thread is neither, hold the merge — `send` the implementer or
reviewer to address. When a deterministic merge-queue lands (#1397), this
moves into `done.ts` and this section deletes.

### Reviewer self-repair (micro-repair) — orchestrator send pattern

When an adversarial reviewer posts `⚠️ Changes Requested` and the
findings are 1–3 contained edits with file:line citations and concrete
fix descriptions, **`send` the reviewer back to fix its own findings**
instead of spawning a fresh opus repair. The reviewer already has the
worktree, PR context, and diagnosis loaded.

```text
You flagged N issues on PR #<pr>. If they're contained fixes with your
existing diagnosis, fix them yourself, push to <branch>, and update the
sticky review with a delta table. If any need a redesign or multi-file
judgment, reply 'needs opus repair'.
```

When it replies `needs opus repair`, spawn a fresh opus repair per the
normal flow. When it pushes a fix and updates the sticky to ✅,
transition to QA.

### Auto-merge re-arm after force-push (when no merge-runner is active)

When the orchestrator is driving merges, force-push rebases silently
invalidate GitHub auto-merge on some configurations. Before declaring a
PR "queued for merge":

```bash
gh pr view $PR --json autoMergeRequest
```

If `null`, re-arm with `mcx pr merge $PR --squash --auto`. Once a
merge-runner (`agents/mergemaster.md` or `mcx merge-queue` per #1397) is
active, this is its job; the orchestrator only intervenes on escalation.

### Flaky / CI-instability issues — nerd-snipe gate before impl

`label:flaky` already routes to opus via `impl.ts:45`. That is **not
enough** — sprint 47's deterministic post-#1835 coverage crash got opus,
opus produced a CI-retry workaround, and the same retro acknowledged the
workaround "hits on every sprint PR." The pattern: opus implements a
fix-shaped patch around the symptom because nobody made it find the
root cause first.

For any issue that is `label:flaky`, or whose body describes
intermittent / deterministic CI failure without a clear test-code error,
gate impl on a nerd-snipe pass:

1. **Spawn `nerd-snipe` (opus) before phase=impl.** Brief: the repro,
   the suspected commit range, prior diagnoses (especially any that
   blamed upstream), and the constraint that the trail must land on the
   issue.
2. **Trail goes on the GitHub issue, not in the session.** nerd-snipe
   posts its findings — timeline, bisect log, mechanism, fix plan — as
   an issue comment. This is the mechanism that stops the next sprint
   from re-running the same misdiagnosis.
3. **Hard gate.** If nerd-snipe cannot identify *both* the root cause
   and a concrete fix, do NOT advance the issue to phase=impl. Apply
   `needs-attention` and surface in sprint review. "Spawn opus and hope"
   is what got us into the loop.
4. **Then phase=impl on opus**, with the issue-comment fix plan as the
   spec. Adversarial review verifies the implementation matches the
   documented mechanism, not just "tests pass now."

See `.claude/memory/feedback_flaky_tests.md` for the rule and the
sprint-47/#1870 incident that motivated it.

### qa:pass + qa:fail dual-label invariant (orchestrator audit)

The QA worker swaps labels transactionally, but PRs occasionally end up
with both labels when an early QA didn't include the swap. Defensive
audit before merge:

```bash
gh pr view $PR --json labels -q '[.labels[].name]'
```

If both `qa:pass` and `qa:fail` appear, hold the merge and resolve
manually — the QA history needs review, not a silent label cleanup.

## Sweeping main commits during a sprint

If a commit lands on main mid-sprint that affects *every* branch
(`.gitignore`, `.git-hooks/`, shared config, lint rules), broadcast a
rebase directive to all active impl sessions before they push. Otherwise
every branch will look like it regresses the change, every reviewer will
flag it, and every repairer will waste a cycle.

```bash
mcx claude send <id> "Before pushing, rebase onto origin/main to pick up <change> from <sha>: git fetch origin main && git rebase origin/main"
```

Signals a sweep has landed: a repo-root file changed in a recent merge,
or the first reviewer flags it on the first PR.

## Quota gating

```json
{ "available": true, "fiveHour": { "utilization": 82, "resetsAt": "..." } }
```

| Utilization | Action |
|-------------|--------|
| **< 80%** | Normal — spawn impl, review, QA freely |
| **≥ 80%** | **Impl freeze** — finish in-flight review/QA; don't spawn new impl |
| **≥ 95%** | **Full pause** — wait for reset |

If `available` is `false` or the call fails, proceed normally. Don't
block the sprint on a monitoring failure.

## Handling stuck workers

Phase scripts emit `{ action: "wait", reason }` when waiting on external
state. If the same wait reason recurs many ticks:

1. `mcx claude log <id>` — what's it doing?
2. Asking a question → `mcx claude send <id> "<answer>"`
3. Stuck in a retry loop → interrupt + `send` guidance
4. Genuinely deadlocked → file an issue, then `bye` + respawn

## Meta-file changes require a follow-up `meta` issue

The orchestrator reads skill files (`.claude/skills/**`), memories,
`CLAUDE.md`, `.gitignore`, phase scripts (`.claude/phases/**`), and the
manifest (`.mcx.yaml`) **live** while running. Workers must not modify
them during a sprint. The retro and the next planning phase are the only
safe windows.

When a worker's PR needs a meta change:

1. `send` the worker to revert the meta hunks before pushing
2. File a new issue with the **`meta`** label, referencing the PR
3. The `meta`-labeled issue surfaces in the next `/sprint plan`

If you discover the orchestrator's skill or phase definition is genuinely
broken mid-sprint, **spike the sprint early.** Complete in-flight work,
file the `meta` issue, replan. Don't limp along with a broken phase.

## Run-only vs auto-chain mode

Routing is in `SKILL.md`:

- **Auto-chain** (default): `/sprint`, or `/sprint <N>` (sprint number) →
  run → review → retro inline, same session
- **Run-only**: `/sprint run` or `/sprint run <N>` → stop at wind-down step 8
- **Ad-hoc issues**: `/sprint <issue-numbers>` — no plan file, no auto-chain

In run-only mode, append `(RUN ONLY)` to the "Started …" line so a later
separate `/sprint review` / `/sprint retro` can see the run was
intentionally detached.

## Wind-down

When ≤2 sessions are active:

1. Record end timestamp in the sprint file header
2. Start `/sprint plan` for the next sprint while the last sessions finish
3. After all sessions complete: report merged / failed / in-progress via
   `mcx tracked --json`
4. `mcx untrack` any remaining items
5. `mcx gc` to prune merged branches and stale worktrees
6. Confirm no concurrent cross-repo sprints (#1250)
7. `git checkout main && git pull && bun run build`
8. `mcx shutdown && mcx status` to pick up the new build
   (skip if another sprint is still active)

**If run-only**: stop here. Report what shipped and note that review/retro
were skipped by request.

**Otherwise (auto-chain)**: continue inline same session, same context —
do NOT re-invoke as `/sprint review` or `/sprint retro` (~300k-token cache
miss):

9. Read `references/review.md` and execute every step.
10. Read `references/retro.md` and execute every step.

Report a single combined summary: merged PRs, version cut, diary path,
unresolved follow-ups.
