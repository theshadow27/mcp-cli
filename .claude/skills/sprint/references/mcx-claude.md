# mcx claude — Session Management Reference

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

## Protocol Notes

`/clear` and `/model` are intercepted by the daemon and translated to native protocol actions:
- `/clear` → kills the claude process and respawns on the same session (fresh context)
- `/model <name>` → sends `set_model` control request over WebSocket (runtime model switch)

These work via `mcx claude send`. Other slash commands (like `/help`, `/compact`) are NOT intercepted and get sent as plain text — they won't work.

## Monitoring Signals

- **State**: `active` (working), `idle` (waiting for input), `waiting_permission` (needs approval), `ended`
- **Cost**: >$15 suggests struggle/complexity
- **Tokens**: stalled token count may indicate a stuck session

### Unsticking sessions
1. Check logs: `mcx claude log <id> --last 5`
2. Send a nudge: `mcx claude send <id> "continue"`
3. If truly stuck: `mcx claude interrupt <id>` then send new instructions

## Safe Cleanup

```bash
mcx claude bye <id>    # Ends session, auto-cleans worktree if clean
```

Before manually removing a worktree, check for uncommitted work:
```bash
git -C <worktree-path> status --porcelain
```
- Empty output: safe to `git worktree remove <path>`
- Has changes: investigate first — uncommitted work may be valuable

## Concurrency

- **Maximum recommended**: 5 concurrent sessions
- **Avoid conflicts**: don't run multiple sessions that modify the same files
- **Parallel for independent work**: different packages, different features
