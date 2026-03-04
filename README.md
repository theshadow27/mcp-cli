# mcp-cli

**MCP tools from the command line. Zero context overhead.**

MCP servers like Atlassian inject ~12,000 tokens into every Claude Code conversation — every message, every subagent. The `gh` CLI costs 0 tokens when unused.

`mcp-cli` gives you the same MCP tools via Bash: discoverable, pipeable, composable, and invisible until needed.

```bash
$ mcp atlassian search '{"query":"sprint planning"}' | jq '.results[].title'
"Q1 Sprint Planning"
"Sprint Planning Template"
"Sprint Planning Best Practices"

$ mcp coralogix-server get_datetime '{}'
2026-03-02T21:48:22.122294+00:00

$ mcp grep confluence
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

`mcp-cli` reads your existing Claude Code configuration — `~/.claude.json` and `.mcp.json`. If Claude Code can see a server, so can `mcp`.

No extra setup. No duplicate config. Just works.

You can also add servers in `~/.mcp-cli/servers.json` for standalone use.

## How It Works

```
mcp call server tool '{...}'
  |
  +-> mcpd (daemon)         auto-starts on first call, stays alive 5min
  |     +-> server-pool      persistent connections (stdio, SSE, HTTP)
  |     +-> auth             OAuth/PKCE + macOS Keychain (reads Claude Code tokens)
  |     +-> SQLite           tool cache, usage stats, auth tokens
  |
  +-> stdout (JSON)          pipe to jq, scripts, other tools
```

The `mcp` CLI is a thin client. The `mcpd` daemon manages connections, auth, and caching over a Unix socket. First call cold-starts the daemon (~2s); every call after that is instant.

## Commands

### Discovery

```bash
mcp ls                              # list servers and their status
mcp ls <server>                     # list tools on a server
mcp info <server> <tool>            # show tool schema (TypeScript notation)
mcp grep <pattern>                  # search tools across all servers
```

### Calling Tools

```bash
mcp call <server> <tool> [json]     # call a tool with inline JSON
mcp call <server> <tool> @file.json # load args from a file
echo '{"query":"test"}' | mcp call <server> <tool>  # pipe from stdin
mcp <server> <tool> [json]          # shorthand (skip "call")
```

### Auth & Management

```bash
mcp auth <server>                   # trigger OAuth flow (opens browser)
mcp config show                     # show resolved config + sources
mcp config sources                  # list config file locations
mcp status                          # daemon PID, uptime, server states
mcp restart [server]                # reconnect server(s)
mcp shutdown                        # stop the daemon
mcp logs <server> [-f]              # view server stderr output
```

### Aliases

Save multi-step workflows as TypeScript scripts:

```bash
mcp alias save sprint-board - <<'TS'
const issues = await mcp.atlassian.searchJiraIssuesUsingJql({
  cloudId: "abc-123",
  jql: "sprint in openSprints() AND assignee = currentUser()",
  fields: ["summary", "status", "priority"]
});
for (const issue of issues.issues) {
  console.log(`${issue.key} [${issue.fields.status.name}] ${issue.fields.summary}`);
}
TS

mcp run sprint-board
# or just: mcp sprint-board
```

```bash
mcp alias ls                        # list saved aliases
mcp alias save <name> <@file | ->   # save a script
mcp alias show <name>               # print source
mcp alias edit <name>               # open in $EDITOR
mcp alias rm <name>                 # delete
mcp run <alias> [--key value ...]   # run with arguments
```

Alias scripts get a virtual `mcp-cli` module with:
- `mcp` — proxy object: `mcp.<server>.<tool>(args)` calls tools through the daemon
- `args` — parsed `--key value` pairs from the CLI
- `file(path)` — read a file as string
- `json(path)` — read and parse a JSON file

### TUI

```bash
mcpctl                              # interactive dashboard
# or: bun run packages/control/src/index.tsx
```

Navigate servers, view tool counts, trigger restarts, see connection states.

## Claude Code Integration

Add `mcp-cli` as a Claude Code skill to eliminate context bloat. Instead of injecting 31 Atlassian tool definitions (~12K tokens) into every conversation, Claude calls tools via Bash on demand — 0 tokens at rest.

See [`skill/SKILL.md`](skill/SKILL.md) for the skill definition.

## Architecture

```
packages/
  core/      Shared types, IPC protocol, config types, env expansion
  daemon/    mcpd — background daemon, server pool, auth, SQLite
  command/   mcp — CLI entry point, output formatting, alias runner
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
bun dev:mcp -- ls            # run CLI directly
```

## License

[MIT](LICENSE)

## Disclaimer

This project was developed entirely by Claude Code, without any sort of IDE.
