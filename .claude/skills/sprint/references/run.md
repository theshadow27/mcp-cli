# Sprint Execution

Run the implementation pipeline. You are the orchestrator — you never write
code directly, you spawn sessions and manage the pipeline.

**Spawned sessions are running team members, not function calls.** They
maintain their own context, memory, and ongoing work — just like you do.
Ending a session is like firing a colleague mid-project. Do it only when
their role is genuinely complete, not when they ask a question or get stuck.

## Input

Determine what to run, in priority order:

1. **Issue numbers passed as arguments** (e.g. `/sprint 123 456`) — use those
2. **Sprint plan exists** — read `.claude/sprints/sprint-{N}.md` (latest by number),
   use its issue list and batch assignments
3. **Neither** — tell the user to run `/sprint plan` first or pass issue numbers

If using a sprint plan, announce: "Running sprint {N}: {goal}. Batch 1: #X, #Y, #Z..."

Record the start timestamp in the sprint file header (append to the `>` line):
```
> Planned {date}. Started {date} {HH:MM local}. Target: 15 PRs.
```

## Pre-flight

Before spawning any sessions, ensure the daemon is running the latest build:

```bash
bun run build                          # compile latest binaries
mcx claude ls --short 2>/dev/null      # if no sessions active, safe to restart
mcx status                             # verify daemon is up and running new code
```

If the daemon was started before the latest `bun run build`, restart it — otherwise
sessions will run against stale code. Only restart when no sessions are active.

### Quota check

Check quota headroom before spawning the first batch:

```bash
mcx call _metrics quota_status
```

Parse the response and apply the gating rules described in [Quota gating](#quota-gating).
If utilization is already ≥95%, do not start the sprint — report the reset time and wait.
If ≥80%, start with QA/review-only work (no new impl sessions) until utilization drops.

## Work Item Tracking

The work item tracker replaces manual `gh pr view` / `gh run list` polling.
Track every issue at spawn time, attach PRs when they appear, and let the
poller + event system drive the pipeline.

### Commands

| Command | Purpose |
|---------|---------|
| `mcx track <issue-number>` | Start tracking an issue (creates work item in `impl` phase) |
| `mcx tracked --json` | List all tracked items with PR/CI/review state |
| `mcx tracked --phase impl` | Filter by phase (`impl`, `review`, `repair`, `qa`, `done`) |
| `mcx untrack <number>` | Stop tracking |
| `mcx wait --any --timeout 30000` | Block until a session event OR work item event fires |
| `mcx wait --pr <number> --checks` | Block until CI passes or fails for a specific PR |

### Event types

The poller emits these events (used by `mcx wait --any` and `mcx wait --pr`):

| Event | Meaning |
|-------|---------|
| `checks:passed` | CI passed — ready for next phase |
| `checks:failed` | CI failed — needs repair |
| `review:approved` | Review approved — advance to QA |
| `review:changes_requested` | Reviewer requested changes — spawn repair |
| `pr:merged` | PR merged — mark done |
| `pr:closed` | PR closed without merge — investigate |

### Phase lifecycle

Each work item moves through phases. Use the MCP tool `work_items_update` (or
`mcx call _work_items work_items_update`) to advance phases:

```
impl → review → qa → done
impl → qa → done              (low scrutiny, skip review)
review → repair → review      (repair cycle)
qa → repair → review → qa     (QA rejection cycle)
```

## Interacting with workers

Spawned sessions are not the Agent tool. The Agent tool is
delegate-collect-discard. Spawned sessions are running team members —
they accumulate understanding of the codebase, prior decisions, and your
intent over time. That accumulated context is valuable and cannot be
transferred to a new session. It is an asset worth preserving.

### Default: keep sessions alive

A session should only be ended (`bye`) when its entire area of
responsibility is finished — the PR is pushed, QA is done, the issue is
closed. These are **not** reasons to end a session:

- Needing clarification or plan approval
- Waiting for a dependency or rate limit
- Pausing between subtasks
- Producing an unexpected result
- Being stuck on a problem you can help with

When in doubt, `send` — don't `bye`.

### Conversation pattern

Interactions with spawned sessions follow a **conversation pattern**, not
a request-response pattern. After reading a session's output, the next
action should usually be responding with feedback — not collecting the
result and disposing of the session.

```bash
# Answer a question or approve a plan
mcx claude send <id> "Yes, proceed with the implementation"

# Redirect a worker that's going off track
mcx claude send <id> "Stop — your PR has 125k deletions. Your worktree state is corrupted. Investigate before pushing."

# Provide missing context
mcx claude send <id> "The dependency #1188 already merged. You can import pollNow directly."

# Nudge a stalled session
mcx claude send <id> "continue"
```

### Recognizing when a worker needs you

| Signal | What it means | What to do |
|--------|---------------|------------|
| `session:result` with low cost / few turns | Worker stopped early — likely asked a question or needs approval | Read the log. Respond via `send`. |
| `session:permission_request` in wait output | Worker is waiting for tool approval | Check `mcx claude log <id>` to see what it's requesting. |
| `waiting_permission` state in `ls` output | Worker blocked on a permission gate | Same — check the log and respond. |
| Token count stalled across multiple polls | Worker may be stuck or waiting | Check the log. Send a nudge or guidance. |
| Abnormal PR diff (e.g., 125k deletions) | Something went wrong in the worktree | Do **not** spawn QA. Investigate, then `send` guidance or close the PR. |

### Before ending a session

Before `bye`, write a one-sentence justification: why is this session's
work genuinely complete? If you can't justify it, the session probably
shouldn't be ended.

What additional context would allow this task to complete as intended?
`send` that instead.

## Pipeline

For each issue, run the full lifecycle:

### Implement

Always use opus. For documentation-only issues, use sonnet.
PRs always target `main` — never feature branches. Feature branch merges caused
a 44-file conflict nightmare in Sprint 14.

#### Flaky test issues

Issues with "flaky" in the title or labeled `flaky` get special treatment:

1. **Always opus** for implementation (never sonnet — flaky fixes need deep analysis)
2. **Always adversarial review** after implementation, regardless of scrutiny classification
3. The review must verify the fix addresses the **root cause**, not just the symptom.
   Papering over timing with longer timeouts or retry loops is not acceptable —
   the review should reject fixes that don't eliminate the race/nondeterminism.

This prevents the cycle where flaky tests get "fixed" with superficial changes
that pass locally but fail again under CI load.

#### Provider routing

If the sprint plan has a `Provider` column for the issue, route the spawn
through that provider instead of `mcx claude`. Default is `claude`.

| Provider value | Spawn command |
|----------------|---------------|
| `claude` (default) | `mcx claude spawn` |
| `copilot` | `mcx copilot spawn` |
| `gemini` | `mcx gemini spawn` |
| `acp:<agent>` | `mcx acp spawn --agent <agent>` |

```bash
# Default (claude)
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode

# With --provider copilot
mcx copilot spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode

# With --provider gemini
mcx gemini spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode

# With --provider acp:<custom-agent>
mcx acp spawn --agent <custom-agent> --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode
```

The provider flag also applies to review, repair, and QA sessions for that issue.
All sessions in an issue's lifecycle use the same provider.

**Immediately after spawning**, track the issue:

```bash
mcx track <issue-number>
```

This creates a work item in `impl` phase. The poller won't watch it yet (no PR
attached), but it establishes the item for status tracking via `mcx tracked`.

### Triage

After implementation completes, end the session:

```bash
mcx claude bye <sessionId>
```

**Attach the PR to the tracked work item** so the poller can watch CI/review:

```bash
# Get the PR number from the session output or branch
PR=$(gh pr list --head <branch> --json number -q '.[0].number')
mcx call _work_items work_items_update '{"id":"#<issue>","prNumber":'$PR'}'
```

This links the issue's work item to its PR. The poller will start watching
CI status and review state on the next poll cycle.

Run PR-based triage (works from any directory — no worktree needed):

```bash
bun .claude/skills/estimate/triage.ts --pr <pr-number> --json
```

**High scrutiny** if ANY of:
- src churn (additions + deletions, excluding tests) >= 120 lines
- src additions >= 100 lines
- 2+ risk areas touched (IPC, auth, workers, server-pool, config, db, transport)
- 4+ source files across 2+ packages

Everything else is **low scrutiny**.

Advance the work item phase based on triage result:

```bash
# High scrutiny → review phase
mcx call _work_items work_items_update '{"id":"#<issue>","phase":"review"}'

# Low scrutiny → straight to QA
mcx call _work_items work_items_update '{"id":"#<issue>","phase":"qa"}'
```

### Review (high scrutiny only)

Use `--worktree` for review sessions. (`--cwd` rarely works in practice because
`bye` auto-cleans the impl worktree once the branch is pushed.)

```bash
# Default (claude)
mcx claude spawn --worktree --model sonnet -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash

# With provider (e.g. copilot) — use the same provider as the implement phase
mcx copilot spawn --worktree --model sonnet -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

**Reviewers must post findings as PR comments** (via `gh pr comment` or `gh api`),
not just print them to the session. PR comments are the durable shared context —
repair sessions, second reviewers, and QA all read them.

If review finds issues, spawn an opus repair session in a fresh worktree.
**Always instruct the repairer to read the sticky review comment first:**

```bash
# Default (claude)
mcx claude spawn --worktree -t "Repair PR #N. First read the adversarial review comment on the PR: gh pr view N --comments. Look for the comment starting with '## Adversarial Review'. Fix all 🔴 and 🟡 issues. Push to existing branch." --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode

# With provider — match the issue's provider
mcx copilot spawn --worktree -t "Repair PR #N. First read the adversarial review comment on the PR: gh pr view N --comments. Look for the comment starting with '## Adversarial Review'. Fix all 🔴 and 🟡 issues. Push to existing branch." --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode
```

The review uses a sticky comment pattern — on re-review, it updates the same comment
with a delta table showing what was ✅ Fixed vs ⏳ Not addressed vs 🔄 Partially fixed.
This gives repairers and QA a single source of truth for all findings across rounds.

Then re-triage. High scrutiny rewrites get 2 adversarial reviews.

### QA

**Reuse the worktree** from the implement phase via `--cwd`. If the worktree
was auto-cleaned by `bye` (happens when the branch was pushed and worktree is
clean), use `--worktree` instead to give QA its own isolated worktree:

```bash
# Preferred: reuse existing worktree (default claude)
mcx claude spawn --cwd <worktree-path> --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash

# Fallback: worktree was auto-cleaned, create a fresh one
mcx claude spawn --worktree --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash

# With provider — match the issue's provider (e.g. copilot)
mcx copilot spawn --cwd <worktree-path> --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

QA verifies and merges if passing.

**CRITICAL: Never spawn QA (or review) without `--cwd` or `--worktree`.**
Without either flag, the session runs in the main repo folder, polluting the
user's working tree with branch checkouts and file modifications.

### Failure handling

When QA does not merge:
1. Label the issue `needs-clarification`
2. Comment on the PR with what went wrong
3. Report to user — do not retry automatically

## Worktree lifecycle

Each issue gets ONE worktree, created at implementation time. All subsequent
phases (review, repair, QA) reuse it via `--cwd`. This avoids creating
redundant worktrees and avoids branch checkout conflicts.

**Note:** `bye` auto-cleans worktrees when all changes are committed and
pushed. If you `bye` the implementation session before spawning review/QA,
the worktree path will be gone. In that case, use `--worktree` for the
next phase instead of `--cwd`.

```
implement: spawn --worktree  →  creates worktree  →  bye (save worktree path)
review:    spawn --cwd <path> →  reuses worktree   →  bye
repair:    spawn --cwd <path> →  reuses worktree   →  bye
QA:        spawn --cwd <path> →  reuses worktree   →  bye (final cleanup)

# If worktree was auto-cleaned after bye:
review/QA: spawn --worktree  →  creates fresh worktree  →  bye
```

Only the final `bye` (after QA merge or failure) should clean up the worktree.

## Monitor and saturate

This is the main loop. The goal is maximum throughput — keep 5 opus
implementation slots full, with unlimited sonnet review/QA slots.

The loop is **event-driven**: `mcx wait --any` blocks until either a session
event or a work item event fires, then you react. No manual `gh pr view` or
`gh run list` polling needed — the work item poller handles GitHub state.

Track the **provider** for each issue from the sprint plan. When spawning any
session (implement, review, repair, QA), use `mcx <provider>` instead of
`mcx claude` if the issue has a non-default provider. For `acp:<agent>`,
use `mcx acp --agent <agent>`.

Also track ACP sessions separately: `mcx copilot ls`, `mcx gemini ls`, or
`mcx acp ls` to check provider-specific session lists. `mcx claude ls` only
shows Claude sessions.

### Dashboard

Use `mcx tracked --json` for a unified view of all work items instead of
per-PR GitHub API calls:

```bash
mcx tracked --json          # all items with PR/CI/review state
mcx tracked --phase impl    # just implementation items
mcx tracked --phase review  # items awaiting review
mcx tracked --phase qa      # items in QA
```

### Main loop

```
while issues remain:
  # Block until session event OR work item event (30s timeout)
  event = mcx wait --any --timeout 30000 --short

  # Check session states
  mcx claude ls --short
  # If any issues use ACP providers, also check those:
  mcx copilot ls --short 2>/dev/null
  mcx gemini ls --short 2>/dev/null

  # Dashboard — unified status from tracker
  mcx tracked --json

  # Quota gate — check before spawning (see "Quota gating" section)
  quota = mcx call _metrics quota_status
  utilization = quota.fiveHour.utilization  # may be unavailable — proceed if so

  # --- React to work item events ---
  if event.source == "work_item":
    match event.workItemEvent.type:
      "checks:passed":
        # CI passed — advance to next phase
        item = mcx tracked --json | find item by event.prNumber
        if item.phase == "impl":
          # Implementation CI passed — proceed to triage
          # (triage was already run at bye time, but CI confirms it's green)
          log "CI passed for PR #{prNumber}, ready for review/QA"
        if item.phase == "review" or item.phase == "repair":
          log "CI passed after repair for PR #{prNumber}"
        if item.phase == "qa":
          log "CI green for PR #{prNumber} — QA can proceed to merge"

      "checks:failed":
        # CI failed — spawn repair session
        item = mcx tracked --json | find item by event.prNumber
        mcx call _work_items work_items_update '{"id":"<item.id>","phase":"repair"}'
        if utilization < 95%:
          spawn repair session (--worktree) to fix CI failures
          # Instruct repairer: "CI failed on PR #N. Check `gh run view <runId>` for details."
        else:
          log "repair deferred — quota at {utilization}%"

      "review:approved":
        # Review approved — advance to QA
        item = mcx tracked --json | find item by event.prNumber
        mcx call _work_items work_items_update '{"id":"<item.id>","phase":"qa"}'
        if utilization < 95%:
          spawn QA session (--worktree)
        else:
          log "QA spawn deferred — quota at {utilization}%"

      "review:changes_requested":
        # Reviewer requested changes — spawn repair
        item = mcx tracked --json | find item by event.prNumber
        mcx call _work_items work_items_update '{"id":"<item.id>","phase":"repair"}'
        if utilization < 95%:
          spawn repair session (--worktree)
          # Instruct repairer to read PR comments first
        else:
          log "repair deferred — quota at {utilization}%"

      "pr:merged":
        # PR merged — mark done
        mcx call _work_items work_items_update '{"id":"<item.id>","phase":"done"}'
        mcx untrack <item.issueNumber>
        log "✓ PR #{prNumber} merged — issue #{issueNumber} done"

      "pr:closed":
        # PR closed without merge — investigate
        log "⚠ PR #{prNumber} closed without merge — investigate"

  # --- React to session events ---
  if event.source == "session" or timeout:
    for each session with permission_request:
      check log — if worker is asking a question or waiting for approval:
        mcx claude send <id> "<answer or approval>"
      if worker is making steady progress (edits succeeding), wait

    for each session that completed (idle/result):
      # ALWAYS read the log before bye-ing. Cheap completions (<$0.50,
      # <15 turns) often mean the worker asked a question or needs input.
      # Don't assume failure — check first, respond via send if needed.
      if implementation session (and log confirms PR was pushed):
        bye → attach PR to tracker → triage (--pr N)
        → advance phase (review or qa) → spawn next phase (--worktree)
        if utilization < 80%:
          spawn next issue from backlog (backfill the slot)
        else:
          log "impl spawn skipped — quota at {utilization}%"
        # Use the issue's provider for the spawn command
      if review session:
        bye
        # Wait for work item events (review:approved, review:changes_requested)
        # to drive next action — no need to manually check review status
      if QA session:
        bye → record result (merged or failed)
        if merged:
          mcx call _work_items work_items_update '{"id":"#<issue>","phase":"done"}'
          mcx untrack <issue>

  if utilization >= 95%:
    log "⚠ quota at {utilization}%, pausing until {quota.fiveHour.resetsAt}"
    # don't spawn anything — wait for next cycle

  for each active session:
    if cost > $50: interrupt → bye → file issue about what went wrong
    (sessions stuck retrying pre-commit hooks can burn $100+/hr unattended)

  file issues for any problems observed
```

**Key rules:**
- Use `mcx wait --any`, never `sleep` — event-driven, handles both session and work item events
- Check `session:result` in wait output — it means idle (waiting for input), NOT ended
- Attach PRs to tracked items after `bye` — the poller can't watch items without a prNumber
- Use `mcx tracked --json` for status — don't poll GitHub directly
- Let work item events drive phase transitions — don't manually check CI/review status
- Triage uses `--pr N` (no worktree needed) — run it after `bye`
- Don't `bye` a session before verifying the PR was pushed
- Spawn fresh sessions per phase — never reuse across implement/review/QA
- Reuse worktrees across phases via `--cwd` — prefer `--cwd`, but use `--worktree` if the worktree was auto-cleaned by `bye`
- Don't bulk-clean worktrees during a sprint — check `mcx claude ls` first
- Don't restart the daemon mid-batch — wait for active sessions to idle

**Stop when:**
- All planned issues are done or failed
- The user interrupts

**When a session fails to close an issue**, ask the user what to do. Don't silently
move on. Every failure must be explicit in the retro — what happened, why, and what
to improve. Possible improvements: refine the issue description, adjust sprint
planning criteria, update implement instructions, or fix the underlying tooling.
Something should always get better when an issue doesn't close.

## Wind-down

When the sprint is winding down (2 or fewer active sessions remaining):

1. **Record the end timestamp** in the sprint file header:
   ```
   > Planned {date}. Started {date} {HH:MM}. Completed {date} {HH:MM}. Result: N/M merged.
   ```
2. **Start planning the next sprint** — run `/sprint plan` while waiting for
   the last sessions to complete. This overlaps planning with execution.
3. After all sessions complete: report what merged, what failed, what's in progress.
   Use `mcx tracked --json` for the final status dashboard — items in `done` phase
   were merged, items in other phases need follow-up.
4. Clean up tracking: `mcx untrack` any remaining items (they'll carry into next sprint otherwise)
5. Pull main and rebuild: `git checkout main && git pull && bun run build`
6. Restart the daemon so it picks up the new build: verify no sessions active
   with `mcx claude ls`, then restart. This ensures the next sprint runs on
   the latest code (including any daemon fixes merged during this sprint).
7. Run `/sprint review` to cut a release
8. Run `/sprint retro` to capture learnings

## Quota gating

The daemon polls `/api/oauth/usage` and exposes utilization via `mcx call _metrics quota_status`.
The response shape:

```json
{
  "available": true,
  "fiveHour": { "utilization": 82, "resetsAt": "2026-04-08T20:00:00Z" },
  "sevenDay": { "utilization": 45, "resetsAt": "..." },
  ...
}
```

Use `fiveHour.utilization` for gating decisions:

| Utilization | Action |
|-------------|--------|
| **< 80%** | Normal operation — spawn impl, review, and QA freely |
| **≥ 80%** | **Impl freeze** — stop spawning new implementation sessions. Let in-flight review and QA finish. Existing impl sessions continue running. |
| **≥ 95%** | **Full pause** — do not spawn any new sessions (impl, review, or QA). Wait for the reset window. |

### Behavior in the monitor loop

Check quota before every spawn decision:

```bash
mcx call _metrics quota_status
```

Parse `fiveHour.utilization` from the JSON response. Then:

1. If **≥ 95%**: log a warning with the reset time (`fiveHour.resetsAt`), enter a
   wait loop (`mcx claude wait --timeout 60000`) until utilization drops below 95%.
   Do not spawn anything.
2. If **≥ 80%**: skip spawning new implementation sessions. Continue spawning
   review and QA sessions (sonnet — cheaper and necessary to land in-flight work).
   Log that impl spawning is paused due to quota.
3. If **< 80%**: proceed normally.

Re-check quota each time through the monitor loop (every `wait` cycle). When
utilization drops back below a threshold, resume normal spawning and log the
transition.

### When quota data is unavailable

If `available` is `false` or the call fails, **proceed normally** — do not block
the sprint on a monitoring failure. Log a warning so the operator is aware.
