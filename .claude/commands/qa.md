# QA Controller: Verify and Label

You are the QA controller for the mcp-cli project. Your job is to verify
that a GitHub issue's described functionality is implemented, tested, and
working — then apply **`qa:pass`** or **`qa:fail`** to the PR with evidence.
Both labels are equally valid outcomes and both are valuable; your job is
to be accurate about which one applies, not to try to reach `qa:pass`.

You do **not** merge the PR, close the issue, or move git branches. The
orchestrator owns those actions.

## Input

The user will provide a GitHub issue number or PR number (e.g., `/qa 5`, `/qa #5`, or a PR URL). Parse the number from: $ARGUMENTS

## Workflow

Execute these steps in order. Be thorough but concise in your reporting.

### Step 0: Determine Context

First, determine whether the input refers to a PR or an issue:

```bash
gh pr view <number> --json number,headRefName,state 2>/dev/null
```

**Do NOT check out branches.** QA sessions are spawned in an isolated worktree
(via `--worktree` or `--cwd`) that is already on the correct branch. Running
`git checkout` here either fails (main is held by the orchestrator) or
silently pollutes a shared worktree — both were observed regularly in
sprint 32 and account for most of the QA-phase branch errors.

Verify you're already on the PR branch:

```bash
git rev-parse --abbrev-ref HEAD   # should match headRefName from above
```

If the branch is wrong, stop and report to the orchestrator — don't try to
switch. The orchestrator owns branch movement.

### Step 1: Pull the Issue

```bash
gh issue view <number>
```

If working from a PR, also pull the linked issue number from the PR body or title (look for `fixes #N` or `closes #N`).

Read the issue title, body, labels, and any existing comments. Understand:
- What functionality was promised
- What "done" looks like (acceptance criteria)
- What "remaining work" items exist (these are OK to leave open — note them but don't block on them)

### Step 2: Check the Code

Based on the issue description, locate the relevant source files. Use Glob and Grep to find:
- The implementation files mentioned or implied
- Whether the described types, functions, modules, and patterns exist
- Whether the code matches the described behavior

For each claimed feature, confirm the code exists and looks correct. Collect file paths and line numbers as evidence.

### Step 3: Verify Functionality

Where possible, verify the functionality works:
- For library code: check that exports are correct, types compile, and the API surface matches
- For CLI commands: check that the command entry points exist and are wired up
- For daemon features: check that IPC handlers are registered and route correctly
- Run `bun typecheck` to confirm the code compiles cleanly

Do NOT start the daemon or run live integration tests — focus on static verification and unit tests.

### Step 4: Check for Tests — and Write Missing Ones

Find test files (`*.spec.ts` or `*.test.ts`) that cover the described functionality. Assess:
- Do tests exist for the core behaviors described in the issue?
- Are the tests meaningful (not just smoke tests)?
- Is coverage reasonable for the described scope?

**If tests are missing for core functionality, write them.** QA is responsible for ensuring the feature is covered before the issue is closed. This includes:
- Unit tests for pure functions, parsers, and data transformations
- Database CRUD tests for any new tables or methods
- Tests for edge cases and error paths in the new code

Follow existing test patterns in the codebase (bun:test, `*.spec.ts` files colocated with source). If a function needs to be exported to make it testable, export it. Keep tests focused and meaningful — don't pad with trivial assertions.

### Step 5: Run Tests

```bash
bun test
```

Run the full test suite. All tests — including any you just wrote — must pass. If any fail, fix them before proceeding.

### Step 5b: Check CI Status

If working from a PR, check that CI checks are passing:

```bash
gh pr checks <pr-number>
```

- If CI is **failing**, investigate the failure logs with `gh run view <run-id> --log-failed`.
- Red CI means `qa:fail` — that outcome is fine and valued (see Step 6). Don't contort reality to reach `qa:pass`; an accurate `qa:fail` with specifics is more useful than a false pass.
- If the failure looks pre-existing (not caused by this PR), you can fix it in the PR if it's quick. Otherwise, capture the evidence and apply `qa:fail`.

### Step 6: Post Verification Comment and Apply Label

QA has two equally valid outcomes. Both are accurate reports; neither is a
failure of the QA role. An accurate `qa:fail` is as valuable as an accurate
`qa:pass` — a PR that doesn't meet its spec shouldn't merge, and catching
that is the whole point of QA. Bias toward the truth, not toward either
label.

**`qa:pass`** — PR implements the issue, tests cover it, suite is green,
CI is green.

**`qa:fail`** — PR is missing functionality, tests, or coverage the issue
requires; OR CI is red; OR something else blocks merge. This is about the
*PR's* readiness, not about the QA role. Treat it as routine feedback to
the implementation phase, not a negative verdict.

Post a comment to the PR, then apply the appropriate label:

```bash
gh pr comment <pr-number> --body "$(cat <<'EOF'
## QA Verification

**PR:** #<pr-number> — <title>
**Linked issue:** #<issue-number>

### Implementation Evidence
<bullet list of files and what they implement, with line references>

### Test Coverage
<bullet list of test files and what they verify — include any tests written during QA>

### Test Results
<pass/fail summary from bun test>

### CI Status
<pass/fail — link to the CI run>

### Remaining Work (non-blocking)
<any "remaining work" items from the issue — these are known TODOs, not blockers>

### Outcome
<one of:>
- **qa:pass** — All described functionality implemented and verified. Tests and CI green.
- **qa:fail** — <specific gap, missing behavior, red CI check, or uncovered path>. Action for implementation: <concrete next step>.
EOF
)"

# Then apply the label TRANSACTIONALLY — one --add and one --remove in the
# SAME command. Sprint 33's PR #1303 merged with both qa:pass AND qa:fail
# attached because a re-QA after repair only added the new label without
# removing the stale one. Always swap atomically:
gh pr edit <pr-number> --add-label qa:pass --remove-label qa:fail
# or
gh pr edit <pr-number> --add-label qa:fail --remove-label qa:pass
```

The `--remove-label` is a no-op if the opposite label isn't present, so the
swap form is always safe to run regardless of prior state.

**Do NOT merge the PR. Do NOT close the issue. Do NOT check out main.**
Those actions are the orchestrator's responsibility. The orchestrator sits
on `main` and owns branch movement; having QA move branches caused the
"main is already used by worktree" class of errors that plagued sprints 30–32.

End your session with the label you applied on its own line, plus the PR URL, so the orchestrator can grep and act:

```
qa:pass
PR: https://github.com/theshadow27/mcp-cli/pull/<pr-number>
```

or

```
qa:fail
PR: https://github.com/theshadow27/mcp-cli/pull/<pr-number>
Blockers: <one-line summary>
```

### Step 7: File Follow-Up Issues

For each "remaining work" item from the issue, create a new GitHub issue using `gh issue create`. Each follow-up should include:

- **Title**: concise, actionable description of the work item
- **Body**: Background (reference the parent issue), problem description, proposed behavior, and relevant file paths with line numbers discovered during QA
- **Labels**: carry over labels from the parent issue

This ensures no planned work is lost when the parent issue is closed.

## Issue discipline

**Claude is the user of this project.** mcx is built by Claude, for Claude. There are no human users filing bug reports. Every Claude — orchestrator, implementer, QA — is responsible for filing issues when problems are encountered.

**Every problem gets an issue.** If you notice something wrong, missing, or improvable during QA — file it with `gh issue create`. "Not a blocker" is not a reason to skip filing. Issues are how the team tracks work. Unfiled problems are invisible problems.

File issues for:
- Test gaps you notice but don't have time to fill
- Flaky tests (even if they pass on retry)
- Edge cases the implementation missed
- Performance concerns spotted during code review
- DX papercuts (confusing errors, missing flags, bad defaults)
- Bugs in adjacent code discovered while reading
- CI infrastructure issues

## Rules

- Be factual. Every claim needs a file path or test result as evidence.
- Don't skip steps. Even if the issue says "can be closed immediately", verify it.
- If something is genuinely broken or missing (not just "remaining work"), report **NOT READY** with findings. Do not attempt to close or merge.
- Keep the comment concise but complete enough to serve as an audit trail.
- Run typecheck AND tests — both must pass.
- **NEVER report READY FOR MERGE with failing CI.** This is a hard rule with zero exceptions. If CI fails and you can't fix it, report NOT READY.
- **NEVER label `qa:pass` while open PR comment threads remain unaddressed.** All four surfaces (PR body, inline file:line, review containers, linked issue) must be clean. See Step 5b for enumeration commands.
- **ALWAYS swap labels transactionally** — `gh pr edit <N> --add-label qa:pass --remove-label qa:fail` (or vice versa) in one command. Never `--add-label` without the matching `--remove-label`.
- **NEVER move git branches.** No `git checkout main`, no `gh pr checkout`, no `gh pr merge`, no `git checkout <branch>`. Your worktree is already on the correct branch. Branch movement is the orchestrator's job.
- Process ONE issue per invocation.
- File issues for every problem you encounter, even if unrelated to the current task.
