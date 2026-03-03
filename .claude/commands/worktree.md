# Worktree: Parallel Issue Orchestrator

Orchestrate implementation of one or more GitHub issues in parallel using worktree-isolated agents. Each issue gets its own git worktree, its own agent, and is independently implemented, tested, and verified.

## Input

One or more GitHub issue numbers or descriptions, space-separated. Parse from: $ARGUMENTS

Examples:
- `/worktree 14` — single issue
- `/worktree 14 15 16` — parallel batch
- `/worktree "add shell completions"` — free-text task

## Workflow

### Step 1: Gather Issues

For each issue number provided:

```bash
gh issue view <number> --json number,title,body,labels
```

For free-text descriptions, treat each as a standalone task.

Present a summary table to the user:

| # | Title | Labels | Approach |
|---|-------|--------|----------|
| 14 | Add shell completions | enhancement | feat |
| 15 | Daemon crashes on bad config | bug | fix |

Ask the user to confirm before proceeding. This is the last checkpoint — after confirmation, agents run autonomously.

### Step 2: Check Preconditions

```bash
git rev-parse --is-inside-work-tree
git branch --show-current
git status --short
```

- Must be in a git repo
- Warn if not on main branch (agents branch from HEAD)
- Warn if there are uncommitted changes — agents will branch from current HEAD, so uncommitted work won't be in their worktrees
- Verify `bun install` works (agents will need deps)

### Step 3: Implement in Parallel

For EACH issue, spawn an Agent with `isolation: "worktree"` running **in the background**. Each agent gets a detailed prompt that includes:

1. The full issue context (number, title, body, labels)
2. The complete `/implement` workflow instructions (inline — don't reference the command)
3. Project conventions from CLAUDE.md

Use the Agent tool like this for each issue (all launched in a single message for true parallelism):

```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  run_in_background: true,
  description: "Implement issue #<N>",
  prompt: "<detailed prompt with full issue context and implement workflow>"
)
```

The agent prompt for each issue should instruct:

1. **Explore** the codebase to understand the relevant area
2. **Plan** the implementation (which files to modify/create, design decisions)
3. **Implement** following project conventions (Bun, strict TypeScript, no `any`)
4. **Write tests** in `*.spec.ts` files using `bun:test`
5. **Verify** with `bun typecheck && bun lint && bun test`
6. **Commit** with conventional commit format referencing the issue (`fixes #N`)
7. **Push** to a new branch (`git push -u origin <branch>`)
8. **Create a PR** using `gh pr create` with a summary, test plan, and `Closes #N`

The agent should NOT ask for user input — it runs autonomously. If it hits ambiguity, it should make a reasonable choice and document it in the PR description.

### Step 4: Monitor Progress

As background agents complete, report their results to the user. For each completed agent:

- Whether it succeeded or failed
- The branch name and PR URL (if created)
- What was implemented
- What tests were added
- Any issues or concerns

If an agent fails, report the error and ask the user whether to retry or skip.

### Step 5: QA + Auto-Merge

Once implementation agents complete, spawn QA agents (also with `isolation: "worktree"`, also in background) for each successfully implemented issue. Each QA agent should:

1. Check out the implementation branch
2. Read the issue and verify the implementation matches
3. Run `bun typecheck && bun lint && bun test`
4. Review the code for correctness, edge cases, and project conventions
5. Write additional tests if coverage is insufficient — if so, commit, push, and wait for CI again
6. **Wait for CI to pass** on the PR: `gh pr checks <PR-number> --watch --fail-fast`
7. **If QA passes and CI is green**: squash-merge the PR with `gh pr merge <PR-number> --squash --auto --delete-branch`
8. **If QA fails or CI fails**: do NOT merge. Report the issues.

Again, launch all QA agents in parallel in a single message.

### Step 6: Final Report

Present a consolidated report:

```markdown
## Worktree Orchestration Complete

| Issue | Impl | QA | CI | Merged | PR |
|-------|------|----|----|--------|----|
| #14   | ✅   | ✅  | ✅  | ✅      | #23 |
| #15   | ✅   | ✅  | ✅  | ✅      | #24 |
| #16   | ❌   | —  | —  | —      | —  |

### Details
- **#14**: feat/shell-completions — 3 files changed, 2 test files, merged via squash
- **#15**: fix/daemon-config-crash — 1 file changed, QA added 1 edge case test, merged
- **#16**: Failed — ambiguous requirements, needs clarification
```

## Agent Prompt Template

When spawning implementation agents, use this structure for each prompt:

```
You are implementing GitHub issue #<N> for the mcp-cli project.

## Issue
Title: <title>
Labels: <labels>
Body:
<body>

## Project Context
- Bun monorepo: packages/core, packages/daemon, packages/command, packages/control
- Runtime: Bun — no Node.js compat shims
- Strict TypeScript, never use `any`
- Tests: `*.spec.ts` files, import from `bun:test`
- JSON output to stdout, errors/status to stderr
- Single prod dependency: @modelcontextprotocol/sdk
- Build: `bun build --compile` to dist/

## Your Task
1. Explore the codebase to understand the relevant area
2. Implement the issue following project conventions
3. Write tests covering core behavior and obvious edge cases
4. Run: bun typecheck && bun lint && bun test (all must pass)
5. Commit with conventional format: <type>(scope): description (fixes #<N>)
6. Push: git push -u origin <branch-name>
7. Create PR: gh pr create --title "<title>" --body "<summary + test plan + Closes #<N>>"

Work autonomously. Make reasonable choices when requirements are ambiguous
and document decisions in the PR description.
```

## QA Agent Prompt Template

When spawning QA agents, use this structure:

```
You are the QA reviewer for PR #<PR> (GitHub issue #<N>) in the mcp-cli project.

## Issue
Title: <title>
Body: <body>

## PR
Branch: <branch>
URL: <pr-url>

## Your Task
1. Check out the branch: git fetch origin <branch> && git checkout <branch>
2. Read the issue and PR description. Understand what was promised.
3. Read the changed files: gh pr diff <PR>
4. Verify the implementation matches the issue requirements
5. Run: bun typecheck && bun lint && bun test — all must pass
6. Review code for: correctness, edge cases, project conventions, missing tests
7. If tests are insufficient, write additional tests, commit, and push
8. Wait for CI: gh pr checks <PR> --watch --fail-fast
9. If everything passes: gh pr merge <PR> --squash --auto --delete-branch
10. If anything fails: do NOT merge. Report what's wrong.

Report back with: QA status, any additional tests written, CI result, merge status.
```

## Rules

- Always confirm the issue list with the user before spawning agents.
- Launch ALL implementation agents in a single message (true parallelism).
- Launch ALL QA agents in a single message after implementation completes.
- Each agent gets `isolation: "worktree"` — never let agents modify the main working tree.
- Agents run in background (`run_in_background: true`) so the orchestrator stays responsive.
- If only one issue is provided, still use worktree isolation — consistency matters.
- Never skip QA. Every implementation gets verified.
- QA is the merge gate. Only QA agents merge PRs, and only after CI passes.
- Report failures honestly — don't retry silently.
