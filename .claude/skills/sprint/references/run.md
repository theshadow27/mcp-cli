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

## Pipeline

For each issue, run the full lifecycle:

### Implement

Always use opus. For documentation-only issues, use sonnet.

```bash
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

### Triage

After implementation completes, end the session and measure the diff:

```bash
mcx claude bye <sessionId>
bun .claude/skills/estimate/triage.ts --base main --json
```

**High scrutiny** if ANY of:
- src churn (additions + deletions, excluding tests) >= 120 lines
- src additions >= 100 lines
- 2+ risk areas touched (IPC, auth, workers, server-pool, config, db, transport)
- 4+ source files across 2+ packages

Everything else is **low scrutiny**.

### Review (high scrutiny only)

```bash
mcx claude spawn --worktree --model sonnet -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

If review finds issues, spawn an opus repair session on the same branch, then
re-triage. High scrutiny rewrites get 2 adversarial reviews.

### QA

```bash
mcx claude spawn --worktree --model sonnet -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

QA verifies and merges if passing.

### Failure handling

When QA does not merge:
1. Label the issue `needs-clarification`
2. Comment on the PR with what went wrong
3. Report to user — do not retry automatically

## Monitor and saturate

This is the main loop. The goal is maximum throughput — keep 5 opus
implementation slots full, with unlimited sonnet review/QA slots.

```
while issues remain:
  mcx claude wait --timeout 30000 --short   # block until event or 30s
  mcx claude ls --short                      # check all session states

  for each session that completed (idle/result):
    if implementation session:
      bye → triage → spawn review or QA
      spawn next issue from backlog (backfill the slot)
    if review session:
      bye → read findings → spawn repair if needed, else spawn QA
    if QA session:
      bye → record result (merged or failed)
      clean up worktree

  file issues for any problems observed
```

**Key rules:**
- Use `mcx claude wait`, never `sleep` — wait is event-driven and interruptible
- Check `session:result` in wait output — it means idle (waiting for input), NOT ended
- Always `bye` before triaging (need the worktree path for triage.ts)
- Don't `bye` a session before verifying the PR was pushed
- Spawn fresh sessions per phase — never reuse across implement/review/QA
- Don't bulk-clean worktrees during a sprint — check `mcx claude ls` first
- Don't restart the daemon mid-batch — wait for active sessions to idle

**Stop when:**
- All planned issues are done or failed
- The user interrupts

## Wind-down

When the sprint is winding down (2 or fewer active sessions remaining):

1. **Start planning the next sprint** — run `/sprint plan` while waiting for
   the last sessions to complete. This overlaps planning with execution.
2. After all sessions complete: report what merged, what failed, what's in progress
3. Pull main and rebuild: `git checkout main && git pull && bun run build`
4. Run `/sprint review` to cut a release
5. Run `/sprint retro` to capture learnings
