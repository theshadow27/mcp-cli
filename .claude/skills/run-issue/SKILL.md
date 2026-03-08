---
name: run-issue
description: Run the full dev pipeline for a GitHub issue — spawn a Claude in a worktree, implement, simplify, QA, and clean up. Use when the user says "run issue N", "implement and QA N", or "work on N end-to-end".
---

# Run Issue

Orchestrate the full lifecycle of a GitHub issue: implement, simplify, QA, merge.

## Prerequisites

- `mcx claude` commands available (daemon running or auto-starts)
- Issue number provided as argument
- Issue must NOT have the `needs-clarification` label

## Picking issues

When selecting issues from the backlog:

```bash
gh issue list --state open --label "!needs-clarification"
```

Never pick up issues labeled `needs-clarification` — these are waiting on human input.

## Pipeline

For each issue N:

### 1. Implement

```bash
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

For simple bug fixes or small tasks, use `--model sonnet` (when available, see #251). Use Opus for complex features.

Save the returned `sessionId`. Monitor with `mcx claude ls` until idle.

### 2. Clear + Simplify

```bash
mcx claude send <sessionId> "/clear"
mcx claude send <sessionId> "/simplify"
```

Wait until idle. Simplify reviews the changes for quality, pushes any fixes.

### 3. Clear + QA

```bash
mcx claude send <sessionId> "/clear"
```

Find the PR number:
```bash
gh pr list --head <branch> --json number
```

Then:
```bash
mcx claude send <sessionId> "/qa N (PR <pr-number>, already checked out)"
```

Wait until idle. QA verifies the implementation and merges if everything passes.

### 4. Clean up

```bash
mcx claude bye <sessionId>
git worktree remove <worktree-path>
```

Always clean up — even on failure.

## Monitoring

Use `mcx claude ls` to check progress across all sessions. Sessions show state (active/idle), cost, and token usage.

**Poll smartly.** Check `mcx claude ls` with ~30 second delays between polls. Don't tight-loop (burns context), don't over-sleep (wastes time). Every 5-10 polls, run `gh issue list --state open` to check for new issues filed by sessions — review them for coherence with project vision and spawn or refine as needed. Between polls, do useful work:
- Spawn more issues from the backlog
- File new issues for problems discovered during monitoring
- Refine issue descriptions, add context, update specs
- Review PRs from completed sessions
- Clean up merged sessions and worktrees

The orchestrator's job is to keep the pipeline saturated, not to watch progress bars. When there's genuinely nothing to do, report status and wait for the user.

**Never implement directly.** The orchestrator must not write code, edit files, or fix bugs itself — always delegate to a spawned session. Direct implementation eats the orchestrator's context window and prevents it from managing the pipeline. If something needs fixing, spawn a session or file an issue.

## Documentation Hygiene

After every batch of merged PRs (5+), spawn a documentation review session:

```bash
mcx claude spawn --worktree -t "Review README.md, CLAUDE.md, and any other docs for inconsistencies with recent changes. Check: outdated file paths, missing new commands/features, stale architecture descriptions, incorrect examples. File issues for each inconsistency found, then fix them." --allow Read Glob Grep Write Edit Bash
```

Docs are part of the product. If a new command was added but not documented, or an old pattern was removed but still referenced, that's a bug.

## Periodic Review

For large feature blocks (3+ related issues), periodically spawn a review session to assess overall coherence:

```bash
mcx claude spawn --worktree -t "Review the recent PRs for [feature area]. Check for: architectural consistency across PRs, missed integration points, duplicated patterns, and anything that looks like it's heading down a wrong path. File issues for any problems found." --allow Read Glob Grep Bash
```

This catches integration issues early — before multiple sessions build on top of a flawed foundation. Launch a review after every 3-4 issues in the same feature area merge, or whenever a session's cost exceeds $15 (sign of complexity/struggle).

## Issue discipline

**Claude is the user of this project.** mcx is built by Claude, for Claude. There are no human users filing bug reports. That means every Claude — orchestrator, implementer, QA — is responsible for filing issues when problems are encountered.

**Every problem gets an issue.** If you notice something wrong, missing, or improvable during any phase — file it immediately. "Not a blocker" is not a reason to skip filing. Issues are how the team tracks and prioritizes work. Unfiled problems are invisible problems.

Examples of things that must be filed:
- A flag or command you tried that didn't work or isn't supported
- Test gaps discovered during QA
- Flaky tests (even if they pass on retry)
- Edge cases the implementation missed
- Performance concerns
- DX papercuts (confusing errors, missing flags, bad defaults)
- Bugs in adjacent code discovered while reading
- Missing documentation or misleading help text

## Failure handling

When QA does not merge the PR:

1. **Label the issue** `needs-clarification`:
   ```bash
   gh issue edit N --add-label "needs-clarification"
   ```

2. **Comment on the PR** with:
   - What went wrong (CI failure, misaligned requirements, test issues, etc.)
   - Branch name
   - PR number
   - Session ID (so work can be resumed or referenced)
   - Worktree path (if still exists)

3. **Report to user** — include issue number, PR number, and reason.

4. **Do not retry automatically** — `needs-clarification` issues require human judgment before re-attempting.

A human clears the label after resolving the issue, making it eligible for pickup again.

## Running multiple issues

Issues with no dependencies can run in parallel. Spawn all implementations first, then clear+simplify+QA each as they complete. Do not wait for one to finish before starting the next.

Maximum recommended concurrency: 4-6 sessions (cost and rate limit considerations).
