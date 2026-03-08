---
name: manage
description: Use when you need to spawn, monitor, communicate with, or clean up Claude sessions — for any purpose (implementation, debugging, devops, review, etc).
---

# Managing Claude Sessions with mcx

Guide for working effectively with other Claude instances through the mcx CLI.

## Core Commands

```bash
mcx claude spawn --worktree -t "task description" --allow Read Glob Grep Write Edit Bash
mcx claude spawn --model sonnet -t "simple task" --allow Read Glob Grep Bash
mcx claude ls                        # List all sessions with state, model, cost, tokens
mcx claude send <id> "message"       # Send follow-up prompt
mcx claude send <id> "/clear"        # Clear context (essential between phases)
mcx claude log <id>                  # View session transcript
mcx claude log <id> --full           # Full output (no truncation)
mcx claude bye <id>                  # End session + clean up
mcx claude interrupt <id>            # Interrupt current turn
mcx claude wait [id]                 # Block until next event
```

Session IDs support prefix matching (like git SHAs) — `mcx claude send a3f "msg"` works.

## Model Selection

Use `--model` on spawn to pick the right model for the task:

- **opus** (default): complex implementations, deep refactoring, simplify passes
- **sonnet**: QA, documentation, simple bug fixes, routine tasks
- **haiku**: trivial tasks

To switch models mid-session, send `/model sonnet` or `/model opus`.

## Spawning Best Practices

### Always use worktrees for code changes
```bash
mcx claude spawn --worktree -t "task" --allow Read Glob Grep Write Edit Bash
```
Worktrees give each session an isolated copy of the repo — no merge conflicts between concurrent sessions.

### Scope permissions tightly
- Read-only tasks: `--allow Read Glob Grep`
- Code changes: `--allow Read Glob Grep Write Edit Bash`
- Full access is rarely needed and increases risk

### Use slash commands for structured work
```bash
mcx claude spawn --worktree -t "/implement 123" --allow Read Glob Grep Write Edit Bash
mcx claude send <id> "/simplify"
mcx claude send <id> "/qa 123 (PR #456, already checked out)"
```

## Monitoring

Poll with `mcx claude ls` at ~30 second intervals. Key signals:

- **State**: `active` (working), `idle` (waiting for input), `waiting_permission` (needs approval), `ended`
- **Cost**: watch for runaway sessions (>$15 suggests struggle/complexity)
- **Tokens**: stalled token count may indicate a stuck session

### Unsticking sessions
If a session appears stuck (tokens not advancing, state active for too long):
1. Check logs: `mcx claude log <id> --last 5`
2. Send a nudge: `mcx claude send <id> "continue"`
3. If truly stuck: `mcx claude interrupt <id>` then send new instructions

## Communication Patterns

### Clear context between phases
Always send `/clear` before switching a session to a new task. This prevents context bloat and confusion.

```bash
mcx claude send <id> "/clear"
mcx claude send <id> "new task description"
```

### Provide context in messages
Sessions don't share context. When sending follow-ups, include relevant info:
```bash
mcx claude send <id> "/qa 123 (PR #456, already checked out)"  # Include PR number
mcx claude send <id> "The tests in server-pool.spec.ts are failing with ECONNREFUSED — investigate and fix"
```

## Cleanup

### Safe worktree cleanup
Before removing a worktree, check for uncommitted work:
```bash
git -C <worktree-path> status --porcelain
```

- Empty output: safe to remove with `git worktree remove <path>`
- Has changes: investigate before removing — uncommitted work may be valuable

### Session cleanup
```bash
mcx claude bye <id>    # Ends session, auto-cleans worktree if clean
```

`bye` automatically checks for uncommitted changes and warns if the worktree is dirty.

## Concurrency

- **Maximum recommended**: 4-6 opus sessions, more for sonnet (different rate limits)
- **Avoid conflicts**: don't run multiple sessions that modify the same files
- **Sequential for shared files**: README changes, config changes, etc. must run one at a time
- **Parallel for independent work**: different packages, different features, different file sets

## Anti-Patterns

- **Don't implement directly** when orchestrating — always delegate to spawned sessions. Direct implementation eats the orchestrator's context window.
- **Don't tight-loop polls** — 30 second intervals are sufficient. Shorter wastes context.
- **Don't skip `/clear`** between phases — context accumulation degrades quality.
- **Don't force-remove worktrees** — always check for uncommitted changes first.
- **Don't ignore stuck sessions** — investigate and either nudge or restart them.
