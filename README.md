# mcp-cli

**MCP tools from the command line. Zero context overhead.**

MCP servers like Atlassian inject ~12,000 tokens into every Claude Code conversation — every message, every subagent. The `gh` CLI costs 0 tokens when unused.

`mcp-cli` gives you the same MCP tools via Bash: discoverable, pipeable, composable, and invisible until needed.

```bash
$ mcx atlassian search '{"query":"sprint planning"}' | jq '.results[].title'
"Q1 Sprint Planning"
"Sprint Planning Template"
"Sprint Planning Best Practices"

$ mcx coralogix-server get_datetime '{}'
2026-03-02T21:48:22.122294+00:00

$ mcx grep confluence
  getConfluencePage                atlassian  Get a Confluence page by page ID
  searchConfluenceUsingCql         atlassian  Search content with CQL
  createConfluencePage             atlassian  Create Confluence page
  ...
  14 tool(s)
```

## Install

**From source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/theshadow27/mcp-cli.git
cd mcp-cli
bun install
bun run build    # binaries in dist/
```

## Zero Config

`mcp-cli` reads your existing Claude Code configuration — `~/.claude.json` and `.mcp.json`. If Claude Code can see a server, so can `mcx`.

No extra setup. No duplicate config. Just works.

You can also add servers in `~/.mcp-cli/servers.json` for standalone use.

## How It Works

```
mcx call server tool '{...}'
  |
  +-> mcpd (daemon)         auto-starts on first call, stays alive 5min
  |     +-> server-pool      persistent connections (stdio, SSE, HTTP)
  |     +-> auth             OAuth/PKCE + macOS Keychain (reads Claude Code tokens)
  |     +-> SQLite           tool cache, usage stats, auth tokens
  |
  +-> stdout (JSON)          pipe to jq, scripts, other tools
```

The `mcx` CLI is a thin client. The `mcpd` daemon manages connections, auth, and caching over a Unix socket. First call cold-starts the daemon (~2s); every call after that is instant.

## Commands

### Discovery

```bash
mcx ls                              # list servers and their status
mcx ls <server>                     # list tools on a server
mcx info <server> <tool>            # show tool schema (TypeScript notation)
mcx grep <pattern>                  # search tools across all servers
mcx search <query>                  # search local tools, then registry
```

### Calling Tools

```bash
mcx call <server> <tool> [json]     # call a tool with inline JSON
mcx call <server> <tool> @file.json # load args from a file
echo '{"query":"test"}' | mcx call <server> <tool>  # pipe from stdin
mcx <server> <tool> [json]          # shorthand (skip "call")
mcx call <server> <tool> --jq '.field'  # apply jq filter to output
mcx call <server> <tool> --full     # bypass output size protection
```

### Server Management

```bash
mcx add --transport stdio <name> -- <cmd> [args]  # add stdio server
mcx add --transport http <name> <url>              # add HTTP server
mcx add --transport http <name> <url> \
  --client-id ID --client-secret SECRET            # add with OAuth
mcx add-json <name> '{"type":"http","url":"..."}'  # add from raw JSON
mcx remove <name>                   # remove a server
mcx get <name>                      # inspect server config and status
```

Options for `add`: `--env KEY=VALUE` (repeatable), `--header "Name: Value"` (HTTP/SSE), `--scope {user|project}`, `--callback-port PORT`.

### Auth & Management

```bash
mcx auth <server>                   # trigger OAuth flow (opens browser)
mcx config show                     # show resolved config + sources
mcx config sources                  # list config file locations
mcx config get <key>                # get CLI option or server config
mcx config set <key> <value>        # set CLI option or server env var
mcx status                          # daemon PID, uptime, server states
mcx restart [server]                # reconnect server(s)
mcx daemon restart                  # restart daemon (kills sessions)
mcx daemon shutdown                 # stop the daemon
mcx logs <server> [-f]              # view server stderr output
mcx logs --daemon [-f]              # view daemon log file
```

### Registry

```bash
mcx install <slug>                  # install server from MCP registry
mcx install <slug> --as <name>      # install with custom name
mcx install <slug> --env KEY=VALUE  # install with env vars
mcx registry search <query>         # search registry
mcx registry list                   # list all registry servers
```

### Import / Export

```bash
mcx import                          # auto-find .mcp.json in parent dirs
mcx import /path/to/config.json     # import from specific file
mcx import --claude                 # import from Claude Code config
mcx import --claude --all           # import all Claude Code projects
mcx export                          # export to stdout
mcx export .mcp.json                # export to file
mcx export --server <name>          # export specific server(s)
```

### Claude Sessions

Spawn and manage headless Claude Code sessions:

```bash
mcx claude spawn --task "describe the work"   # start a session (non-blocking)
mcx claude spawn -w --task "work in isolation" # start in a git worktree
mcx claude ls                                  # list active sessions
mcx claude send <session> <message>            # send follow-up prompt
mcx claude wait [session]                      # block until session event
mcx claude log <session> [--last N]            # view session transcript
mcx claude interrupt <session>                 # interrupt current turn
mcx claude bye <session>                       # end session (cleans up worktree)
```

Session IDs support prefix matching (like git SHAs). Use `--wait` on `spawn` or `send` to block until Claude produces a result. Use `--json` on `ls` or `log` for machine-readable output.

### Aliases

Save multi-step workflows as TypeScript scripts:

```bash
mcx alias save sprint-board - <<'TS'
const issues = await mcp.atlassian.searchJiraIssuesUsingJql({
  cloudId: "abc-123",
  jql: "sprint in openSprints() AND assignee = currentUser()",
  fields: ["summary", "status", "priority"]
});
for (const issue of issues.issues) {
  console.log(`${issue.key} [${issue.fields.status.name}] ${issue.fields.summary}`);
}
TS

mcx run sprint-board
# or just: mcx sprint-board
```

```bash
mcx alias ls                        # list saved aliases
mcx alias save <name> <@file | ->   # save a script
mcx alias show <name>               # print source
mcx alias edit <name>               # open in $EDITOR
mcx alias rm <name>                 # delete
mcx run <alias> [--key value ...]   # run with arguments
```

Alias scripts get a virtual `mcp-cli` module with:
- `mcp` — proxy object: `mcp.<server>.<tool>(args)` calls tools through the daemon
- `args` — parsed `--key value` pairs from the CLI
- `file(path)` — read a file as string
- `json(path)` — read and parse a JSON file

### Mail

Inter-session messaging for coordinating between Claude sessions:

```bash
echo "body" | mcx mail -s "subject" <recipient>  # send a message
mcx mail -H                         # list message headers
mcx mail -H -u <user>               # list messages for a user
mcx mail --wait --for=<recipient>    # block until message arrives
```

### Terminal

```bash
mcx tty open "<command>"             # run command in new terminal tab
mcx tty open --window "<command>"    # run in new window
mcx tty open --headless "<command>"  # run as background process
mcx config set terminal <name>       # set preferred terminal
```

Supports: iTerm, Kitty, tmux, WezTerm, Ghostty, Terminal.app. Auto-detects from `$TERM_PROGRAM`.

### Utilities

```bash
mcx serve                           # run mcx as stdio MCP server
mcx typegen                         # generate TypeScript types for aliases
mcx completions {bash|zsh|fish}     # generate shell completions
```

`mcx serve` exposes tools as an MCP server for use in `.mcp.json`. Set `MCP_TOOLS="server/tool,alias"` to curate which tools are exposed.

### TUI

```bash
mcpctl                              # interactive dashboard
# or: bun run packages/control/src/index.tsx
```

Tab bar with 5 views — navigate with Tab/Shift+Tab or press 1-5 to jump directly:

1. **Servers** — server list, tool counts, connection states, restarts
2. **Logs** — daemon and per-server log viewer
3. **Claude** — Claude Code session list with transcript viewing
4. **Mail** — message system (coming soon)
5. **Stats** — usage statistics (coming soon)

## Claude Code Integration

Add `mcp-cli` as a Claude Code skill to eliminate context bloat. Instead of injecting 31 Atlassian tool definitions (~12K tokens) into every conversation, Claude calls tools via `mcx` on demand — 0 tokens at rest.

See [`skill/SKILL.md`](skill/SKILL.md) for the skill definition.

## Architecture

```
packages/
  core/      Shared types, IPC protocol, config types, env expansion
  daemon/    mcpd — background daemon, server pool, auth, SQLite
  command/   mcx — CLI entry point, output formatting, alias runner
  control/   mcpctl — React/Ink TUI dashboard
```

- **Runtime:** [Bun](https://bun.sh) (build, test, compile, SQLite)
- **Single prod dep:** `@modelcontextprotocol/sdk`
- **Transports:** stdio, SSE, Streamable HTTP
- **State:** `~/.mcp-cli/` — SQLite db, aliases, PID file, Unix socket

## Development

```bash
bun install                  # install deps
bun test                     # run tests
bun typecheck                # TypeScript validation
bun lint                     # biome lint + format
bun run build                # compile binaries to dist/

bun dev:daemon               # run daemon directly
bun dev:mcx -- ls            # run CLI directly
```

## License

[MIT](LICENSE)

## Disclaimer

This project was developed entirely by Claude Code, without any sort of IDE.
