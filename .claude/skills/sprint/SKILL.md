---
name: sprint
description: >
  Clear the issue backlog autonomously. Surveys open issues, picks ready work,
  and runs the full implement → triage → review → QA pipeline in parallel.
  Use when the user says "clear the backlog", "run a sprint", "do the thing",
  "/sprint", "work through the issues", or any variant of "go implement stuff".
  This is the top-level orchestrator — it picks what to work on and runs it.
---

# Sprint

Survey the board, pick ready issues, and run them through the full pipeline.

You are the orchestrator. You never write code directly — you spawn sessions
that do the work, monitor them, and manage the pipeline. Read
`references/mcx-claude.md` for the full mcx claude command reference.

## Phase 1: Survey

Run `/board-overview` to get the current state of the board. This writes
`.claude/arcs.md` with grouped issues and ready counts.

If `.claude/arcs.md` already exists and is less than 1 hour old, skip the
survey and use the existing file.

## Phase 2: Pick issues

From the board overview, select issues to run. Rules:

1. Never pick issues labeled `needs-clarification`
2. Prefer issues that unblock other issues (dependency roots first)
3. Prefer issues in active arcs over ungrouped ones
4. Read each issue body before launching — skip if unclear or underspecified
5. Start with up to 5 issues in the first batch

If the user passed issue numbers as arguments (e.g. `/sprint 123 456`), use
those instead of picking from the board.

Report your picks to the user before launching: "Starting sprint with #N, #M,
#P. These look ready — go ahead?" Wait for confirmation unless the user said
to run autonomously.

## Phase 3: Run the pipeline

For each issue, run the full lifecycle. This is the same pipeline as `/run-issue`:

### 3a. Implement

Always use opus. The implementation cost is similar across models; quality isn't.

```bash
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

For documentation-only issues, use sonnet:
```bash
mcx claude spawn --worktree --model sonnet -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

### 3b. Triage

After implementation completes, end the session and measure the diff:

```bash
mcx claude bye <sessionId>
bun .claude/skills/estimate/triage.ts --base main --json
```

The triage rules (92.5% F1, 0% false negatives on 91 historical PRs):

**High scrutiny** if ANY of:
- src churn (additions + deletions, excluding tests) >= 120 lines
- src additions >= 100 lines
- 2+ risk areas touched (IPC, auth, workers, server-pool, config, db, transport)
- 4+ source files across 2+ packages

Everything else is **low scrutiny**.

### 3c. Review (high scrutiny only)

```bash
mcx claude spawn --worktree -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

If review finds issues, spawn a repair session on the same branch, then
re-triage. Loop until clean.

### 3d. QA

```bash
mcx claude spawn --worktree -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

QA verifies and merges if passing.

### 3e. Failure handling

When QA does not merge:

1. Label the issue `needs-clarification`:
   ```bash
   gh issue edit N --add-label "needs-clarification"
   ```
2. Comment on the PR with what went wrong, branch, PR number, session ID
3. Report to user — do not retry automatically

## Phase 4: Monitor and saturate

Poll with `mcx claude ls` at ~30 second intervals. Between polls, do useful work:

- Clean up merged sessions and worktrees
- Spawn the next batch of issues as slots free up
- File new issues for problems discovered during monitoring
- Check `gh issue list --state open` periodically for new issues filed by sessions

The goal is to keep 5 slots saturated. As sessions complete, backfill from the
board. Stop when:
- The ready backlog is empty
- All remaining issues are labeled `needs-clarification`
- The user interrupts

## Phase 5: Wrap up

When the sprint is done (or the user stops it):

1. Report what was merged, what failed, what's still in progress
2. Clean up any remaining sessions: `mcx claude bye <id>`
3. If 5+ PRs merged, spawn a documentation review:
   ```bash
   mcx claude spawn --worktree -t "/documentation-review <pr-numbers>" --allow Read Glob Grep Write Edit Bash
   ```
4. If 3+ PRs in the same feature area merged, spawn a coherence review:
   ```bash
   mcx claude spawn --worktree -t "/coherence-review [area] PRs #N1 #N2 #N3" --allow Read Glob Grep Bash
   ```
5. Run `/diary` to capture the session

## Rules

- **Never implement directly.** Always delegate to spawned sessions.
- **Never switch models mid-stream.** Kill and restart fresh if wrong model.
- **Spawn fresh sessions per phase.** Don't reuse sessions across implement/review/QA.
- **File every problem as an issue.** Unfiled problems are invisible problems.
- **Never randomly kill the daemon.** File an issue if a kill seems required.
- **Don't tight-loop polls.** Do useful work between checks.
