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

- **State**: `active` (working), `idle` (waiting for input), `waiting_permission` (needs approval), `disconnected` (see below), `ended`
- **Cost**: >$15 suggests struggle/complexity
- **Tokens**: stalled token count may indicate a stuck session
- **Tokens past `session:result`**: a session that keeps producing output after emitting its final `session:result` is leaking — see `disconnected` below

### `disconnected` (#1426 — undocumented in daemon)

A session shown as `disconnected` in `mcx claude ls` may continue
generating tokens silently. Sprint 35 saw a sonnet QA session reach
**111,962 output tokens** (~5x cost overrun) before being noticed.
Treat any `disconnected` session as an immediate `bye` candidate unless
you are actively investigating it. Don't wait for the next `mcx claude
wait` event — it may never arrive.

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

## ACP Provider Routing

When a sprint issue specifies a `Provider` column, swap `mcx claude` for the
provider-specific command. All subcommands (spawn, ls, send, bye, wait, etc.)
work identically across providers.

| Provider | Command prefix | Notes |
|----------|---------------|-------|
| `claude` (default) | `mcx claude` | Standard Claude Code sessions |
| `copilot` | `mcx copilot` | GitHub Copilot via ACP |
| `gemini` | `mcx gemini` | Google Gemini via ACP |
| `acp:<agent>` | `mcx acp --agent <agent>` | Any custom ACP agent |

```bash
# Claude (default)
mcx claude spawn --worktree -t "task" --allow Read Glob Grep Write Edit Bash

# Copilot
mcx copilot spawn --worktree -t "task" --allow Read Glob Grep Write Edit Bash

# Gemini
mcx gemini spawn --worktree -t "task" --allow Read Glob Grep Write Edit Bash

# Custom ACP agent
mcx acp spawn --agent my-agent --worktree -t "task" --allow Read Glob Grep Write Edit Bash
```

Session management commands (ls, send, bye, wait, log, interrupt) use the same
provider prefix. E.g., `mcx copilot bye <id>`, `mcx gemini wait --timeout 30000`.

## Session Scoping

Sessions are scoped to a repository. `mcx claude ls` (and `mcx claude wait`) filter
to the current repo by default — you only see sessions that were spawned from within
the same project. Use `--all` to bypass the filter and see every session across all repos.

### How scoping works

When a session is spawned, the daemon records its `repoRoot` (the git root of the
spawn directory). When listing or waiting, the CLI sends the current repo's root as a
filter — the daemon returns only sessions whose `repoRoot` matches.

**Precedence: registered scope > git repo detection**

If you've run `mcx scope init` in a project directory, the registered scope root takes
precedence over git root detection. This matters when the git root is higher than your
project root (e.g., a monorepo where you scope to a subdirectory).

```bash
# Register the current directory as a named scope
mcx scope init                    # uses directory name as scope name
mcx scope init my-project         # explicit name

# List registered scopes
mcx scope ls

# Remove a scope
mcx scope rm my-project
```

Scopes are stored as JSON files in `~/.mcp-cli/scopes/`. The most specific match
(longest root prefix) wins when multiple scopes could match.

### Multi-repo sprint isolation

When running concurrent sprints in different repos, each sprint's orchestrator only
sees its own sessions by default:

```bash
# In repo A — sees only repo A sessions
cd /path/to/repo-a
mcx claude ls

# In repo B — sees only repo B sessions
cd /path/to/repo-b
mcx claude ls

# See all sessions across all repos
mcx claude ls --all
```

**Critical:** Sprint orchestrator commands (`mcx claude ls`, `mcx claude wait`, etc.)
must be run from within the project root. If run from the wrong directory, the filter
will not match your sessions — they'll appear to be missing when they're actually running.

### Diagnosing "missing" sessions

If `mcx claude ls` shows no sessions but you know sessions should be running:

1. Check `mcx claude ls --all` — if sessions appear, you're in the wrong directory
2. Verify your current directory is at or inside the project root
3. Check if a registered scope is expected: `mcx scope ls`
4. If the git root is wrong (e.g., bare repo or unusual config), register a scope
   explicitly with `mcx scope init`

## Concurrency

- **Maximum recommended**: 5 concurrent sessions
- **Avoid conflicts**: don't run multiple sessions that modify the same files
- **Parallel for independent work**: different packages, different features
