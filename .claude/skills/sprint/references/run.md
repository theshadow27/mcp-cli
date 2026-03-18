# Sprint Execution

Run the implementation pipeline. You are the orchestrator — you never write
code directly, you spawn sessions and manage the pipeline.

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

## Pipeline

For each issue, run the full lifecycle:

### Implement

Always use opus. For documentation-only issues, use sonnet.
PRs always target `main` — never feature branches. Feature branch merges caused
a 44-file conflict nightmare in Sprint 14.

```bash
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode
```

### Triage

After implementation completes, end the session. The `bye` response includes
the worktree path — **save it** for reuse in subsequent phases:

```bash
# bye returns JSON: {"ended":true,"worktree":"claude-xxx","cwd":"/path/...","repoRoot":"/path/..."}
mcx claude bye <sessionId>
```

**Track the worktree path** from the `bye` response. If `cwd` is null (daemon-
created worktrees), resolve it: `.claude/worktrees/<worktree-name>` relative
to the repo root.

Run triage from the worktree directory:

```bash
cd <worktree-path> && bun .claude/skills/estimate/triage.ts --base main --json
```

**High scrutiny** if ANY of:
- src churn (additions + deletions, excluding tests) >= 120 lines
- src additions >= 100 lines
- 2+ risk areas touched (IPC, auth, workers, server-pool, config, db, transport)
- 4+ source files across 2+ packages

Everything else is **low scrutiny**.

### Review (high scrutiny only)

**Reuse the worktree** from the implement phase via `--cwd`:

```bash
mcx claude spawn --cwd <worktree-path> --model sonnet -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

If review finds issues, spawn an opus repair session on the same worktree:

```bash
mcx claude spawn --cwd <worktree-path> -t "Repair PR #N ..." --allow Read Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode
```

Then re-triage. High scrutiny rewrites get 2 adversarial reviews.

### QA

**Reuse the worktree** from the implement phase via `--cwd`. If the worktree
was auto-cleaned by `bye` (happens when the branch was pushed and worktree is
clean), use `--worktree` instead to give QA its own isolated worktree:

```bash
# Preferred: reuse existing worktree
mcx claude spawn --cwd <worktree-path> --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash

# Fallback: worktree was auto-cleaned, create a fresh one
mcx claude spawn --worktree --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
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

```
while issues remain:
  mcx claude wait --timeout 30000 --short   # block until event or 30s
  mcx claude ls --short                      # check all session states

  for each session that completed (idle/result):
    if implementation session:
      bye → save worktree path → triage → spawn review or QA (--cwd)
      spawn next issue from backlog (backfill the slot)
    if review session:
      bye → read findings → spawn repair (--cwd) if needed, else spawn QA (--cwd)
    if QA session:
      bye → record result (merged or failed)

  for each active session:
    if cost > $50: interrupt → bye → file issue about what went wrong
    (sessions stuck retrying pre-commit hooks can burn $100+/hr unattended)

  file issues for any problems observed
```

**Key rules:**
- Use `mcx claude wait`, never `sleep` — wait is event-driven and interruptible
- Check `session:result` in wait output — it means idle (waiting for input), NOT ended
- Always `bye` before triaging (need the worktree path for triage.ts)
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
3. After all sessions complete: report what merged, what failed, what's in progress
4. Pull main and rebuild: `git checkout main && git pull && bun run build`
4. Restart the daemon so it picks up the new build: verify no sessions active
   with `mcx claude ls`, then restart. This ensures the next sprint runs on
   the latest code (including any daemon fixes merged during this sprint).
5. Run `/sprint review` to cut a release
6. Run `/sprint retro` to capture learnings
