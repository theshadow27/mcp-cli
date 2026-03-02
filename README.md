# mcp-cli

Call MCP server tools from the command line — zero context overhead.

`mcp-cli` gives you a fast CLI (`mcp`) and a background daemon (`mcpd`) for calling any [Model Context Protocol](https://modelcontextprotocol.io) server. It reads your existing Claude Code config (`~/.claude.json`, `.mcp.json`) so there's nothing to set up.

## Install

**Homebrew** (macOS/Linux):

```bash
brew install theshadow27/mcp-cli/mcp-cli
```

**curl** (macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/theshadow27/mcp-cli/main/scripts/install.sh | sh
```

**From source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/theshadow27/mcp-cli.git
cd mcp-cli
bun install
bun run build
# binaries in dist/
```

## Quick Start

```bash
mcp ls                                    # list configured servers
mcp ls atlassian                          # list tools on a server
mcp info atlassian getJiraIssue           # show tool schema
mcp grep confluence                       # search tools by name
mcp call atlassian search '{"query":"sprint planning"}'  # call a tool
```

## How It Works

```
mcp call server tool '{...}'
  │
  ├─► mcpd (daemon)         auto-starts on first call
  │     ├─► server-pool      manages persistent connections
  │     ├─► auth             OAuth + macOS Keychain integration
  │     └─► SQLite           caches tools, state, tokens
  │
  └─► stdout (JSON)          pipe to jq, scripts, etc.
```

The `mcp` CLI is a thin client that talks to `mcpd` over a Unix socket (`~/.mcp-cli/mcpd.sock`). The daemon manages server connections, authentication, and tool caching so every call after the first is fast.

## Configuration

Zero config needed — `mcp-cli` reads the same config files as Claude Code:

- `~/.claude.json` — user-level MCP servers
- `.mcp.json` — project-level MCP servers
- `~/.mcp-cli/servers.json` — standalone server config (optional)

## Claude Code Integration

Add `mcp-cli` as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) to reduce context window usage by ~12,000 tokens per MCP server. See [`skill/SKILL.md`](skill/SKILL.md) for setup.

## Commands

| Command | Description |
|---|---|
| `mcp ls` | List configured servers |
| `mcp ls <server>` | List tools for a server |
| `mcp call <server> <tool> [json]` | Call a tool (JSON from arg, `@file`, or stdin) |
| `mcp <server> <tool> [json]` | Shorthand for `call` |
| `mcp info <server> <tool>` | Show tool schema |
| `mcp grep <pattern>` | Search tools by name/description |
| `mcp auth <server>` | Authenticate with an OAuth server |
| `mcp config show` | Show resolved server config |
| `mcp status` | Daemon status |
| `mcp restart [server]` | Restart server connection(s) |
| `mcp shutdown` | Stop the daemon |
| `mcp --version` | Print version |

## License

[MIT](LICENSE)
