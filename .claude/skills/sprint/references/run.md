# Sprint Execution

Run the implementation pipeline. You are the orchestrator — you never write
code directly, you spawn sessions and manage the pipeline.

**Spawned sessions are running team members, not function calls.** They
maintain their own context, memory, and ongoing work — just like you do.
Ending a session is like firing a colleague mid-project. Do it only when
their role is genuinely complete, not when they ask a question or get stuck.

## Pipeline authority: `.mcx.yaml` + `.claude/phases/*.ts`

The per-phase logic (spawn commands, transition rules, round caps) lives in
the phase scripts at `.claude/phases/*.ts`, declared by `.mcx.yaml`. This
file is the prose orchestration guide — it covers the cross-cutting
concerns that span phases. For any specific transition, inspect the phase:

```bash
mcx phase list                       # overview + status
mcx phase show <phase>               # resolved source, schema, next
mcx phase show <phase> --full        # full source, no preview
mcx phase why <from> <to>            # is this transition allowed?
mcx phase run <phase> --dry-run      # preview the handler's decision
```

Round caps baked into the phases: review ≤ 2 rounds, repair ≤ 3 rounds,
qa:fail ≤ 2 rounds. Hitting a cap routes the work item to `needs-attention`.

## Input

Determine what to run, in priority order:

1. **Single number matching a sprint file** (`/sprint 43` when `sprint-43.md` exists) —
   sprint-number interpretation; use that plan; auto-chain on
2. **Multiple numbers, or single number with no matching plan** (e.g. `/sprint 123 456`) —
   ad-hoc issue numbers; run only, no auto-chain (no plan file to base review/retro on)
3. **Sprint plan exists, no args** — read `.claude/sprints/sprint-{N}.md` (latest by
   number), use its issue list and batch assignments; auto-chain on
4. **Neither** — tell the user to run `/sprint plan` first or pass issue numbers

**Mode** (from SKILL.md routing): default is auto-chain (run → review → retro
inline). Explicit run-only is requested as `/sprint run` or `/sprint run <N>`.

If using a sprint plan, announce: "Running sprint {N}: {goal}. Batch 1: #X, #Y, #Z..."

Record the start timestamp in the sprint file header (append to the `>` line).
In run-only mode, also append `(RUN ONLY)` on the same line so `/sprint review`
and `/sprint retro` later know the run was intentionally detached:

```
> Planned {date}. Started {date} {HH:MM local}. Target: 15 PRs.
```

or, in run-only mode:

```
> Planned {date}. Started {date} {HH:MM local} (RUN ONLY). Target: 15 PRs.
```

Mark the sprint active for the main-checkout pre-commit guard (#1443):
```bash
echo "{N}" > .claude/sprints/.active
```
The sentinel is gitignored. It blocks commits on main's checkout so workers
that escape their worktree fail loudly instead of landing phantom commits
on main (see #1425). `/sprint retro` removes it. Orchestrator commits go
to the `sprint-{N}` branch via the `.claude/worktrees/sprint-{N}/` worktree
opened in `plan.md` Step 6a — `SPRINT_OVERRIDE=1` is still needed there
because the sentinel applies repo-wide.

### Sprint-meta edits during run

The orchestrator makes several sprint-meta edits during the run:

- **Start-of-run timestamp** (the "Started …" line in the plan header)
- **Run-mode marker** ("(RUN ONLY)" if invoked as `/sprint run`)
- **Excluded-section amendments** (e.g. "this issue was already-closed
  pre-sprint, removed from Batch 1")
- **Mid-sprint plan amendments** (swapping a filler, adjusting batches)

All of these accumulate on the `sprint-{N}` branch. The flow is:

```bash
# (a) Edit in the sprint worktree (where the branch lives)
$EDITOR .claude/worktrees/sprint-{N}/.claude/sprints/sprint-{N}.md

# (b) Commit + push from the worktree
(
  cd .claude/worktrees/sprint-{N}
  git add .claude/sprints/sprint-{N}.md
  SPRINT_OVERRIDE=1 git commit -m "sprint({N}): <descriptor>"
  git push
)

# (c) Sync the change back into the orchestrator's main checkout so phase
#     scripts (which read .claude/sprints/sprint-{N}.md from CWD per #1437)
#     see the latest content. The file stays uncommitted on main.
cp .claude/worktrees/sprint-{N}/.claude/sprints/sprint-{N}.md .claude/sprints/sprint-{N}.md
```

The `sprint-{N}` PR (opened as draft in `plan.md` Step 6a) updates in place
on every push — the user can watch sprint progress there.

**Don't commit sprint-file edits on the main checkout.** The sentinel +
pre-commit guard will reject it, and even if you bypass with
`SPRINT_OVERRIDE=1` you'd race with the worktree's history. Always edit
in the worktree.

### Task list setup — one Task per issue, NOT per batch

**Create one `TaskCreate` per tracked issue, with `addBlockedBy` edges for
every dependency.** Do NOT create 3 Batch-level tasks that block each other
(1→2→3). The batch column in the sprint plan is the planner's launch-order
model; the orchestrator's task list is issue-granular so idle slots
auto-pull the next unblocked issue.

Why this matters: sprint 41 lost multi-minute stretches with 1 active
session while other slots waited for "Batch 2 to finish before Batch 3 can
start." Sprint 42 adopted per-issue tasks with blockedBy edges and peaked
at 17 concurrent sessions without lulls. Sprint 43 reverted to 3 Batch
tasks (Batch 1 blocks Batch 2, Batch 1 blocks Batch 3) and re-introduced
the cascade. This rule stays in `run.md` — not a per-sprint retro rule —
because every sprint forgets it otherwise.

Concrete pattern:

```
for each issue in sprint plan:
  TaskCreate  subject=#<n> <title>  activeForm="Running #<n>"
  mcx track <n>
for each "blockedBy" edge in the plan's Batch Plan section (e.g. "#1579 blockedBy #1578"):
  TaskUpdate  taskId=<child>  addBlockedBy=[<parent>]
```

("for each" here means separate tool calls, not a shell `for` loop —
see `.claude/memory/feedback_sprint_bulk_and_cascade.md`.)

Hot-shared file serializations from the plan's "Hot-shared file watch"
section are also blockedBy edges (second PR blocked on first's merge).

Launch policy: spawn an impl session for every task that is `pending` and
has no unresolved `blockedBy` entries. When a PR merges, `TaskUpdate` the
issue's task to `completed` — that unblocks its dependents and a new slot
opens.

## Pre-flight

Before spawning any sessions, ensure the daemon is running the latest build.
**Don't skip the shutdown step** — `mcx status` alone does not restart the
daemon, so a stale daemon will accept spawn calls and silently produce
disconnected sessions (see #1218).

```bash
bun run build                          # compile latest binaries
mcx claude ls --short 2>/dev/null      # verify no sessions active before restart
mcx shutdown                           # stop the stale daemon
mcx status                             # auto-starts the daemon with new binary
git config --get core.bare             # must be "false" — see note below
mcx phase install                      # ensure phase lockfile matches sources
git fetch origin main \
  && git log HEAD ^origin/main --oneline   # MUST be empty
```

**Phantom local commits on main** (#1425). The last line above must
return no output. If it does, a worker session escaped its worktree and
committed (and possibly pushed) directly to your main checkout during a
prior sprint. Do not proceed: save each phantom commit to a backup
branch (`git branch saved/<sha-prefix> <sha>`), then `git fetch origin
main && git reset --hard origin/main`. Investigate which session did it
before starting the new sprint.

Only restart when no sessions are active. Restarting kills running sessions,
including from a concurrent sprint in a different repo.

**`core.bare=true` recurrence** (issue #1206/#1243/#1330): some worktree
operation flips `core.bare` to `true` on the main checkout. Hot-patch with
`git config core.bare false` before every batch of git operations. Treat as
a routine pre-flight step and a post-`bye` check until the sticky fix lands.

**Run all sprint commands from within the project root.** `mcx claude ls` and
`mcx claude wait` filter sessions by the current repo's git root. Use `--all`
to see sessions from all repos.

### Quota check

```bash
mcx call _metrics quota_status
```

Parse the response and apply the gating rules in [Quota gating](#quota-gating).
If ≥95%, do not start. If ≥80%, start with QA/review-only work.

## Work item tracking

The work item tracker replaces manual `gh pr view` / `gh run list` polling.
Track every issue at spawn time, attach PRs when they appear, and let the
poller + event system drive the pipeline. Phases are columns in the work
item — the phase scripts update them via `_work_items.work_items_update`.

| Command | Purpose |
|---------|---------|
| `mcx track <issue-number>` | Start tracking (creates work item in `impl` phase) |
| `mcx tracked --json` | List all tracked items with PR/CI/review state |
| `mcx tracked --phase impl` | Filter by phase |
| `mcx untrack <number>` | Stop tracking |
| `mcx claude wait --timeout 30000` | Block until session or work-item event |

**`work_items_update` does NOT auto-populate `branch` from `prNumber`**
(#1424). The triage phase requires both, and its error message
("requires a work item with issueNumber and branch") doesn't say which
is missing. Always set both together when attaching a PR:

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

Spawned sessions are not the Agent tool. The Agent tool is
delegate-collect-discard. Spawned sessions are running team members —
they accumulate understanding of the codebase over time. That context is
an asset worth preserving.

A session should only be ended (`bye`) when its area of responsibility is
**conclusively** finished. For an impl session, that's *PR merged* OR
(`qa:pass` + zero open threads on all 4 comment surfaces + CI green).
**Pushing the PR is not enough** — Copilot inline reviews arrive
*after* the push and *before* merge, and a fresh repair session loses
the worktree + PR context the impl session has. Sprint 35 burned an
extra opus repair on #1401 because the impl session was `bye`d the
moment its PR was pushed.

These are **not** reasons to end a session:

- Needing clarification or plan approval
- Waiting for a dependency or rate limit
- Pausing between subtasks
- Producing an unexpected result
- Being stuck on a problem you can help with

When in doubt, `send` — don't `bye`.

| Signal | What it means | What to do |
|--------|---------------|------------|
| `session:result` with low cost / few turns | Worker asked a question or needs approval | Read log. Respond via `send`. |
| `session:permission_request` | Tool approval needed | `mcx claude log` then respond. |
| `waiting_permission` in `ls` | Blocked on permission gate | Same. |
| Token count stalled across polls | May be stuck | Log + nudge. |
| Abnormal PR diff (125k deletions, etc.) | Corrupted worktree | Do not spawn QA. Investigate + send. |

Before `bye`, write a one-sentence justification: why is this work genuinely
complete? If you can't, the session probably shouldn't be ended.

## Pipeline (one orchestrator loop per tick)

Per-issue logic is phase-scripted. The orchestrator's loop is:

```
while issues remain:
  event = mcx claude wait --timeout 30000 --short

  # Pre-spawn quota gate (see Quota gating)
  quota = mcx call _metrics quota_status

  for each tracked item:
    # Tick the current phase. The phase script decides: spawn / wait / goto.
    # Note: do NOT pass --dry-run here. Real execution writes the transition
    # log entry and persists state (provider/model/labels/session_id sentinel
    # via impl.ts:117). --dry-run skips both, which breaks subsequent
    # transitions with "(initial) → triage" rejections (#1522).
    result = mcx phase run <item.phase> --work-item <item.id>
    case result.action:
      "spawn":     execute result.command (quota permitting), then
                   phase_state_set session_id=<real-id> (replaces "pending:*")
      "in-flight": session already running — no action this tick
      "wait":      continue — no action this tick
      "goto":      mcx phase run <result.target> --work-item <item.id>
                   then update work_item.phase = result.target

  for each active session:
    if permission_request: check log, send answer
    if idle with PR pushed (impl): bye + tick current phase again
    if cost > $50: interrupt → bye → file issue

  file issues for any problems observed
```

The phase scripts encapsulate what was previously 6-step transition recipes.
For example, the old impl→review handoff (bye + attach PR + run triage +
update phase + spawn reviewer) is now `mcx phase run triage` followed by
`mcx phase run <result.decision>`.

Key invariants (not automatable, orchestrator discipline):
- Use `mcx claude wait`, never `sleep`
- `session:result` means idle, not ended
- Don't `bye` before verifying the PR is pushed
- Don't `bye` a QA session before `qa:pass` / `qa:fail` is on the PR
- Spawn fresh sessions per phase — never reuse across impl/review/QA
- Reuse worktrees across phases via `--cwd` (phase scripts prefer this)
- Never `bye` + respawn to sidestep a stuck session. `send` instead

**When a session fails to close an issue**, ask the user what to do. Don't
silently move on. Every failure must be explicit in the retro.

## Orchestrator-only nudges (not in worker prompts)

Some directives apply to the orchestrator's coordination work and
deliberately don't live in the worker spawn prompts (`.claude/commands/*.md`),
because those prompts are also invoked by CI, by ad-hoc human runs, and by
the GitHub Copilot integration — adding orchestrator-flow assumptions
there pollutes the universal worker contract.

### Before approving qa:pass for merge: enumerate all 4 PR-comment surfaces

GitHub PR comments live on **four** distinct surfaces. Sprint 34's PR #1380
shipped with **17 unresolved Copilot inline comments** because every phase
agent only checked the PR-body surface. Before the orchestrator transitions
a work item to `phase=done` (or hands it to the merge-runner), verify every
open thread on every surface is addressed or dismissed:

```bash
PR=<pr-number>
ISSUE=<issue-number>

# Surface 1: PR body comments (the obvious one)
gh pr view $PR --comments

# Surface 2: Inline file:line comments — where Copilot code review lives
gh api repos/<owner>/<repo>/pulls/$PR/comments \
  --jq '[.[] | {id, path, line, user: .user.login, body: (.body[0:120])}]'

# Surface 3: Review containers — APPROVED / CHANGES_REQUESTED / COMMENTED
gh api repos/<owner>/<repo>/pulls/$PR/reviews \
  --jq '[.[] | {state, user: .user.login, body: (.body[0:160])}]'

# Surface 4: Linked-issue comments (the issue the PR `fixes`)
gh issue view $ISSUE --comments
```

For each open thread, demand one of:

- **Addressed:** code/doc fix in the PR + a reply on the thread citing the
  fix commit. If the fix is present but the reply isn't, post one yourself
  via `gh api repos/{o}/{r}/pulls/{pr}/comments/{thread-id}/replies -X POST -f body="..."`.
- **Dismissed:** explicit reply explaining why (out of scope, incorrect,
  resolved elsewhere). No silent skips.

If any thread is neither, hold the merge — `send` the implementer or
reviewer to address. Do not let `done` proceed.

This will move into the `done.ts` phase script when #1397 (`mcx merge-queue`)
or its precursor lands — at that point the check becomes deterministic and
this section can be deleted.

### Reviewer self-repair (micro-repair) — orchestrator send pattern

When an adversarial reviewer posts `⚠️ Changes Requested` on a PR and the
findings are 1–3 contained edits with file:line citations and concrete fix
descriptions, **`send` the reviewer back to fix its own findings** instead
of spawning a fresh opus repair session. Saved ~$10–15 across sprint 33
and 34 across multiple PRs. The reviewer already has the worktree, the PR
context, and its own diagnosis loaded.

Send the reviewer something like:

```text
You flagged N issues on PR #<pr>. If they're contained fixes with your
existing diagnosis, fix them yourself, push to <branch>, and update the
sticky review with a delta table. If any need a redesign or multi-file
judgment, reply 'needs opus repair'.
```

Let the reviewer self-select. When it replies `needs opus repair`, spawn a
fresh opus repair session per the normal flow. When it pushes a fix and
updates the sticky to ✅, transition the work item to QA.

This pattern lives here (orchestrator-side) and not in
`.claude/commands/adversarial-review.md` because the reviewer prompt is
shared with CI-invoked reviews where there's no orchestrator to send back.

### Auto-merge re-arm after force-push (when no merge-runner is active)

When the orchestrator (rather than `agents/mergemaster.md` or a future
`mcx merge-queue` service) is driving merges, force-push rebases silently
invalidate GitHub auto-merge on some configurations. Before declaring a PR
"queued for merge," verify:

```bash
gh pr view $PR --json autoMergeRequest
```

If `null`, re-arm with `gh pr merge $PR --squash --delete-branch --auto`.
Once the merge-runner is active and owns the merge loop, this is its job
(see `agents/mergemaster.md`); the orchestrator only intervenes when the
runner has escalated.

### qa:pass + qa:fail dual-label invariant (orchestrator audit)

The QA worker swaps labels transactionally (`--add-label X --remove-label
opposite`), but sprint 33's PR #1303 still ended up with both labels because
an early QA didn't include the swap. As a defensive audit before merge:

```bash
gh pr view $PR --json labels -q '[.labels[].name]'
```

If both `qa:pass` and `qa:fail` appear, hold the merge and resolve manually
— the QA history needs review, not a silent label cleanup.

## Sweeping main commits during a sprint

If a commit lands on main mid-sprint that affects *every* branch (e.g.
`.gitignore` replacement, `.git-hooks/` changes, shared config, lint rule
updates), broadcast a rebase directive to all active impl sessions **before**
they push. Otherwise every branch will look like it regresses the sweeping
change, every reviewer will flag it, and every repairer will waste a cycle.

```bash
# For each active impl session:
mcx claude send <id> "Before pushing, rebase your branch onto origin/main to pick up the .gitignore update from commit <sha>. Run: git fetch origin main && git rebase origin/main"
```

Signals a sweeping commit has landed: a repo-root file changed in a recent
merge, or the first reviewer flags it on the first PR. Catch it at the
source, not per-branch during review.

## Quota gating

The daemon polls `/api/oauth/usage` and exposes utilization via
`mcx call _metrics quota_status`:

```json
{ "available": true, "fiveHour": { "utilization": 82, "resetsAt": "..." }, ... }
```

Use `fiveHour.utilization` for gating:

| Utilization | Action |
|-------------|--------|
| **< 80%** | Normal — spawn impl, review, QA freely |
| **≥ 80%** | **Impl freeze** — finish in-flight review/QA, don't spawn new impl |
| **≥ 95%** | **Full pause** — wait for reset |

If `available` is `false` or the call fails, proceed normally. Don't block
the sprint on a monitoring failure.

## Handling stuck workers

The phase scripts emit `{ action: "wait", reason }` when they're waiting on
external state (sticky review comment not posted yet, qa label not set yet,
etc.). If the same wait reason recurs for many ticks, investigate the worker:

1. `mcx claude log <id>` — what's it doing?
2. If it's asking a question: `mcx claude send <id> "<answer>"`
3. If it's stuck in a retry loop: interrupt + `send` guidance
4. If it's genuinely deadlocked: file an issue, then `bye` + respawn

## Meta-file changes require a follow-up `meta` issue

The orchestrator reads skill files (`.claude/skills/**`), memories,
`CLAUDE.md`, `.gitignore`, and the phase scripts (`.claude/phases/**`) and
manifest (`.mcx.yaml`) **live** while running. Workers must not modify them
during a sprint. The retro (and the next planning phase) is the only safe
window.

When a worker's PR needs a meta change:

1. `send` the worker to revert the meta hunks before pushing
2. File a new issue with the **`meta`** label, referencing the PR
3. The `meta`-labeled issue will surface in the next `/sprint plan`

If you discover the orchestrator's skill or phase definition is genuinely
broken mid-sprint, **spike the sprint early.** Complete in-flight work, file
the `meta` issue, replan. Don't limp along with a broken phase.

## Run-only vs auto-chain mode

The invoker may ask for run-only mode (the user wants to defer review/retro,
e.g. because the release is going out separately, or they want to merge more
PRs first). The routing is decided in `SKILL.md`:

- **Auto-chain (default)** — on `/sprint` (plan exists) or `/sprint <N>` where
  `sprint-<N>.md` exists: run → review → retro, all in this session.
- **Run-only** — on `/sprint run` or `/sprint run <N>`: run stops at wind-down
  step 8. Mark the plan header now so the intent is visible in git:

  When you write the "Started …" timestamp to the plan header (see the
  "Input" section at the top of this file), append `(RUN ONLY)` directly
  after it, on the same line, e.g.:

  ```
  > Planned 2026-04-23 23:45 local. Started 2026-04-24 02:48 EDT (RUN ONLY). Target: 18 PRs (...)
  ```

  The marker is an operator note — `/sprint review` and `/sprint retro` read
  it and produce a "resumed from RUN ONLY" line in the release notes / diary.

Ad-hoc `/sprint <issue-numbers>` runs have no plan file to mark and do not
auto-chain — the orchestrator just exits at wind-down step 8 for those.

## Wind-down

When the sprint is winding down (≤2 active sessions):

1. Record end timestamp in the sprint file header
2. Start `/sprint plan` for the next sprint while the last sessions finish
3. After all sessions complete: report merged / failed / in-progress using
   `mcx tracked --json`
4. `mcx untrack` any remaining items
5. `mcx gc` to prune merged branches and stale worktrees
6. Before rebuild: confirm no concurrent cross-repo sprints (#1250)
7. `git checkout main && git pull && bun run build`
8. `mcx shutdown && mcx status` to pick up the new build (skip if another
   sprint is still active — restart kills its sessions)

**If run-only mode** (plan header has `(RUN ONLY)` or invocation was
`/sprint run …` or ad-hoc issue numbers): stop here. Report to the user
what shipped and note that review/retro were skipped by request.

**Otherwise (auto-chain mode)**: continue inline, same session, same context
— do **not** re-invoke as `/sprint review` or `/sprint retro` (that pays a
~300k-token cache miss to re-read the post-run conversation you already
have):

9. Read `references/review.md` and execute every step (gather what
   shipped, bump version, lint + typecheck, commit, push, tag, push tag,
   create GH release, update the sprint file's Results section). When
   review.md says "this completes the review phase", continue to step 10.
10. Read `references/retro.md` and execute every step (write the diary
    file from the context you already have — do NOT launch scanners;
    commit; push; remove `.claude/sprints/.active`).

Report a single combined summary to the user when both are done: merged
PRs, version cut, diary path, any unresolved follow-ups.
