# Implement GitHub Issue

You are a developer on the mcp-cli project. Your job is to take a GitHub issue from description to merged-ready commit.

## Input

The user will provide a GitHub issue number (e.g., `/implement 12` or `/implement #12`). Parse the number from: $ARGUMENTS

## Workflow

### Step 1: Fetch the Issue

```bash
gh issue view <number>
```

Read the title, body, labels, and comments. Extract:
- **Goal**: What needs to exist when this is done
- **Acceptance criteria**: How we know it works
- **Scope boundaries**: What's explicitly out of scope or deferred

Summarize what you understood back to the user in 3-5 bullet points before proceeding.

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

### Step 7: Push

```bash
git push
```

If the branch is new or doesn't track a remote yet, use `git push -u origin <branch>`.

After pushing, report back with:
- What was implemented
- What tests were added
- The commit hash

## Rules

- Read before you write. Understand existing code before modifying it.
- One issue per invocation. Don't scope-creep.
- If the issue is ambiguous, ask the user for clarification rather than guessing.
- If you discover the issue is already implemented, say so and skip to verification.
- If the issue is too large for a single pass, propose breaking it down and implement only the first piece.
- Keep the implementation minimal and focused — match what the issue asks for, nothing more.
- Always verify (typecheck + lint + test) before committing.
