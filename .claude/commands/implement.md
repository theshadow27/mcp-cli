# Implement GitHub Issue

You are a developer on the mcp-cli project. Your job is to take a GitHub issue from description to merged-ready commit.

## Input

The user will provide a GitHub issue number (e.g., `/implement 12` or `/implement #12`). Parse the number from: $ARGUMENTS

## Workflow

### Step 0: Prepare Branch

Start from a clean, up-to-date main:

```bash
git checkout main
git pull origin main
```

Create a feature branch named after the issue:

```bash
git checkout -b feat/issue-<number>-<short-slug>
```

Use a prefix that matches the expected commit type (`feat/`, `fix/`, `refactor/`, etc.).

### Step 1: Fetch the Issue

```bash
gh issue view <number>
```

Read the title, body, labels, and comments. Extract:
- **Goal**: What needs to exist when this is done
- **Acceptance criteria**: How we know it works
- **Scope boundaries**: What's explicitly out of scope or deferred

Summarize what you understood back to the user in 3-5 bullet points before proceeding.

### Step 1a: Read sprint plan context

If a sprint is active, the issue may have plan-level scope decisions that
override or narrow the issue body — typically captured in the sprint plan's
"Pre-session clarifications required" section, "Hot-shared file watch", or
the Excluded list. **The issue body alone is not authoritative when a
sprint plan exists** (sprint-45 issue #1775 shipped the wrong design
because the worker never read its plan entry, see #1801).

```bash
# Find the latest sprint plan
SPRINT_PLAN=$(ls .claude/sprints/sprint-*.md 2>/dev/null | sort -t- -k2 -n | tail -1)

if [ -n "$SPRINT_PLAN" ]; then
  echo "Reading sprint plan: $SPRINT_PLAN"
  # Look for the issue across all relevant sections
  grep -B1 -A3 "#<number>" "$SPRINT_PLAN" || echo "(no entries for #<number> in sprint plan)"
fi
```

Manually verify these specific sections of the plan reference the issue:

1. **Issues table row** — model assignment, scrutiny level, batch
2. **Pre-session clarifications required** — explicit scope narrowing or
   forbidden approaches. **If this section names the issue, the
   instructions there override anything in the issue body that conflicts.**
3. **Hot-shared file watch** — files this issue touches that other in-flight
   picks also touch; rebase awareness
4. **Batch Plan / Dependency edges** — if this issue blockedBy another, the
   blocker should already be merged before you start
5. **Excluded (with reasons)** — if your issue number appears here, **stop
   and report**: the orchestrator should not have spawned this — exit
   without writing code, surface the conflict so the orchestrator can
   resolve.

Summarize the relevant plan context (if any) alongside the issue summary
in your "what I understood" report. Examples of what to call out:

- "Plan says: implement option 2-variant only (no env var, no CLI flag)"
- "Plan says: hot-shared file with #NNNN — rebase before push"
- "Plan does not list this issue — proceeding from issue body alone"

### Step 2: Plan the Work

Explore the codebase to understand the relevant areas. Use Glob, Grep, and Read to find:
- Existing code that relates to the issue
- Patterns and conventions used in similar features
- Test patterns in nearby `*.spec.ts` files

Write a short implementation plan:
- Which files to modify or create
- Key design decisions and why
- What tests to write

Present the plan and wait for user approval before writing code. Use EnterPlanMode if the changes touch 3+ files or involve architectural decisions.

### Step 3: Implement

Write the code following project conventions:
- Bun runtime, strict TypeScript, no `any`
- Keep it simple — no over-engineering
- Follow existing patterns in the codebase
- Errors/status to stderr, JSON output to stdout (for CLI commands)

### Step 4: Write Tests

Add or update `*.spec.ts` files covering:
- The core behavior described in the issue
- Edge cases that are obvious from the implementation
- Follow existing test patterns (import from `bun:test`)

Don't aim for 100% coverage — aim for confidence that the feature works.

### Step 5: Verify

Run all three checks. All must pass before committing:

```bash
bun typecheck
bun lint
bun test
```

If anything fails, fix it and re-run. If lint issues are auto-fixable, run `bun lint --fix`.

### Step 6: Commit

Stage the relevant files and create a commit. Follow the repo's commit style (look at recent `git log --oneline` output). The commit message should:
- Use conventional commit format (e.g., `feat:`, `fix:`, `refactor:`)
- Reference the issue number (e.g., `fixes #12` or `closes #12`)
- Be concise but descriptive

### Step 7: Push and Create PR

```bash
git push -u origin <branch>
```

Then create a pull request targeting main:

```bash
gh pr create --title "<conventional commit style title> (fixes #<number>)" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points describing the changes>

## Test plan
<bulleted checklist of how the changes were verified>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After pushing, report back with:
- What was implemented
- What tests were added
- The PR URL

## Issue discipline

**Claude is the user of this project.** mcx is built by Claude, for Claude. There are no human users filing bug reports. Every Claude — orchestrator, implementer, QA — is responsible for filing issues when problems are encountered.

**Every problem gets an issue.** If you notice something wrong, missing, or improvable — file it with `gh issue create`. "Not a blocker" is not a reason to skip filing. Issues are how the team tracks work. Unfiled problems are invisible problems.

File issues for:
- A flag or command you tried that didn't work or isn't supported
- Flaky tests (even if they pass on retry)
- Edge cases you notice but that are out of scope for the current issue
- DX papercuts (confusing errors, missing flags, bad defaults)
- Bugs in adjacent code discovered while reading
- Missing documentation or misleading help text

## Rules

- Read before you write. Understand existing code before modifying it.
- One issue per invocation. Don't scope-creep.
- If the issue is ambiguous, ask the user for clarification rather than guessing.
- If you discover the issue is already implemented, say so and skip to verification.
- If the issue is too large for a single pass, propose breaking it down and implement only the first piece.
- Keep the implementation minimal and focused — match what the issue asks for, nothing more.
- Always verify (typecheck + lint + test) before committing.
- File issues for every problem you encounter, even if unrelated to the current task.
