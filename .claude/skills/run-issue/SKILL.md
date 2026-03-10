---
name: run-issue
description: Run the full dev pipeline for a GitHub issue — spawn a Claude in a worktree, implement, simplify, QA, and clean up. Use when the user says "run issue N", "implement and QA N", or "work on N end-to-end".
---

# Run Issue

Orchestrate the full lifecycle of a GitHub issue: implement, simplify, QA, merge.

You are also dog-fooding this project; if you find a bug or unexpected behavior in **any** functionality while performing this work, that is a P1 issue that should be written up and addressed ASAP. 

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

Always use opus. The implementation cost is similar across models; quality isn't.

```bash
mcx claude spawn --worktree -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

Save the returned `sessionId`. Monitor with `mcx claude ls` until idle.

For documentation-only issues, use sonnet (no code complexity to handle):
```bash
mcx claude spawn --worktree --model sonnet -t "/implement N" --allow Read Glob Grep Write Edit Bash
```

### 2. Triage

After implementation completes, measure the actual diff to decide review depth. Spawn a fresh session on the same branch:

```bash
mcx claude bye <sessionId>
```

Then check the diff from the worktree (or from the branch if worktree is cleaned):

```bash
# Get the branch name from the worktree or PR
gh pr list --head <branch> --json number,headRefName
```

The triage rules (validated: 92.5% F1, 0% false negatives on 91 historical PRs):

**High scrutiny** if ANY of:
- src churn (additions + deletions, excluding tests) ≥ 120 lines
- src additions ≥ 100 lines
- 2+ risk areas touched (IPC, auth, workers, server-pool, config, db, transport)
- 4+ source files across 2+ packages

Everything else is **low scrutiny**.

You can run this mechanically:
```bash
bun .claude/skills/estimate/triage.ts --base main --json
```

### 3a. Low scrutiny path

Spawn QA directly:

```bash
mcx claude spawn --worktree -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

### 3b. High scrutiny path

Spawn adversarial review first:

```bash
mcx claude spawn --worktree -t "/adversarial-review (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

Wait until idle. If review finds issues:

```bash
# Spawn repair session on the same branch
mcx claude spawn --worktree -t "Fix issues found in adversarial review of PR <pr-number>: <summary of issues>" --allow Read Glob Grep Write Edit Bash
```

After repair, re-triage. If still high scrutiny, review again. Loop until clean, then proceed to QA.

### 4. QA

```bash
mcx claude spawn --worktree -t "/qa N (PR <pr-number>, branch <branch>)" --allow Read Glob Grep Write Edit Bash
```

Wait until idle. QA verifies and merges if passing.

### 5. Clean up

```bash
mcx claude bye <sessionId>
```

Before removing a worktree, check for uncommitted work:
```bash
git -C <worktree-path> status --porcelain
```

- If clean (empty output): `git worktree remove <worktree-path>`
- If dirty: investigate before removing — there may be valuable uncommitted work.

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

After every batch of merged PRs (5-10), spawn a documentation review session:

```bash
mcx claude spawn --worktree -t "/documentation-review 123 124 125 126" --allow Read Glob Grep Write Edit Bash
```

Replace the PR numbers with the actual merged PRs. The `/documentation-review` command handles the full workflow: reviewing all project docs, fixing inconsistencies, and opening a PR.

## Periodic Review

For large feature blocks (3+ related issues), periodically spawn a coherence review session to assess overall architectural consistency:

```bash
mcx claude spawn --worktree -t "/coherence-review [feature area] PRs #N1 #N2 #N3 #N4" --allow Read Glob Grep Bash
```

The `/coherence-review` skill checks for architectural consistency across PRs, missed integration points, duplicated patterns, and wrong directions — then files issues for any problems found.

Launch a review after every 3-4 issues in the same feature area merge, or whenever a session's cost exceeds $15 (sign of complexity/struggle).

## Issue discipline

**Claude is the user of this project.** mcx is built by Claude, for Claude. Except for occasionally on `mcpctl`, there are no human users filing bug reports. That means every Claude — orchestrator, implementer, QA — is responsible for filing issues when problems are encountered. The quality of code, documentation, and organization directly benefit future Claude sessions.

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

You must read each issue body before launching it. Issues with no dependencies can run in parallel. Spawn all implementations first, then clear+simplify+QA each as they complete. Do not wait for one to finish before starting the next.

In case of very large stories, break them into smaller issues first. Run them in dependency order until the original feature is complete. 

Maximum recommended concurrency: 4-6 sessions (cost and rate limit considerations).

Your goal: Clear the backlog of mechanical work and easy calls, so the user can focus on design and concept decisions. 