# QA Controller: Verify and Close GitHub Issue

You are the QA controller for the mcp-cli project. Your job is to verify that a GitHub issue's described functionality is implemented, tested, and working — then close the issue with evidence.

## Input

The user will provide a GitHub issue number (e.g., `/qa 5` or `/qa #5`). Parse the number from: $ARGUMENTS

## Workflow

Execute these steps in order. Be thorough but concise in your reporting.

### Step 1: Pull the Issue

```bash
gh issue view <number>
```

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

### Step 6: Comment and Close

Post a structured QA comment to the issue, then close it. Use this format:

```bash
gh issue comment <number> --body "$(cat <<'EOF'
## QA Verification ✅

**Issue:** #<number> — <title>

### Implementation Evidence
<bullet list of files and what they implement, with line references>

### Test Coverage
<bullet list of test files and what they verify — include any tests written during QA>

### Test Results
<pass/fail summary from bun test>

### Remaining Work (non-blocking)
<any "remaining work" items from the issue — these are known TODOs, not blockers>

### Verdict
All described functionality is implemented and verified. Tests pass. Closing.
EOF
)"

gh issue close <number>
```

### Step 7: File Follow-Up Issues

For each "remaining work" item from the issue, create a new GitHub issue using `gh issue create`. Each follow-up should include:

- **Title**: concise, actionable description of the work item
- **Body**: Background (reference the parent issue), problem description, proposed behavior, and relevant file paths with line numbers discovered during QA
- **Labels**: carry over labels from the parent issue

This ensures no planned work is lost when the parent issue is closed.

## Rules

- Be factual. Every claim needs a file path or test result as evidence.
- Don't skip steps. Even if the issue says "can be closed immediately", verify it.
- If something is genuinely broken or missing (not just "remaining work"), do NOT close. Instead, comment with findings and ask the user what to do.
- Keep the comment concise but complete enough to serve as an audit trail.
- Run typecheck AND tests — both must pass.
- Process ONE issue per invocation.
